import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

type NamedNode = ESTree.Node & { name: string };

function isDeclaredName(node: NamedNode): boolean {
  const parent = node.parent;
  if (parent === undefined || parent === null) return false;
  switch (parent.type) {
    case "VariableDeclarator":
    case "ClassDeclaration":
    case "ClassExpression":
    case "TSTypeAliasDeclaration":
    case "TSInterfaceDeclaration":
    case "TSEnumDeclaration":
    case "TSModuleDeclaration":
    case "TSNamespaceExportDeclaration":
      return parent.id === node;
    case "FunctionDeclaration":
    case "FunctionExpression":
      return parent.id === node || (parent.params as readonly unknown[]).includes(node);
    case "ArrowFunctionExpression":
    case "TSEmptyBodyFunctionExpression":
      return (parent.params as readonly unknown[]).includes(node);
    case "TSParameterProperty":
      return parent.parameter === node;
    case "PropertyDefinition":
    case "MethodDefinition":
    case "TSPropertySignature":
    case "TSMethodSignature":
      return parent.key === node && !parent.computed;
    case "Property":
      return parent.parent?.type === "ObjectPattern"
        ? parent.value === node
        : parent.key === node && !parent.computed;
    case "ArrayPattern":
      return (parent.elements as readonly unknown[]).includes(node);
    case "AssignmentPattern":
      return parent.left === node;
    case "RestElement":
      return parent.argument === node;
    case "TSEnumMember":
      return parent.id === node;
    case "CatchClause":
      return parent.param === node;
    case "TSTypeParameter":
      return parent.name === node;
    case "TSMappedType":
      return parent.key === node;
    case "TSIndexSignature":
      return (parent.parameters as readonly unknown[]).includes(node);
    case "TSDeclareFunction":
      return parent.id === node || (parent.params as readonly unknown[]).includes(node);
    default:
      return false;
  }
}

function isDeclaredPrivateName(node: NamedNode): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    parent !== null &&
    (parent.type === "PropertyDefinition" || parent.type === "MethodDefinition") &&
    parent.key === node
  );
}

/** Ban the case-insensitive substring "shape" in declared JavaScript and TypeScript symbol names. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in declared JavaScript, TypeScript, and private symbol names; property accesses and import references are not declarations.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    const reportForbiddenSymbolName = (node: NamedNode) => {
      if (!containsForbiddenSymbolName(node.name)) return;
      if (node.type === "Identifier" && !isDeclaredName(node)) return;
      if (node.type === "PrivateIdentifier" && !isDeclaredPrivateName(node)) return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
    };
  },
});
