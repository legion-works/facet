/**
 * TypeScript AST policy for TSX artifacts.
 *
 * D13 of the TSX design: capability rejections (`fetch`, `eval`, `new Function`,
 * dynamic `import()`, worker construction, non-allowlisted imports) MUST be
 * decided from the TypeScript AST — never regex, never `indexOf`, never
 * substring scanning. This project has shipped three separate defects from
 * deciding structure by string scan (URL-scheme checks broken by
 * `java\nscript:`, CSS sanitizers broken by comment obfuscation, and a
 * `<select>` guard that examined only the first occurrence and shipped a live
 * false-`tampered` verdict). A string scan also cannot distinguish `fetch`
 * in a comment, in a string literal, or as a local identifier from a real
 * global call.
 *
 * The walker inspects `ImportDeclaration`, `ExportDeclaration`, and call /
 * new / property-access / element-access nodes. It surfaces structural
 * decisions as typed `DiscriminativeError` values so the verdict ladder can
 * consume them without an additional parsing pass.
 */

import { type DiscriminativeError } from "../../../shared/contracts/validation";

import ts from "typescript";
import { classifyTsxImport, type TsxImportDenial } from "../../../shared/tsx/import-policy";

/**
 * Codes for the AST walker. Distinct from the import-policy code so the
 * caller can decide per-origin policy (import vs capability) without losing
 * the type tag.
 */
export const TSX_CAPABILITY_CODES = {
  fetch: "tsx_capability_fetch",
  evalCall: "tsx_capability_eval",
  functionConstructor: "tsx_capability_function_constructor",
  dynamicImport: "tsx_capability_dynamic_import",
  worker: "tsx_capability_worker",
  sharedWorker: "tsx_capability_shared_worker",
  unsupportedComputedGlobal: "tsx_capability_computed_global",
} as const;

/**
 * Run the full AST policy over one TSX source. Returns the typed errors
 * discovered. An empty array means the source survived every check.
 *
 * Note: capability checks are deliberately tight. They reject global calls,
 * indirect eval, dynamic `import()`, and worker construction. Obfuscated
 * access via computed property names is either rejected (when the literal
 * fragments concatenate to a denied name) or surfaced as
 * `unsupportedComputedGlobal` so the verdict reports the pattern rather
 * than guessing at intent.
 */
export function validateTsxAst(sourceText: string): readonly DiscriminativeError[] {
  const sourceFile = ts.createSourceFile(
    "artifact.tsx",
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  const errors: DiscriminativeError[] = [];

  for (const statement of sourceFile.statements) {
    collectImportErrors(statement, errors);
    collectExportErrors(statement, errors);
  }

  const localNames = collectLocalNames(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      checkCallExpression(node, errors, localNames);
    } else if (ts.isNewExpression(node)) {
      checkNewExpression(node, errors);
    } else if (ts.isPropertyAccessExpression(node)) {
      checkPropertyAccess(node, errors);
    } else if (ts.isElementAccessExpression(node)) {
      checkElementAccess(node, errors);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return errors;
}

function collectImportErrors(statement: ts.Statement, errors: DiscriminativeError[]): void {
  if (!ts.isImportDeclaration(statement)) return;
  const specifier = statement.moduleSpecifier;
  if (!ts.isStringLiteral(specifier)) return;
  const moduleText = specifier.text;
  const denial = classifyTsxImport(moduleText);
  if (denial !== null) errors.push(denialToError(denial));
}

function collectExportErrors(statement: ts.Statement, errors: DiscriminativeError[]): void {
  if (!ts.isExportDeclaration(statement)) return;
  const specifier = statement.moduleSpecifier;
  if (specifier === undefined) return;
  if (!ts.isStringLiteral(specifier)) return;
  const moduleText = specifier.text;
  const denial = classifyTsxImport(moduleText);
  if (denial !== null) errors.push(denialToError(denial));
}

function denialToError(denial: TsxImportDenial): DiscriminativeError {
  return { code: denial.code, message: denial.message };
}

function locationFor(node: ts.Node, sourceFile: ts.SourceFile): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${line + 1}:${character + 1}`;
}

/**
 * Collect every locally-bound name in the file. A name that shadows a
 * denied global (`fetch`, `eval`) is NOT a global call site when it appears
 * in the source — the user has shadowed it deliberately, and the AST walker
 * must not report a violation for a local identifier that happens to be
 * spelled "fetch".
 *
 * Scope is flattened: we collect function declarations, variable
 * declarations, and parameter names at any depth. This is correct for the
 * artifact surface (single-file TSX, no cross-file rebinding) and avoids a
 * full scope analysis. A local that shadows a global is still locally
 * shadowed when it appears inside a nested function.
 */
function collectLocalNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      names.add(node.name.text);
    }
    if (ts.isFunctionExpression(node) && node.name !== undefined) {
      names.add(node.name.text);
    }
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) names.add(parameter.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function push(
  errors: DiscriminativeError[],
  code: string,
  message: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
): void {
  errors.push({ code, message, location: locationFor(node, sourceFile) });
}

function isDeniedGlobalName(name: string): boolean {
  return name === "fetch";
}

function isDeniedGlobalEval(name: string): boolean {
  return name === "eval";
}

function identifierText(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  return null;
}

/**
 * Match a `CallExpression` against the denied capability set.
 *
 *   - `fetch(...)`                  → `tsx_capability_fetch`
 *   - `eval(...)`, `(0, eval)(...)` → `tsx_capability_eval`
 *   - `import("...")`               → `tsx_capability_dynamic_import`
 */
function checkCallExpression(
  node: ts.CallExpression,
  errors: DiscriminativeError[],
  localNames: ReadonlySet<string>,
): void {
  const sourceFile = node.getSourceFile();

  // Dynamic import: import("...") — the callee carries the `import` keyword.
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

  const expression = node.expression;

  // `fetch(...)` as a global.
  if (
    ts.isIdentifier(expression) &&
    isDeniedGlobalName(expression.text) &&
    !localNames.has(expression.text)
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

  // `(0, eval)(...)` — parenthesized comma sequence: literal 0, identifier `eval`.
  if (ts.isParenthesizedExpression(expression)) {
    const inner = expression.expression;
    if (
      ts.isBinaryExpression(inner) &&
      inner.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      ts.isNumericLiteral(inner.left) &&
      ts.isIdentifier(inner.right) &&
      isDeniedGlobalEval(inner.right.text) &&
      !localNames.has(inner.right.text)
    ) {
      push(
        errors,
        TSX_CAPABILITY_CODES.evalCall,
        `TSX indirect eval "(0, eval)(...)" is not allowed`,
        node,
        sourceFile,
      );
      return;
    }
  }

  // `eval(...)` directly.
  if (
    ts.isIdentifier(expression) &&
    isDeniedGlobalEval(expression.text) &&
    !localNames.has(expression.text)
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

  // `globalThis.fetch(...)`, `window.fetch(...)`, `self.fetch(...)`.
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
      return;
    }
  }
}

/**
 * `new Function(...)`, `new Worker(...)`, `new SharedWorker(...)`.
 */
function checkNewExpression(node: ts.NewExpression, errors: DiscriminativeError[]): void {
  const sourceFile = node.getSourceFile();
  const expression = node.expression;
  if (!ts.isIdentifier(expression)) return;
  const name = expression.text;
  if (name === "Function") {
    push(
      errors,
      TSX_CAPABILITY_CODES.functionConstructor,
      `TSX "new Function(...)" is not allowed`,
      node,
      sourceFile,
    );
    return;
  }
  if (name === "Worker") {
    push(
      errors,
      TSX_CAPABILITY_CODES.worker,
      `TSX "new Worker(...)" is not allowed`,
      node,
      sourceFile,
    );
    return;
  }
  if (name === "SharedWorker") {
    push(
      errors,
      TSX_CAPABILITY_CODES.sharedWorker,
      `TSX "new SharedWorker(...)" is not allowed`,
      node,
      sourceFile,
    );
    return;
  }
}

/**
 * Property access — `globalThis.fetch` (when used as a value, not called).
 * Reject the same names as call checks to keep the surface tight.
 */
function checkPropertyAccess(
  node: ts.PropertyAccessExpression,
  errors: DiscriminativeError[],
): void {
  const sourceFile = node.getSourceFile();
  const target = identifierText(node.expression);
  if (target === null) return;
  if (target !== "globalThis" && target !== "window" && target !== "self" && target !== "global")
    return;
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

/**
 * Computed access — `globalThis["fe" + "tch"](...)`. We try to resolve
 * string-literal and binary-expression fragments that concatenate into a
 * denied name. Anything we cannot resolve cleanly is surfaced as
 * `unsupportedComputedGlobal` so the verdict reports the pattern rather
 * than guessing.
 */
function checkElementAccess(node: ts.ElementAccessExpression, errors: DiscriminativeError[]): void {
  const sourceFile = node.getSourceFile();
  const target = identifierText(node.expression);
  if (target !== "globalThis" && target !== "window" && target !== "self" && target !== "global")
    return;
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
  // Cannot statically resolve the argument — surface the pattern so the
  // verdict reports the unknown rather than silently passing.
  push(
    errors,
    TSX_CAPABILITY_CODES.unsupportedComputedGlobal,
    `TSX computed access on "${target}[...]" cannot be statically resolved; review the artifact`,
    node,
    sourceFile,
  );
}

function formatArgument(node: ts.Expression): string {
  if (ts.isStringLiteral(node)) return JSON.stringify(node.text);
  return "<expression>";
}

/**
 * Try to fold a string-or-binary-expression tree into a single string
 * literal. Returns `null` when the tree contains anything we cannot resolve
 * statically (template expressions, identifiers, function calls).
 */
function resolveStringFragments(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStringFragments(node.left);
    const right = resolveStringFragments(node.right);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}
