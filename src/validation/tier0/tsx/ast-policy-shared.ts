import ts from "typescript";

import type { DiscriminativeError } from "../../../shared/contracts/validation";

export const TSX_CAPABILITY_CODES = {
  fetch: "tsx_capability_fetch",
  evalCall: "tsx_capability_eval",
  functionConstructor: "tsx_capability_function_constructor",
  dynamicImport: "tsx_capability_dynamic_import",
  worker: "tsx_capability_worker",
  sharedWorker: "tsx_capability_shared_worker",
  unsupportedComputedGlobal: "tsx_capability_computed_global",
  requireCall: "tsx_capability_require",
  aliasOfDeniedGlobal: "tsx_capability_global_alias",
} as const;

export function locationFor(node: ts.Node, sourceFile: ts.SourceFile): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${line + 1}:${character + 1}`;
}

export function push(
  errors: DiscriminativeError[],
  code: string,
  message: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
): void {
  errors.push({ code, message, location: locationFor(node, sourceFile) });
}

export function isDeniedGlobalName(name: string): boolean {
  return name === "fetch";
}

export function isDeniedGlobalEval(name: string): boolean {
  return name === "eval";
}

export const ALIAS_DENIED_NAMES = new Set([
  "globalThis",
  "window",
  "self",
  "global",
  "Worker",
  "SharedWorker",
  "Function",
  "fetch",
  "eval",
]);

export function identifierText(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  return null;
}

export function formatArgument(node: ts.Expression): string {
  if (ts.isStringLiteral(node)) return JSON.stringify(node.text);
  return "<expression>";
}

export function resolveStringFragments(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStringFragments(node.left);
    const right = resolveStringFragments(node.right);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}
