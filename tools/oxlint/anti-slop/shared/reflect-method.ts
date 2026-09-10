import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

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

function isGlobalReflect(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  const unwrapped = unwrapValueExpression(expression);
  if (unwrapped.type !== "Identifier" || unwrapped.name !== "Reflect") return false;
  if (sourceCode.isGlobalReference(unwrapped)) return true;
  const variable = resolveVariable(sourceCode, unwrapped);
  return variable === null || variable.defs.length === 0;
}

/** Reports whether a call target names one method on the global Reflect object. */
export function isGlobalReflectMethodCall(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
  methodName: string,
): boolean {
  const unwrappedCallee = unwrapValueExpression(callee);
  if (
    !("property" in unwrappedCallee) ||
    !("object" in unwrappedCallee) ||
    !("computed" in unwrappedCallee)
  ) {
    return false;
  }
  if (!isGlobalReflect(sourceCode, unwrappedCallee.object)) return false;
  const property = unwrappedCallee.property;
  return unwrappedCallee.computed
    ? property.type === "Literal" && property.value === methodName
    : property.type === "Identifier" && property.name === methodName;
}
