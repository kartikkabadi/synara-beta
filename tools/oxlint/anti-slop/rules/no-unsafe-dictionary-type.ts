import { defineRule } from "@oxlint/plugins";

import {
  classifyUnsafeDictionary,
  classifyUnsafeDictionaryValue,
  createTypeEnvironment,
  type TypeEnvironment,
} from "../shared/dictionary-types.ts";
import { type VisitorKeys } from "../shared/resolves-to-unknown.ts";

import type { ESTree } from "@oxlint/plugins";

const typeNodeKinds: ReadonlySet<string> = new Set([
  "JSDocNonNullableType",
  "JSDocNullableType",
  "JSDocUnknownType",
  "TSAnyKeyword",
  "TSArrayType",
  "TSBigIntKeyword",
  "TSBooleanKeyword",
  "TSConditionalType",
  "TSConstructorType",
  "TSFunctionType",
  "TSImportType",
  "TSIndexedAccessType",
  "TSInferType",
  "TSIntersectionType",
  "TSIntrinsicKeyword",
  "TSLiteralType",
  "TSMappedType",
  "TSNamedTupleMember",
  "TSNeverKeyword",
  "TSNullKeyword",
  "TSNumberKeyword",
  "TSObjectKeyword",
  "TSParenthesizedType",
  "TSStringKeyword",
  "TSSymbolKeyword",
  "TSTemplateLiteralType",
  "TSThisType",
  "TSTupleType",
  "TSTypeLiteral",
  "TSTypeOperator",
  "TSTypePredicate",
  "TSTypeQuery",
  "TSTypeReference",
  "TSUndefinedKeyword",
  "TSUnionType",
  "TSUnknownKeyword",
  "TSVoidKeyword",
]);

function isTypeNode(node: ESTree.Node): node is ESTree.TSType {
  return typeNodeKinds.has(node.type);
}

function typeAnnotationUsesAnyOf(
  root: ESTree.Node,
  names: ReadonlySet<string>,
  visitorKeys: VisitorKeys,
): boolean {
  const seen = new Set<ESTree.Node>();
  const stack: ESTree.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (
      node.type === "TSTypeReference" &&
      node.typeName.type === "Identifier" &&
      names.has(node.typeName.name)
    ) {
      return true;
    }
    const record = node as unknown as Readonly<Record<string, unknown>>;
    for (const key of visitorKeys[node.type] ?? []) {
      const value = record[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (
            child !== null &&
            typeof child === "object" &&
            "type" in child &&
            typeof child.type === "string"
          ) {
            stack.push(child as ESTree.Node);
          }
        }
      } else if (
        value !== null &&
        typeof value === "object" &&
        "type" in value &&
        typeof value.type === "string"
      ) {
        stack.push(value as ESTree.Node);
      }
    }
  }
  return false;
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isInsideTypeAliasDeclaration(node: ESTree.Node): boolean {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (current.type === "TSTypeAliasDeclaration") return true;
    current = current.parent;
  }
  return false;
}

function enclosingTypeAliasDeclaration(node: ESTree.Node): ESTree.TSTypeAliasDeclaration | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (current.type === "TSTypeAliasDeclaration") return current;
    current = current.parent;
  }
  return null;
}

function isTypeParameterDependent(node: ESTree.TSType, visitorKeys: VisitorKeys): boolean {
  const alias = enclosingTypeAliasDeclaration(node);
  if (alias === null) return false;
  const params = alias.typeParameters?.params;
  if (params === undefined || params.length === 0) return false;
  const parameterNames = new Set(params.map((parameter) => parameter.name.name));
  return typeAnnotationUsesAnyOf(node, parameterNames, visitorKeys);
}

function isPlainAliasConsumerUse(node: ESTree.TSType, environment: TypeEnvironment): boolean {
  if (node.type !== "TSTypeReference" || node.typeArguments?.params.length) return false;
  const name = typeReferenceName(node);
  if (name === null || isInsideTypeAliasDeclaration(node)) return false;
  const scope = environment.scopeOf(node);
  const found = environment.scopeIndex?.lookupAlias(name, scope) ?? null;
  return (
    found !== null && !found.ambiguous && (found.alias.typeParameters?.params.length ?? 0) === 0
  );
}

function isGenericAliasWithUnsafeBody(
  node: ESTree.TSType,
  environment: TypeEnvironment,
  visitorKeys: VisitorKeys,
): boolean {
  if (node.type !== "TSTypeReference" || (node.typeArguments?.params.length ?? 0) > 0) return false;
  const name = typeReferenceName(node);
  if (name === null || isInsideTypeAliasDeclaration(node)) return false;
  const scope = environment.scopeOf(node);
  const found = environment.scopeIndex?.lookupAlias(name, scope) ?? null;
  if (found === null || found.ambiguous) return false;
  const alias = found.alias;
  const params = alias.typeParameters?.params;
  if (params === undefined || params.length === 0) return false;
  if (!params.every((parameter) => parameter.default !== undefined)) return false;
  // If the body refers to any of the alias's own type parameters, the body's
  // safety depends on the concrete arguments supplied by the consumer. Classify
  // the consumer instead, where defaults and caller substitutions are applied.
  const parameterNames = new Set(params.map((parameter) => parameter.name.name));
  if (typeAnnotationUsesAnyOf(alias.typeAnnotation, parameterNames, visitorKeys)) return false;
  const aliasScope = environment.scopeOf(alias);
  if (aliasScope === null) return false;
  const bodyEnvironment: TypeEnvironment = {
    scopeIndex: environment.scopeIndex,
    scopeOf: () => aliasScope,
    shadowedBuiltIns: environment.shadowedBuiltIns,
  };
  return classifyUnsafeDictionary(alias.typeAnnotation, bodyEnvironment) !== null;
}

function shouldReportType(
  node: ESTree.TSType,
  environment: TypeEnvironment,
  visitorKeys: VisitorKeys,
): boolean {
  if (isPlainAliasConsumerUse(node, environment)) return false;
  if (isGenericAliasWithUnsafeBody(node, environment, visitorKeys)) return false;
  // A type inside an alias body that uses the alias's own parameters is not a
  // concrete unsafe dictionary; its safety depends on the caller's arguments.
  if (isTypeParameterDependent(node, visitorKeys)) return false;
  if (classifyUnsafeDictionary(node, environment) === null) return false;
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isTypeNode(current) && classifyUnsafeDictionary(current, environment) !== null)
      return false;
    current = current.parent;
  }
  return true;
}

/** Disallow object-dictionary contracts whose direct value type is an unsafe escape hatch. */
export const noUnsafeDictionaryTypeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow object-dictionary contracts whose direct value type is unknown, any, object, {}, or a union/alias containing one of those escape hatches.",
    },
    messages: {
      unsafeDictionary:
        "This dictionary's {{value}} value type gives callers no concrete value contract. Use an owner/schema-derived value type; parse external payloads before insertion.",
    },
  },
  createOnce(context) {
    let environment: TypeEnvironment | null = null;
    let visitorKeys: VisitorKeys | null = null;
    const report = (node: ESTree.Node, value: string) => {
      context.report({ node, messageId: "unsafeDictionary", data: { value } });
    };
    const reportIfUnsafe = (node: ESTree.TSType) => {
      if (
        environment === null ||
        visitorKeys === null ||
        !shouldReportType(node, environment, visitorKeys)
      )
        return;
      const unsafe = classifyUnsafeDictionary(node, environment);
      if (unsafe === null) return;
      report(node, unsafe.unsafeValue);
    };

    return {
      Program(node) {
        visitorKeys = context.sourceCode.visitorKeys;
        environment = createTypeEnvironment(node, visitorKeys);
      },
      TSTypeReference: reportIfUnsafe,
      TSTypeLiteral: reportIfUnsafe,
      TSMappedType: reportIfUnsafe,
      TSIndexSignature(node) {
        if (
          environment === null ||
          node.typeAnnotation === null ||
          node.parent.type === "TSTypeLiteral"
        )
          return;
        const unsafe = classifyUnsafeDictionaryValue(
          node.typeAnnotation.typeAnnotation,
          environment,
        );
        if (unsafe !== null) report(node, unsafe.unsafeValue);
      },
    };
  },
});
