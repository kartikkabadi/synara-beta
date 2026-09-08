import type { ESTree } from "@oxlint/plugins";

type Substitutions = ReadonlyMap<string, ESTree.TSType | boolean>;

export type VisitorKeys = Readonly<Record<string, readonly string[]>>;

export type Scope = {
  readonly parent: Scope | null;
  readonly aliases: Map<string, ESTree.TSTypeAliasDeclaration[]>;
  readonly interfaces: Map<string, ESTree.TSInterfaceDeclaration[]>;
};

const SCOPE_STARTERS = new Set([
  "Program",
  "BlockStatement",
  "StaticBlock",
  "SwitchStatement",
  "TSModuleBlock",
]);

function isNode(value: unknown): value is ESTree.Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function isAliasDeclaration(node: ESTree.Node): node is ESTree.TSTypeAliasDeclaration {
  return node.type === "TSTypeAliasDeclaration";
}

function isInterfaceDeclaration(node: ESTree.Node): node is ESTree.TSInterfaceDeclaration {
  return node.type === "TSInterfaceDeclaration";
}

function indexScopes(
  node: ESTree.Node,
  scope: Scope,
  nodeScopes: Map<ESTree.Node, Scope>,
  visitorKeys: VisitorKeys,
): void {
  nodeScopes.set(node, scope);
  if (isAliasDeclaration(node)) {
    const list = scope.aliases.get(node.id.name) ?? [];
    list.push(node);
    scope.aliases.set(node.id.name, list);
  }
  if (isInterfaceDeclaration(node)) {
    const list = scope.interfaces.get(node.id.name) ?? [];
    list.push(node);
    scope.interfaces.set(node.id.name, list);
  }
  const record = node as unknown as Readonly<Record<string, unknown>>;
  for (const key of visitorKeys[node.type] ?? []) {
    const value = record[key];
    if (isNode(value)) {
      indexScopes(value, scopeForChild(value, scope), nodeScopes, visitorKeys);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const child of value) {
      if (isNode(child)) {
        indexScopes(child, scopeForChild(child, scope), nodeScopes, visitorKeys);
      }
    }
  }
}

function scopeForChild(child: ESTree.Node, scope: Scope): Scope {
  return SCOPE_STARTERS.has(child.type)
    ? { parent: scope, aliases: new Map(), interfaces: new Map() }
    : scope;
}

/**
 * Indexes type-alias declarations by lexical scope. Function and block bodies
 * open scopes, so a nested alias shadows outer names only for uses inside its
 * own scope and can never affect annotations outside it. Function parameter and
 * return-type annotations resolve in the scope where the function is declared,
 * matching TypeScript.
 */
export function createScopeIndex(program: ESTree.Program, visitorKeys: VisitorKeys): ScopeIndex {
  const rootScope: Scope = { parent: null, aliases: new Map(), interfaces: new Map() };
  const nodeScopes = new Map<ESTree.Node, Scope>();
  for (const statement of program.body) {
    indexScopes(statement, rootScope, nodeScopes, visitorKeys);
  }
  const lookupAlias = (
    name: string,
    scope: Scope | null,
  ): { alias: ESTree.TSTypeAliasDeclaration; ambiguous: boolean } | null => {
    let current = scope;
    while (current !== null) {
      const list = current.aliases.get(name);
      const first = list?.[0];
      if (first !== undefined) return { alias: first, ambiguous: (list?.length ?? 0) > 1 };
      current = current.parent;
    }
    return null;
  };
  const lookupInterface = (
    name: string,
    scope: Scope | null,
  ): readonly ESTree.TSInterfaceDeclaration[] | null => {
    let current = scope;
    while (current !== null) {
      const list = current.interfaces.get(name);
      if (list !== undefined && list.length > 0) return list;
      current = current.parent;
    }
    return null;
  };
  return {
    scopeOf: (node) => nodeScopes.get(node) ?? null,
    lookupAlias,
    lookupInterface,
    allAliases: () => [...nodeScopes.keys()].filter(isAliasDeclaration),
  };
}

export type ScopeIndex = ReturnType<typeof createScopeIndex>;

function typeSignature(type: ESTree.TSType): string {
  const unwrapped = type.type === "TSParenthesizedType" ? type.typeAnnotation : type;
  if (unwrapped.type !== "TSTypeReference" || unwrapped.typeName.type !== "Identifier") {
    return unwrapped.type;
  }
  const arguments_ = unwrapped.typeArguments?.params ?? [];
  return `${unwrapped.typeName.name}<${arguments_.map(typeSignature).join(",")}>`;
}

/** Visit key for an alias body's self-reference, blocking direct alias cycles. */
export function selfAliasVisitKey(name: string): string {
  return `${name}#${name}<>`;
}

export type ScopedResolves = (
  useSite: ESTree.Node,
  type: ESTree.TSType,
  shadowedAliases: ReadonlySet<string>,
  visited?: Set<string>,
  substitutions?: Substitutions,
) => boolean;

/** Builds a scope-aware resolver that decides whether a type annotation resolves to `unknown`. */
export function createScopedResolvesToUnknown(index: ScopeIndex): ScopedResolves {
  const rootScope: Scope = { parent: null, aliases: new Map() };

  const resolvesToUnknownAt = (
    type: ESTree.TSType,
    scope: Scope | null,
    shadowedAliases: ReadonlySet<string>,
    visited: Set<string>,
    substitutions: Substitutions,
  ): boolean => {
    if (type.type === "TSUnknownKeyword") return true;
    if (type.type === "TSParenthesizedType") {
      return resolvesToUnknownAt(
        type.typeAnnotation,
        scope,
        shadowedAliases,
        visited,
        substitutions,
      );
    }
    if (type.type === "TSUnionType") {
      return type.types.some((member) =>
        resolvesToUnknownAt(member, scope, shadowedAliases, visited, substitutions),
      );
    }
    if (type.type === "TSIntersectionType") {
      return type.types.some((member) =>
        resolvesToUnknownAt(member, scope, shadowedAliases, visited, substitutions),
      );
    }
    if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return false;
    const name = type.typeName.name;
    const visitKey = `${name}#${typeSignature(type)}`;
    const substitution = substitutions.get(name);
    if (substitution !== undefined) {
      if (typeof substitution === "boolean") return substitution;
      if (visited.has(visitKey)) return false;
      const nextVisited = new Set(visited);
      nextVisited.add(visitKey);
      return resolvesToUnknownAt(substitution, scope, shadowedAliases, nextVisited, substitutions);
    }
    if (shadowedAliases.has(name) || visited.has(visitKey)) return false;
    const found = index.lookupAlias(name, scope);
    if (found === null) {
      if (name === "Promise" || name === "PromiseLike") {
        const value = type.typeArguments?.params[0];
        return (
          value !== undefined &&
          resolvesToUnknownAt(value, scope, shadowedAliases, visited, substitutions)
        );
      }
      return false;
    }
    if (found.ambiguous) return false;
    const alias = found.alias;
    const aliasScope = index.scopeOf(alias) ?? rootScope;
    const parameters = alias.typeParameters?.params ?? [];
    const arguments_ = type.typeArguments?.params ?? [];
    const nextSubstitutions = new Map(substitutions);
    for (const [parameterIndex, parameter] of parameters.entries()) {
      const argument = arguments_[parameterIndex] ?? parameter.default;
      if (argument === null || argument === undefined) return false;
      const isDefault = arguments_[parameterIndex] === undefined;
      const argumentScope = isDefault ? (index.scopeOf(parameter.default) ?? aliasScope) : scope;
      const argumentSubstitutions = isDefault ? nextSubstitutions : substitutions;
      const nextVisited = new Set(visited);
      nextVisited.add(visitKey);
      nextSubstitutions.set(
        parameter.name.name,
        resolvesToUnknownAt(
          argument,
          argumentScope,
          shadowedAliases,
          nextVisited,
          argumentSubstitutions,
        ),
      );
    }
    const nextVisited = new Set(visited);
    nextVisited.add(visitKey);
    return resolvesToUnknownAt(
      alias.typeAnnotation,
      aliasScope,
      shadowedAliases,
      nextVisited,
      nextSubstitutions,
    );
  };

  return (useSite, type, shadowedAliases, visited = new Set<string>(), substitutions = new Map()) =>
    resolvesToUnknownAt(
      type,
      index.scopeOf(useSite) ?? rootScope,
      shadowedAliases,
      visited,
      substitutions,
    );
}
