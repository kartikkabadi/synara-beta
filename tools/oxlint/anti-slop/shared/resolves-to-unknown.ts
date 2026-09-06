import type { ESTree } from "@oxlint/plugins";

export type AliasDeclarations = ReadonlyMap<string, ESTree.TSTypeAliasDeclaration>;

function referencedAliasName(type: ESTree.TSType): string | null {
  if (type.type === "TSParenthesizedType") return referencedAliasName(type.typeAnnotation);
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
  return type.typeArguments === null ||
    type.typeArguments === undefined ||
    type.typeArguments.params.length === 0
    ? type.typeName.name
    : null;
}

export type ResolvesToUnknown = (
  type: ESTree.TSType,
  shadowedAliases: ReadonlySet<string>,
  visited?: Set<string>,
) => boolean;

/** Builds a resolver that decides whether a type annotation resolves to `unknown`. */
export function createResolvesToUnknown(aliases: AliasDeclarations): ResolvesToUnknown {
  const resolvesToUnknown: ResolvesToUnknown = (
    type,
    shadowedAliases,
    visited = new Set<string>(),
  ) => {
    if (type.type === "TSUnknownKeyword") return true;
    if (type.type === "TSParenthesizedType") {
      return resolvesToUnknown(type.typeAnnotation, shadowedAliases, visited);
    }
    if (type.type === "TSUnionType") {
      return type.types.some((member) => resolvesToUnknown(member, shadowedAliases, visited));
    }
    if (
      type.type === "TSTypeReference" &&
      type.typeName.type === "Identifier" &&
      (type.typeName.name === "Promise" || type.typeName.name === "PromiseLike")
    ) {
      const value = type.typeArguments?.params[0];
      return value !== undefined && resolvesToUnknown(value, shadowedAliases, visited);
    }
    const name = referencedAliasName(type);
    if (name === null || visited.has(name) || shadowedAliases.has(name)) return false;
    const alias = aliases.get(name);
    if (
      alias === undefined ||
      (alias.typeParameters !== null && alias.typeParameters !== undefined)
    ) {
      return false;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(name);
    return resolvesToUnknown(alias.typeAnnotation, shadowedAliases, nextVisited);
  };
  return resolvesToUnknown;
}

/** Collects top-level (and exported) type alias declarations keyed by name. */
export function topLevelAliasDeclarations(program: ESTree.Program): AliasDeclarations {
  const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "TSTypeAliasDeclaration") {
      aliases.set(declaration.id.name, declaration);
    }
  }
  return aliases;
}
