import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { collectAliasDeclarationsIn, refineAliasAmbiguity } from "../shared/resolves-to-unknown.ts";
import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";

type Parameter = ESTree.ParamPattern;
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function parameterAnnotation(parameter: Parameter): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

function parameterName(parameter: Parameter, sourceCode: SourceCode): string {
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceCode.getText(parameter).replace(/\s*:\s*object\s*$/u, "");
}

/** Ban the broad object type on function inputs, including local aliases to object. */
export const noObjectParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow object function parameters; inputs must use an owner-provided type and be parsed at their boundary.",
    },
    messages: {
      objectParameter:
        "Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
    },
  },
  createOnce(context) {
    let aliases: ReadonlyMap<string, ESTree.TSType> = new Map();
    let ambiguous: ReadonlySet<string> = new Set();

    const resolvesToObjectWith = (
      type: ESTree.TSType,
      shadowedAliases: ReadonlySet<string>,
      visited: Set<string>,
      aliasTypes: ReadonlyMap<string, ESTree.TSType>,
      ambiguousAliases: ReadonlySet<string>,
    ): boolean => {
      if (type.type === "TSObjectKeyword") return true;
      if (type.type === "TSParenthesizedType") {
        return resolvesToObjectWith(
          type.typeAnnotation,
          shadowedAliases,
          visited,
          aliasTypes,
          ambiguousAliases,
        );
      }
      if (type.type === "TSUnionType") {
        return type.types.some((member) =>
          resolvesToObjectWith(member, shadowedAliases, visited, aliasTypes, ambiguousAliases),
        );
      }
      if (
        type.type !== "TSTypeReference" ||
        type.typeName.type !== "Identifier" ||
        (type.typeArguments !== null &&
          type.typeArguments !== undefined &&
          type.typeArguments.params.length > 0) ||
        visited.has(type.typeName.name) ||
        shadowedAliases.has(type.typeName.name) ||
        ambiguousAliases.has(type.typeName.name)
      ) {
        return false;
      }
      const alias = aliasTypes.get(type.typeName.name);
      if (alias === undefined) return false;
      const nextVisited = new Set(visited);
      nextVisited.add(type.typeName.name);
      return resolvesToObjectWith(
        alias,
        shadowedAliases,
        nextVisited,
        aliasTypes,
        ambiguousAliases,
      );
    };

    const checkParameters = (node: ParameterOwner) => {
      const shadowedAliases = lexicalTypeParameterNames(node, context.sourceCode.visitorKeys);
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (
          !resolvesToObjectWith(
            annotation.typeAnnotation,
            shadowedAliases,
            new Set(),
            aliases,
            ambiguous,
          )
        ) {
          continue;
        }
        context.report({
          node: annotation.typeAnnotation,
          messageId: "objectParameter",
          data: { parameter: parameterName(parameter, context.sourceCode) },
        });
      }
    };

    const nonGenericTypeAliases = (
      declarations: ReadonlyMap<string, readonly ESTree.TSTypeAliasDeclaration[]>,
    ): Map<string, ESTree.TSType> => {
      const aliasTypes = new Map<string, ESTree.TSType>();
      for (const [name, list] of declarations) {
        const first = list[0];
        if (first === undefined) continue;
        if (first.typeParameters !== null && first.typeParameters !== undefined) continue;
        aliasTypes.set(name, first.typeAnnotation);
      }
      return aliasTypes;
    };

    return {
      Program(node) {
        const collected = collectAliasDeclarationsIn(node, context.sourceCode.visitorKeys);
        const conservativeAliases = nonGenericTypeAliases(collected.declarations);
        const refined = refineAliasAmbiguity(
          collected.declarations,
          collected.ambiguous,
          (type, name) =>
            resolvesToObjectWith(
              type,
              new Set(),
              new Set([name]),
              conservativeAliases,
              collected.ambiguous,
            ),
        );
        const aliasTypes = new Map<string, ESTree.TSType>();
        for (const [name, alias] of refined.aliases) {
          if (alias.typeParameters !== null && alias.typeParameters !== undefined) continue;
          aliasTypes.set(name, alias.typeAnnotation);
        }
        aliases = aliasTypes;
        ambiguous = refined.ambiguous;
      },
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
