import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { createScopeIndex, type Scope, type ScopeIndex } from "../shared/resolves-to-unknown.ts";
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
    let index: ScopeIndex | null = null;

    const resolvesToObjectWith = (
      type: ESTree.TSType,
      scope: Scope | null,
      shadowedAliases: ReadonlySet<string>,
      visited: Set<string>,
      substitutions: ReadonlyMap<string, ESTree.TSType>,
    ): boolean => {
      if (type.type === "TSObjectKeyword") return true;
      if (type.type === "TSParenthesizedType") {
        return resolvesToObjectWith(
          type.typeAnnotation,
          scope,
          shadowedAliases,
          visited,
          substitutions,
        );
      }
      if (type.type === "TSUnionType") {
        return type.types.some((member) =>
          resolvesToObjectWith(member, scope, shadowedAliases, visited, substitutions),
        );
      }
      if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return false;
      const name = type.typeName.name;
      const substitution = substitutions.get(name);
      if (substitution !== undefined) {
        if (visited.has(name)) return false;
        const nextVisited = new Set(visited);
        nextVisited.add(name);
        return resolvesToObjectWith(
          substitution,
          scope,
          shadowedAliases,
          nextVisited,
          substitutions,
        );
      }
      if (visited.has(name) || shadowedAliases.has(name)) return false;
      const found = index?.lookupAlias(name, scope);
      if (found === null || found === undefined || found.ambiguous) return false;
      const alias = found.alias;
      const parameters = alias.typeParameters?.params ?? [];
      const arguments_ = type.typeArguments?.params ?? [];
      if (arguments_.length > 0 && parameters.length === 0) return false;
      const nextSubstitutions = new Map(substitutions);
      for (const [parameterIndex, parameter] of parameters.entries()) {
        const argument = arguments_[parameterIndex] ?? parameter.default;
        if (argument === null || argument === undefined) return false;
        nextSubstitutions.set(parameter.name.name, argument);
      }
      const nextVisited = new Set(visited);
      nextVisited.add(name);
      return resolvesToObjectWith(
        alias.typeAnnotation,
        index?.scopeOf(alias) ?? null,
        shadowedAliases,
        nextVisited,
        nextSubstitutions,
      );
    };

    const checkParameters = (node: ParameterOwner) => {
      if (index === null) return;
      const shadowedAliases = lexicalTypeParameterNames(node, context.sourceCode.visitorKeys);
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (
          !resolvesToObjectWith(
            annotation.typeAnnotation,
            index.scopeOf(node),
            shadowedAliases,
            new Set(),
            new Map(),
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

    return {
      Program(node) {
        index = createScopeIndex(node, context.sourceCode.visitorKeys);
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
