import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

const moduleMockMethods = new Set(["doMock", "mock", "setMock", "unstable_mockModule"]);

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function importedName(node: ESTree.Node): string | null {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function unwrapValueExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

function isTestFrameworkNamespaceImport(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): boolean {
  if (expression.type !== "Identifier") return false;
  const variable = resolveVariable(sourceCode, expression);
  if (variable === null || variable.defs.length === 0) return false;
  return variable.defs.some((definition) => {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") {
      return false;
    }
    const source = definition.parent.source.value;
    return (
      definition.node.type === "ImportNamespaceSpecifier" &&
      (source === "vitest" || source === "@jest/globals")
    );
  });
}

function isTestFrameworkObject(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  const unwrapped = unwrapValueExpression(expression);
  if (unwrapped.type === "MemberExpression" && !unwrapped.computed) {
    // Namespace access such as `vitest.vi.mock`: the namespace import decides.
    const member = unwrapped.property.type === "Identifier" ? unwrapped.property.name : null;
    if (member !== "vi" && member !== "jest") return false;
    return isTestFrameworkNamespaceImport(sourceCode, unwrapped.object);
  }
  if (unwrapped.type !== "Identifier") return false;
  if (
    (unwrapped.name === "vi" || unwrapped.name === "jest") &&
    sourceCode.isGlobalReference(unwrapped)
  ) {
    return true;
  }

  const variable = resolveVariable(sourceCode, unwrapped);
  if (variable === null || variable.defs.length === 0) {
    return unwrapped.name === "vi" || unwrapped.name === "jest";
  }
  return variable.defs.some((definition) => {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration") {
      return false;
    }
    const source = definition.parent.source.value;
    const name = importedName(definition.node);
    return (
      (source === "vitest" && name === "vi") || (source === "@jest/globals" && name === "jest")
    );
  });
}

function moduleMockCall(sourceCode: SourceCode, callee: ESTree.Expression): boolean {
  const unwrappedCallee = unwrapValueExpression(callee);
  if (
    !("property" in unwrappedCallee) ||
    !("object" in unwrappedCallee) ||
    !("computed" in unwrappedCallee)
  ) {
    return false;
  }
  if (!isTestFrameworkObject(sourceCode, unwrappedCallee.object)) return false;
  const property = unwrappedCallee.property;
  const method = unwrappedCallee.computed
    ? property.type === "Literal" && typeof property.value === "string"
      ? property.value
      : null
    : property.type === "Identifier"
      ? property.name
      : null;
  return method !== null && moduleMockMethods.has(method);
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Vitest and Jest module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        if (moduleMockCall(context.sourceCode, node.callee)) {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
});
