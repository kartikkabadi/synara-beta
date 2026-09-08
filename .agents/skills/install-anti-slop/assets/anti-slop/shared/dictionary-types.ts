import type { ESTree } from "@oxlint/plugins";

import {
  createScopeIndex,
  type Scope,
  type ScopeIndex,
  type VisitorKeys,
} from "./resolves-to-unknown.ts";

const BUILT_INS = new Set([
  "Record",
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "PropertyKey",
  "NonNullable",
]);
const TRANSPARENT_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);

export type TypeAliasEnvironment = ReadonlyMap<string, ResolvedSubstitution>;

type ResolvedSubstitution = {
  readonly type: ESTree.TSType;
  readonly scope: Scope | null;
  readonly substitutions: TypeAliasEnvironment;
};

type ResolvedType = {
  readonly type: ESTree.TSType;
  readonly substitutions: TypeAliasEnvironment;
};

export type UnsafeDictionary = {
  readonly kind: "unsafe-dictionary";
  readonly unsafeValue: "any" | "empty-object" | "object" | "union" | "unknown";
};

export type WideningTargetKind =
  | "anonymous object"
  | "generic container"
  | "object"
  | "open dictionary"
  | "unknown";

export type WideningTarget = {
  readonly kind: WideningTargetKind;
};

export type TypeEnvironment = {
  readonly scopeIndex: ScopeIndex | null;
  readonly scopeOf: (node: ESTree.Node) => Scope | null;
  readonly shadowedBuiltIns: ReadonlySet<string>;
};

type MutableEnvironment = {
  scopeIndex: ScopeIndex | null;
  visitorKeys: VisitorKeys | null;
};

function isBuiltInName(name: string): boolean {
  return BUILT_INS.has(name);
}

function collectShadowedBuiltIns(program: ESTree.Program): Set<string> {
  const shadowed = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        if (isBuiltInName(specifier.local.name)) shadowed.add(specifier.local.name);
      }
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (
      declaration !== null &&
      declaration !== undefined &&
      declaration.type !== "FunctionDeclaration" &&
      "id" in declaration &&
      declaration.id !== null &&
      declaration.id !== undefined &&
      declaration.id.type === "Identifier" &&
      isBuiltInName(declaration.id.name)
    ) {
      shadowed.add(declaration.id.name);
    }
  }
  return shadowed;
}

export function createTypeEnvironment(
  program: ESTree.Program,
  visitorKeys: VisitorKeys | null = null,
): TypeEnvironment {
  const environment: MutableEnvironment = {
    scopeIndex: visitorKeys !== null ? createScopeIndex(program, visitorKeys) : null,
    visitorKeys,
  };
  return {
    scopeIndex: environment.scopeIndex,
    scopeOf: (node) => environment.scopeIndex?.scopeOf(node) ?? null,
    shadowedBuiltIns: collectShadowedBuiltIns(program),
  };
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isBuiltIn(name: string, environment: TypeEnvironment, scope: Scope | null): boolean {
  if (!BUILT_INS.has(name)) return false;
  if (environment.shadowedBuiltIns.has(name)) return false;
  const alias = environment.scopeIndex?.lookupAlias(name, scope);
  if (alias !== null && alias !== undefined) return false;
  const interfaces = environment.scopeIndex?.lookupInterface(name, scope);
  return interfaces === null || interfaces === undefined || interfaces.length === 0;
}

function isUnappliedReferenceTo(type: ESTree.TSType, name: string): boolean {
  const unwrapped = unwrapTransparentType(type);
  return (
    unwrapped.type === "TSTypeReference" &&
    typeReferenceName(unwrapped) === name &&
    (unwrapped.typeArguments === null ||
      unwrapped.typeArguments === undefined ||
      unwrapped.typeArguments.params.length === 0)
  );
}

function unwrapTransparentType(type: ESTree.TSType): ESTree.TSType {
  let current = type;
  while (
    current.type === "TSParenthesizedType" ||
    (current.type === "TSTypeOperator" && current.operator === "readonly")
  ) {
    current = current.typeAnnotation;
  }
  return current;
}

function isNeverType(type: ESTree.TSType): boolean {
  return unwrapTransparentType(type).type === "TSNeverKeyword";
}

function isEffectivelyEmptyMember(member: ESTree.TSSignature): boolean {
  return (
    member.type === "TSPropertySignature" &&
    member.optional === true &&
    member.typeAnnotation !== null &&
    member.typeAnnotation !== undefined &&
    isNeverType(member.typeAnnotation.typeAnnotation)
  );
}

function isEffectivelyEmptyTypeLiteral(type: ESTree.TSTypeLiteral): boolean {
  return type.members.length === 0 || type.members.every(isEffectivelyEmptyMember);
}

function isEffectivelyEmptyInterface(
  declarations: readonly ESTree.TSInterfaceDeclaration[],
): boolean {
  if (declarations.length !== 1) return false;
  const [type] = declarations;
  return (
    type !== undefined &&
    type.extends.length === 0 &&
    (type.body.body.length === 0 || type.body.body.every(isEffectivelyEmptyMember))
  );
}

function resolvedSubstitutionArgument(
  type: ESTree.TSType,
  base: TypeAliasEnvironment,
  argumentScope: Scope | null,
  local: TypeAliasEnvironment | null = null,
): ResolvedSubstitution {
  const unwrapped = unwrapTransparentType(type);
  const substitutions = local ?? base;
  if (unwrapped.type !== "TSTypeReference") {
    return { type, scope: argumentScope, substitutions };
  }
  const name = typeReferenceName(unwrapped);
  if (name === null) {
    return { type, scope: argumentScope, substitutions };
  }
  // Resolve one level through the caller's own substitutions so nested
  // generic arguments keep their original scope. Defaults that reference an
  // earlier parameter are resolved in the alias declaration scope.
  const direct = base.get(name) ?? local?.get(name);
  if (direct !== undefined) {
    return direct;
  }
  return { type, scope: argumentScope, substitutions };
}

function substitutionEnvironment(
  parameters: readonly ESTree.TSTypeParameter[] | undefined,
  typeArguments: readonly ESTree.TSType[] | undefined,
  base: TypeAliasEnvironment,
  useSiteScope: Scope | null,
  declarationScope: Scope | null,
): TypeAliasEnvironment | null {
  const arguments_ = typeArguments ?? [];
  const next = new Map(base);
  for (const [index, parameter] of (parameters ?? []).entries()) {
    const argument = arguments_[index] ?? parameter.default;
    if (argument === null || argument === undefined) return null;
    const isDefault = arguments_[index] === undefined;
    const argumentScope = isDefault ? declarationScope : useSiteScope;
    next.set(
      parameter.name.name,
      resolvedSubstitutionArgument(argument, base, argumentScope, isDefault ? next : null),
    );
  }
  return next;
}

function aliasSubstitution(
  alias: ESTree.TSTypeAliasDeclaration,
  type: ESTree.TSTypeReference,
  base: TypeAliasEnvironment,
  useSiteScope: Scope | null,
  environment: TypeEnvironment,
): TypeAliasEnvironment | null {
  const declarationScope = environment.scopeOf(alias) ?? null;
  return substitutionEnvironment(
    alias.typeParameters?.params,
    type.typeArguments?.params,
    base,
    useSiteScope,
    declarationScope,
  );
}

function findAlias(
  name: string,
  environment: TypeEnvironment,
  scope: Scope | null,
): { alias: ESTree.TSTypeAliasDeclaration; ambiguous: boolean } | null {
  return environment.scopeIndex?.lookupAlias(name, scope) ?? null;
}

function findInterface(
  name: string,
  environment: TypeEnvironment,
  scope: Scope | null,
): readonly ESTree.TSInterfaceDeclaration[] | null {
  return environment.scopeIndex?.lookupInterface(name, scope) ?? null;
}

function collectInterfaceIndexSignatures(
  declaration: ESTree.TSInterfaceDeclaration,
  name: string,
  interfaceSubstitutions: TypeAliasEnvironment,
  environment: TypeEnvironment,
  resolvingAliases: ReadonlySet<string>,
  resolvingInterfaces: ReadonlySet<string>,
): ResolvedType[] {
  if (resolvingInterfaces.has(name)) return [];
  const nextResolvingInterfaces = new Set([...resolvingInterfaces, name]);
  const declarationScope = environment.scopeOf(declaration);

  const results: ResolvedType[] = [];
  for (const member of declaration.body.body) {
    if (member.type === "TSIndexSignature" && member.typeAnnotation !== null) {
      results.push({
        type: member.typeAnnotation.typeAnnotation,
        substitutions: interfaceSubstitutions,
      });
    }
  }

  for (const extend of declaration.extends) {
    const extendName =
      extend.expression.type === "Identifier"
        ? (extend.expression as ESTree.IdentifierReference).name
        : null;
    if (extendName === null) continue;
    const baseDeclarations = findInterface(extendName, environment, declarationScope);
    if (baseDeclarations === null) continue;
    for (const baseDeclaration of baseDeclarations) {
      const baseDeclarationScope = environment.scopeOf(baseDeclaration) ?? null;
      const baseSubstitutions = substitutionEnvironment(
        baseDeclaration.typeParameters?.params,
        extend.typeArguments?.params,
        interfaceSubstitutions,
        declarationScope,
        baseDeclarationScope,
      );
      if (baseSubstitutions === null) continue;
      results.push(
        ...collectInterfaceIndexSignatures(
          baseDeclaration,
          extendName,
          baseSubstitutions,
          environment,
          resolvingAliases,
          nextResolvingInterfaces,
        ),
      );
    }
  }

  return results;
}

function unsafeDirectValue(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
  scope: Scope | null,
): UnsafeDictionary["unsafeValue"] | null {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return "unknown";
  if (unwrapped.type === "TSAnyKeyword") return "any";
  if (unwrapped.type === "TSObjectKeyword") return "object";
  if (unwrapped.type === "TSTypeLiteral" && isEffectivelyEmptyTypeLiteral(unwrapped))
    return "empty-object";
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.some(
      (member) =>
        unsafeDirectValue(member, environment, substitutions, resolvingAliases, scope) !== null,
    )
      ? "union"
      : null;
  }
  if (unwrapped.type === "TSIntersectionType") {
    const unsafeMembers = unwrapped.types.map((member) =>
      unsafeDirectValue(member, environment, substitutions, resolvingAliases, scope),
    );
    if (unsafeMembers.includes("any")) return "any";
    return unsafeMembers.length > 0 && unsafeMembers.every((member) => member !== null)
      ? unsafeMembers[0]
      : null;
  }
  if (unwrapped.type !== "TSTypeReference") return null;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  const resolved = substitutions.get(name);
  if (resolved !== undefined) {
    return isUnappliedReferenceTo(resolved.type, name)
      ? null
      : unsafeDirectValue(
          resolved.type,
          environment,
          resolved.substitutions,
          resolvingAliases,
          resolved.scope,
        );
  }

  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment, scope)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? null
      : unsafeDirectValue(wrapped, environment, substitutions, resolvingAliases, scope);
  }

  if (name === "Record" && isBuiltIn(name, environment, scope)) {
    const value = unwrapped.typeArguments?.params[1] ?? null;
    return value === null
      ? null
      : unsafeDirectValue(value, environment, substitutions, resolvingAliases, scope);
  }

  if (resolvingAliases.has(name)) return null;

  const interfaceDeclarations = findInterface(name, environment, scope);
  const found = findAlias(name, environment, scope);

  const aliasCloser =
    found !== null &&
    !found.ambiguous &&
    !resolvingAliases.has(name) &&
    (interfaceDeclarations === null ||
      (() => {
        const aliasScope = environment.scopeOf(found.alias);
        const interfaceScope = environment.scopeOf(interfaceDeclarations[0]);
        if (aliasScope === null || interfaceScope === null) return true;
        return aliasScope.depth >= interfaceScope.depth;
      })());

  if (aliasCloser) {
    const alias = found.alias;
    const aliasScope = environment.scopeOf(alias) ?? null;
    const nextSubstitutions = aliasSubstitution(
      alias,
      unwrapped,
      substitutions,
      scope,
      environment,
    );
    if (nextSubstitutions === null) return null;
    const nextResolving = new Set(resolvingAliases);
    nextResolving.add(name);
    return unsafeDirectValue(
      alias.typeAnnotation,
      environment,
      nextSubstitutions,
      nextResolving,
      aliasScope,
    );
  }

  if (interfaceDeclarations !== null) {
    if (isEffectivelyEmptyInterface(interfaceDeclarations)) return "empty-object";
    for (const declaration of interfaceDeclarations) {
      const declarationScope = environment.scopeOf(declaration) ?? null;
      const interfaceSubstitutions = substitutionEnvironment(
        declaration.typeParameters?.params,
        unwrapped.typeArguments?.params,
        substitutions,
        scope,
        declarationScope,
      );
      if (interfaceSubstitutions === null) continue;
      const indexSignatures = collectInterfaceIndexSignatures(
        declaration,
        name,
        interfaceSubstitutions,
        environment,
        resolvingAliases,
        new Set(),
      );
      for (const { type: valueType, substitutions: valueSubstitutions } of indexSignatures) {
        const unsafe = unsafeDirectValue(
          valueType,
          environment,
          valueSubstitutions,
          resolvingAliases,
          environment.scopeOf(valueType) ?? scope,
        );
        if (unsafe !== null) return unsafe;
      }
    }
    return null;
  }

  if (found === null || resolvingAliases.has(name) || found.ambiguous) return null;
  const alias = found.alias;
  const aliasScope = environment.scopeOf(alias) ?? null;
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions, scope, environment);
  if (nextSubstitutions === null) return null;
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(name);
  return unsafeDirectValue(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving,
    aliasScope,
  );
}

function dictionaryValueTypes(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
  scope: Scope | null,
): readonly ResolvedType[] {
  const unwrapped = unwrapTransparentType(type);

  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.flatMap((member): readonly ResolvedType[] =>
      member.type === "TSIndexSignature" && member.typeAnnotation !== null
        ? [{ type: member.typeAnnotation.typeAnnotation, substitutions }]
        : [],
    );
  }

  if (unwrapped.type === "TSMappedType") {
    return unwrapped.typeAnnotation === null
      ? []
      : [{ type: unwrapped.typeAnnotation, substitutions }];
  }

  if (unwrapped.type !== "TSTypeReference") return [];
  const name = typeReferenceName(unwrapped);
  if (name === null) return [];
  const resolved = substitutions.get(name);
  if (resolved !== undefined) {
    return isUnappliedReferenceTo(resolved.type, name)
      ? []
      : dictionaryValueTypes(
          resolved.type,
          environment,
          resolved.substitutions,
          resolvingAliases,
          resolved.scope,
        );
  }

  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment, scope)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? []
      : dictionaryValueTypes(wrapped, environment, substitutions, resolvingAliases, scope);
  }

  if (name === "Record" && isBuiltIn(name, environment, scope)) {
    const value = unwrapped.typeArguments?.params[1] ?? null;
    return value === null ? [] : [{ type: value, substitutions }];
  }

  if ((name === "Pick" || name === "Omit") && isBuiltIn(name, environment, scope)) {
    const source = unwrapped.typeArguments?.params[0];
    return source === undefined
      ? []
      : dictionaryValueTypes(source, environment, substitutions, resolvingAliases, scope);
  }

  const interfaceDeclarations = findInterface(name, environment, scope);
  if (interfaceDeclarations !== null) {
    const results: ResolvedType[] = [];
    for (const declaration of interfaceDeclarations) {
      const declarationScope = environment.scopeOf(declaration) ?? null;
      const interfaceSubstitutions = substitutionEnvironment(
        declaration.typeParameters?.params,
        unwrapped.typeArguments?.params,
        substitutions,
        scope,
        declarationScope,
      );
      if (interfaceSubstitutions === null) continue;
      results.push(
        ...collectInterfaceIndexSignatures(
          declaration,
          name,
          interfaceSubstitutions,
          environment,
          resolvingAliases,
          new Set(),
        ),
      );
    }
    return results;
  }

  const found = findAlias(name, environment, scope);
  if (found === null || resolvingAliases.has(name)) return [];
  const alias = found.alias;
  if (found.ambiguous) return [];
  const aliasScope = environment.scopeOf(alias) ?? null;
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions, scope, environment);
  if (nextSubstitutions === null) return [];
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(name);
  return dictionaryValueTypes(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving,
    aliasScope,
  );
}

export function classifyUnsafeDictionaryValue(
  valueType: ESTree.TSType,
  environment: TypeEnvironment,
): UnsafeDictionary | null {
  const scope = environment.scopeOf(valueType);
  const unsafeValue = unsafeDirectValue(valueType, environment, new Map(), new Set(), scope);
  return unsafeValue === null ? null : { kind: "unsafe-dictionary", unsafeValue };
}

export function classifyUnsafeDictionary(
  type: ESTree.TSType,
  environment: TypeEnvironment,
): UnsafeDictionary | null {
  const scope = environment.scopeOf(type);
  for (const { type: valueType, substitutions } of dictionaryValueTypes(
    type,
    environment,
    new Map(),
    new Set(),
    scope,
  )) {
    const unsafeValue = unsafeDirectValue(
      valueType,
      environment,
      substitutions,
      new Set(),
      environment.scopeOf(valueType) ?? scope,
    );
    if (unsafeValue !== null) return { kind: "unsafe-dictionary", unsafeValue };
  }
  return null;
}

function resolvesToDictionary(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
  scope: Scope | null,
): boolean {
  return dictionaryValueTypes(type, environment, substitutions, resolvingAliases, scope).length > 0;
}

export function classifyWideningTarget(
  type: ESTree.TSType,
  environment: TypeEnvironment,
): WideningTarget | null {
  const scope = environment.scopeOf(type);
  return classifyWideningTargetAt(type, environment, new Map(), new Set(), scope);
}

function classifyWideningTargetAt(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
  scope: Scope | null,
): WideningTarget | null {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
  if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some((member) => member.type === "TSIndexSignature")
      ? { kind: "open dictionary" }
      : unwrapped.members.length > 0
        ? { kind: "anonymous object" }
        : null;
  }
  if (unwrapped.type === "TSMappedType") {
    return isBroadMappedKey(
      unwrapped.constraint,
      environment,
      substitutions,
      resolvingAliases,
      scope,
    )
      ? { kind: "open dictionary" }
      : null;
  }
  if (unwrapped.type !== "TSTypeReference") return null;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  const resolved = substitutions.get(name);
  if (resolved !== undefined) {
    return isUnappliedReferenceTo(resolved.type, name)
      ? null
      : classifyWideningTargetAt(
          resolved.type,
          environment,
          resolved.substitutions,
          resolvingAliases,
          resolved.scope,
        );
  }

  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment, scope)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? null
      : classifyWideningTargetAt(wrapped, environment, substitutions, resolvingAliases, scope);
  }

  if (name === "Record" && isBuiltIn(name, environment, scope)) return { kind: "open dictionary" };

  const found = findAlias(name, environment, scope);
  if (found === null) return null;
  if (found.ambiguous) return null;
  const alias = found.alias;
  const aliasScope = environment.scopeOf(alias) ?? null;
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions, scope, environment);
  if (nextSubstitutions === null) return null;
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(name);
  if ((alias.typeParameters?.params.length ?? 0) > 0) {
    return resolvesToDictionary(
      alias.typeAnnotation,
      environment,
      nextSubstitutions,
      nextResolving,
      aliasScope,
    )
      ? { kind: "generic container" }
      : null;
  }
  const resolvedTarget = classifyAliasBroadTarget(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving,
    aliasScope,
  );
  return resolvedTarget;
}

function isBroadMappedKey(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
  scope: Scope | null,
): boolean {
  const unwrapped = unwrapTransparentType(type);
  if (
    unwrapped.type === "TSStringKeyword" ||
    unwrapped.type === "TSNumberKeyword" ||
    unwrapped.type === "TSSymbolKeyword"
  ) {
    return true;
  }
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.every((member) =>
      isBroadMappedKey(member, environment, substitutions, resolvingAliases, scope),
    );
  }
  if (unwrapped.type !== "TSTypeReference") return false;
  const name = typeReferenceName(unwrapped);
  if (name === null) return false;
  const resolved = substitutions.get(name);
  if (resolved !== undefined && !isUnappliedReferenceTo(resolved.type, name)) {
    return isBroadMappedKey(
      resolved.type,
      environment,
      resolved.substitutions,
      resolvingAliases,
      resolved.scope,
    );
  }

  if (resolvingAliases.has(name)) return false;

  if (name === "PropertyKey" && isBuiltIn(name, environment, scope)) return true;

  const found = findAlias(name, environment, scope);
  if (found !== null && !found.ambiguous) {
    const alias = found.alias;
    const aliasScope = environment.scopeOf(alias) ?? null;
    const nextSubstitutions = aliasSubstitution(
      alias,
      unwrapped,
      substitutions,
      scope,
      environment,
    );
    if (nextSubstitutions !== null) {
      const nextResolving = new Set(resolvingAliases);
      nextResolving.add(name);
      return isBroadMappedKey(
        alias.typeAnnotation,
        environment,
        nextSubstitutions,
        nextResolving,
        aliasScope,
      );
    }
  }

  return false;
}

function classifyAliasBroadTarget(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
  scope: Scope | null,
): WideningTarget | null {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
  if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some((member) => member.type === "TSIndexSignature")
      ? { kind: "open dictionary" }
      : null;
  }
  if (unwrapped.type === "TSMappedType") {
    return isBroadMappedKey(
      unwrapped.constraint,
      environment,
      substitutions,
      resolvingAliases,
      scope,
    )
      ? { kind: "open dictionary" }
      : null;
  }
  if (unwrapped.type !== "TSTypeReference") return null;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  const resolved = substitutions.get(name);
  if (resolved !== undefined) {
    return isUnappliedReferenceTo(resolved.type, name)
      ? null
      : classifyAliasBroadTarget(
          resolved.type,
          environment,
          resolved.substitutions,
          resolvingAliases,
          resolved.scope,
        );
  }

  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment, scope)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? null
      : classifyAliasBroadTarget(wrapped, environment, substitutions, resolvingAliases, scope);
  }
  if (name === "Record" && isBuiltIn(name, environment, scope)) {
    return { kind: "open dictionary" };
  }

  const found = findAlias(name, environment, scope);
  if (found === null || found.ambiguous || resolvingAliases.has(name)) return null;
  const alias = found.alias;
  const aliasScope = environment.scopeOf(alias) ?? null;
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions, scope, environment);
  if (nextSubstitutions === null) return null;
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(name);
  return classifyAliasBroadTarget(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving,
    aliasScope,
  );
}

export function isPopulatedObjectExpression(expression: ESTree.Expression): boolean {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current.type === "ObjectExpression" && current.properties.length > 0;
}

export function isKnownEvidenceExpression(expression: ESTree.Expression): boolean {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  if (current.type === "ObjectExpression") return true;
  return (
    current.type === "ArrayExpression" ||
    current.type === "ArrowFunctionExpression" ||
    current.type === "ClassExpression" ||
    current.type === "FunctionExpression" ||
    current.type === "NewExpression" ||
    current.type === "Literal" ||
    current.type === "TemplateLiteral" ||
    current.type === "UnaryExpression"
  );
}
