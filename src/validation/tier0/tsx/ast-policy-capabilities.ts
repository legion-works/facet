import ts from "typescript";

import type { DiscriminativeError } from "../../../shared/contracts/validation";
import {
  ALIAS_DENIED_NAMES,
  formatArgument,
  identifierText,
  isDeniedGlobalEval,
  isDeniedGlobalName,
  push,
  resolveStringFragments,
  TSX_CAPABILITY_CODES,
} from "./ast-policy-shared";

type ShadowCheck = (node: ts.Identifier) => boolean;

export function checkCallExpression(
  node: ts.CallExpression,
  errors: DiscriminativeError[],
  sourceFile: ts.SourceFile,
  isShadowed: ShadowCheck,
): void {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    push(
      errors,
      TSX_CAPABILITY_CODES.dynamicImport,
      "TSX dynamic import() is not allowed",
      node,
      sourceFile,
    );
    return;
  }
  if (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    !isShadowed(node.expression)
  ) {
    push(
      errors,
      TSX_CAPABILITY_CODES.requireCall,
      "TSX require(...) is not allowed; the vendored allowlist is ESM-only",
      node,
      sourceFile,
    );
    return;
  }
  const expression = node.expression;
  if (
    ts.isIdentifier(expression) &&
    isDeniedGlobalName(expression.text) &&
    !isShadowed(expression)
  ) {
    push(
      errors,
      TSX_CAPABILITY_CODES.fetch,
      `TSX global "${expression.text}(...)" is not allowed`,
      node,
      sourceFile,
    );
    return;
  }
  if (ts.isParenthesizedExpression(expression)) {
    const inner = expression.expression;
    if (
      ts.isBinaryExpression(inner) &&
      inner.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      ts.isNumericLiteral(inner.left) &&
      ts.isIdentifier(inner.right) &&
      isDeniedGlobalEval(inner.right.text) &&
      !isShadowed(inner.right)
    ) {
      push(
        errors,
        TSX_CAPABILITY_CODES.evalCall,
        'TSX indirect eval "(0, eval)(...)" is not allowed',
        node,
        sourceFile,
      );
      return;
    }
  }
  if (
    ts.isIdentifier(expression) &&
    isDeniedGlobalEval(expression.text) &&
    !isShadowed(expression)
  ) {
    push(
      errors,
      TSX_CAPABILITY_CODES.evalCall,
      `TSX global "${expression.text}(...)" is not allowed`,
      node,
      sourceFile,
    );
    return;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const targetName = identifierText(expression.expression);
    const propertyName = expression.name.text;
    if (
      targetName !== null &&
      (targetName === "globalThis" ||
        targetName === "window" ||
        targetName === "self" ||
        targetName === "global") &&
      (isDeniedGlobalName(propertyName) || isDeniedGlobalEval(propertyName))
    ) {
      push(
        errors,
        propertyName === "eval" ? TSX_CAPABILITY_CODES.evalCall : TSX_CAPABILITY_CODES.fetch,
        `TSX global "${targetName}.${propertyName}(...)" is not allowed`,
        node,
        sourceFile,
      );
    }
  }
}

export function checkNewExpression(
  node: ts.NewExpression,
  errors: DiscriminativeError[],
  sourceFile: ts.SourceFile,
  isShadowed: ShadowCheck,
): void {
  const expression = node.expression;
  if (!ts.isIdentifier(expression) || isShadowed(expression)) return;
  const name = expression.text;
  if (name === "Function") {
    push(
      errors,
      TSX_CAPABILITY_CODES.functionConstructor,
      'TSX "new Function(...)" is not allowed',
      node,
      sourceFile,
    );
  } else if (name === "Worker") {
    push(
      errors,
      TSX_CAPABILITY_CODES.worker,
      'TSX "new Worker(...)" is not allowed',
      node,
      sourceFile,
    );
  } else if (name === "SharedWorker") {
    push(
      errors,
      TSX_CAPABILITY_CODES.sharedWorker,
      'TSX "new SharedWorker(...)" is not allowed',
      node,
      sourceFile,
    );
  }
}

export function checkVariableStatement(
  node: ts.VariableStatement,
  errors: DiscriminativeError[],
  sourceFile: ts.SourceFile,
): void {
  for (const declaration of node.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
    if (!isDeniedAliasInitializer(declaration.initializer)) continue;
    push(
      errors,
      TSX_CAPABILITY_CODES.aliasOfDeniedGlobal,
      `TSX binding "${declaration.name.text}" aliases a denied global or constructor; this is not allowed`,
      node,
      sourceFile,
    );
  }
}

function isDeniedAliasInitializer(init: ts.Expression): boolean {
  if (ts.isIdentifier(init)) return ALIAS_DENIED_NAMES.has(init.text);
  if (ts.isPropertyAccessExpression(init)) {
    const target = identifierText(init.expression);
    if (target === null || !ALIAS_DENIED_NAMES.has(target)) return false;
    return ALIAS_DENIED_NAMES.has(init.name.text);
  }
  return false;
}

export function checkPropertyAccess(
  node: ts.PropertyAccessExpression,
  errors: DiscriminativeError[],
  sourceFile: ts.SourceFile,
): void {
  const target = identifierText(node.expression);
  if (target === null || !["globalThis", "window", "self", "global"].includes(target)) return;
  const property = node.name.text;
  if (isDeniedGlobalName(property) || isDeniedGlobalEval(property)) {
    push(
      errors,
      property === "eval" ? TSX_CAPABILITY_CODES.evalCall : TSX_CAPABILITY_CODES.fetch,
      `TSX global "${target}.${property}" is not allowed`,
      node,
      sourceFile,
    );
  }
}

export function checkElementAccess(
  node: ts.ElementAccessExpression,
  errors: DiscriminativeError[],
  sourceFile: ts.SourceFile,
): void {
  const target = identifierText(node.expression);
  if (target === null || !["globalThis", "window", "self", "global"].includes(target)) return;
  const resolved = resolveStringFragments(node.argumentExpression);
  if (resolved !== null) {
    if (isDeniedGlobalName(resolved)) {
      push(
        errors,
        TSX_CAPABILITY_CODES.fetch,
        `TSX computed global "${target}[${formatArgument(node.argumentExpression)}]" resolves to "${resolved}"`,
        node,
        sourceFile,
      );
      return;
    }
    if (isDeniedGlobalEval(resolved)) {
      push(
        errors,
        TSX_CAPABILITY_CODES.evalCall,
        `TSX computed global "${target}[${formatArgument(node.argumentExpression)}]" resolves to "${resolved}"`,
        node,
        sourceFile,
      );
      return;
    }
  }
  push(
    errors,
    TSX_CAPABILITY_CODES.unsupportedComputedGlobal,
    `TSX computed access on "${target}[...]" cannot be statically resolved; review the artifact`,
    node,
    sourceFile,
  );
}
