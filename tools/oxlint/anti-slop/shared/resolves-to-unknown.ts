import type { ESTree } from "@oxlint/plugins";

type VisitorKeys = Readonly<Record<string, readonly string[]>>;

export type AliasDeclarations = ReadonlyMap<string, ESTree.TSTypeAliasDeclaration>;

type Substitutions = ReadonlyMap<string, ESTree.TSType>;

function isNode(value: unknown): value is ESTree.Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function collectAliasDeclarations(
  node: ESTree.Node,
  visitorKeys: VisitorKeys,
  aliases: Map<string, ESTree.TSTypeAliasDeclaration>,
  ambiguous: Set<string>,
): void {
  if (node.type === "TSTypeAliasDeclaration") {
    if (aliases.has(node.id.name)) {
      aliases.delete(node.id.name);
      ambiguous.add(node.id.name);
    } else if (!ambiguous.has(node.id.name)) {
      aliases.set(node.id.name, node);
    }
  }
  const record = node as unknown as Readonly<Record<string, unknown>>;
  for (const key of visitorKeys[node.type] ?? []) {
    const value = record[key];
    if (isNode(value)) {
      collectAliasDeclarations(value, visitorKeys, aliases, ambiguous);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const child of value) {
      if (isNode(child)) collectAliasDeclarations(child, visitorKeys, aliases, ambiguous);
    }
  }
}

export function collectAliasDeclarationsIn(
  program: ESTree.Program,
  visitorKeys: VisitorKeys,
): { aliases: AliasDeclarations; ambiguous: ReadonlySet<string> } {
  const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>();
  const ambiguous = new Set<string>();
  for (const statement of program.body) {
    collectAliasDeclarations(statement, visitorKeys, aliases, ambiguous);
  }
  return { aliases, ambiguous };
}

export type ResolvesToUnknown = (
  type: ESTree.TSType,
  shadowedAliases: ReadonlySet<string>,
  visited?: Set<string>,
  substitutions?: Substitutions,
) => boolean;

function resolveSubstitutionArgument(
  type: ESTree.TSType,
  base: Substitutions,
  resolving: ReadonlySet<string> = new Set(),
): ESTree.TSType {
  const unwrapped = type.type === "TSParenthesizedType" ? type.typeAnnotation : type;
  if (unwrapped.type !== "TSTypeReference" || unwrapped.typeName.type !== "Identifier") return type;
  const name = unwrapped.typeName.name;
  if (resolving.has(name)) return type;
  const substitution = base.get(name);
  if (substitution === undefined) return type;
  const nextResolving = new Set(resolving);
  nextResolving.add(name);
  return resolveSubstitutionArgument(substitution, base, nextResolving);
}

/** Builds a resolver that decides whether a type annotation resolves to `unknown`. */
export function createResolvesToUnknown(
  aliases: AliasDeclarations,
  ambiguous: ReadonlySet<string>,
): ResolvesToUnknown {
  const resolvesToUnknown: ResolvesToUnknown = (
    type,
    shadowedAliases,
    visited = new Set<string>(),
    substitutions = new Map<string, ESTree.TSType>(),
  ) => {
    if (type.type === "TSUnknownKeyword") return true;
    if (type.type === "TSParenthesizedType") {
      return resolvesToUnknown(type.typeAnnotation, shadowedAliases, visited, substitutions);
    }
    if (type.type === "TSUnionType") {
      return type.types.some((member) =>
        resolvesToUnknown(member, shadowedAliases, visited, substitutions),
      );
    }
    if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return false;
    const name = type.typeName.name;
    const substitution = substitutions.get(name);
    if (substitution !== undefined) {
      return resolvesToUnknown(substitution, shadowedAliases, visited, substitutions);
    }
    if (shadowedAliases.has(name) || ambiguous.has(name) || visited.has(name)) return false;
    const alias = aliases.get(name);
    if (alias !== undefined) {
      const parameters = alias.typeParameters?.params ?? [];
      const arguments_ = type.typeArguments?.params ?? [];
      const nextSubstitutions = new Map(substitutions);
      for (const [index, parameter] of parameters.entries()) {
        const argument = arguments_[index] ?? parameter.default;
        if (argument === null || argument === undefined) return false;
        nextSubstitutions.set(
          parameter.name.name,
          resolveSubstitutionArgument(argument, substitutions),
        );
      }
      const nextVisited = new Set(visited);
      nextVisited.add(name);
      return resolvesToUnknown(
        alias.typeAnnotation,
        shadowedAliases,
        nextVisited,
        nextSubstitutions,
      );
    }
    if (name === "Promise" || name === "PromiseLike") {
      const value = type.typeArguments?.params[0];
      return (
        value !== undefined && resolvesToUnknown(value, shadowedAliases, visited, substitutions)
      );
    }
    return false;
  };
  return resolvesToUnknown;
}
