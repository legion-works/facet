/**
 * TypeScript AST policy for TSX artifacts.
 *
 * D13 of the TSX design: capability rejections (`fetch`, `eval`,
 * `new Function`, dynamic `import()`, worker construction, non-allowlisted
 * imports, and `require()`) MUST be decided from the TypeScript AST — never
 * regex, never `indexOf`, never substring scanning. This project has shipped
 * three separate defects from deciding structure by string scan (URL-scheme
 * checks broken by `java\nscript:`, CSS sanitizers broken by comment
 * obfuscation, and a `<select>` guard that examined only the first
 * occurrence and shipped a live false-`tampered` verdict). A string scan also
 * cannot distinguish `fetch` in a comment, in a string literal, or as a
 * local identifier from a real global call.
 *
 * The walker inspects `ImportDeclaration`, `ExportDeclaration`, call /
 * new / property-access / element-access nodes, and binding declarations
 * (for alias rejection). It surfaces structural decisions as typed
 * `DiscriminativeError` values so the verdict ladder can consume them
 * without an additional parsing pass.
 *
 * ## Limits we accept (and document honestly)
 *
 * Scope tracking walks the AST scope-by-scope; a `function fetch() {}`
 * declared inside `outer()` does NOT shadow a top-level `fetch` reference.
 * Class declarations and `let`/`const` declarations are subject to TDZ
 * rules at runtime, but the AST walker treats any in-scope binding as a
 * shadow because a positive false (rejecting valid code that throws
 * ReferenceError at runtime) is worse than a negative false (accepting
 * code that the user meant to shadow).
 *
 * Alias analysis is shallow: we reject the literal pattern
 * `const X = globalThis`, `const X = Worker`, `const X = Function`,
 * `const X = SharedWorker`, and the property-access equivalents
 * (`const X = globalThis.Worker`, etc.). Anything more indirect
 * (`const g = [globalThis][0]`, `function getG(){return globalThis}`,
 * dynamic computation) is OUT OF SCOPE — the resolver at compile time
 * must also enforce the module allowlist so an alias cannot reach a
 * forbidden module through the bundler.
 *
 * Computed access on a denied target with unresolvable fragments
 * (`globalThis[unknownKey]`) is surfaced as `unsupportedComputedGlobal`
 * so the verdict reports the pattern rather than silently passing.
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
  requireCall: "tsx_capability_require",
  aliasOfDeniedGlobal: "tsx_capability_global_alias",
} as const;

/**
 * Run the full AST policy over one TSX source. Returns the typed errors
 * discovered. An empty array means the source survived every check.
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

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      checkCallExpression(node, errors, sourceFile);
    } else if (ts.isNewExpression(node)) {
      checkNewExpression(node, errors, sourceFile);
    } else if (ts.isVariableStatement(node)) {
      checkVariableStatement(node, errors, sourceFile);
    } else if (ts.isPropertyAccessExpression(node)) {
      checkPropertyAccess(node, errors, sourceFile);
    } else if (ts.isElementAccessExpression(node)) {
      checkElementAccess(node, errors, sourceFile);
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

/**
 * Names that, when assigned to a binding, alias a denied global / constructor.
 * Rejecting the assignment at the binding site closes the simple alias
 * patterns (`const g = globalThis`, `const W = Worker`, `const F = Function`,
 * `const W = globalThis.Worker`, `const F = globalThis.Function`).
 */
const ALIAS_DENIED_NAMES = new Set([
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

function identifierText(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  return null;
}

/**
 * Per-scope binding lookup. The flat-scope shortcut (collect every local name
 * in the file) leaks: a binding declared inside an inner function shadows the
 * top-level reference to the same name even though the inner binding is
 * unreachable from the top level. The correct answer is scope-by-scope: a
 * name is shadowed only when an enclosing scope that is an ANCESTOR of the
 * use declares the name (function/block/source-file).
 */
function isShadowedByLocalBinding(node: ts.Identifier): boolean {
  let current: ts.Node = node;
  while (true) {
    const parent = current.parent;
    if (parent === undefined) return false;

    // The use IS the binding site (e.g., `function f() {}` — `f` here is
    // both the declaration and the AST node we're inspecting). Treat as
    // shadowed only when the parent has a different role.
    if (
      (ts.isVariableDeclaration(parent) && parent.name === current) ||
      (ts.isFunctionDeclaration(parent) && parent.name === current) ||
      (ts.isParameter(parent) && parent.name === current) ||
      (ts.isBindingElement(parent) && parent.name === current)
    ) {
      return true;
    }

    if (isScopeBoundary(parent)) {
      if (scopeDeclaresName(parent, node.text, node)) return true;
    }

    current = parent;
  }
}

function isScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Walk `scope` and report whether it declares `name` in a position that is
 * visible at `beforeNode`. Function declarations are hoisted (anywhere in
 * the scope counts); let / const / class are TDZ-restricted (must precede
 * `beforeNode` in source order); parameters bind for the entire function.
 *
 * Nested scopes are NOT descended into — the caller's
 * `isShadowedByLocalBinding` walks up the scope chain and asks each
 * ancestor in turn.
 */
function scopeDeclaresName(scope: ts.Node, name: string, beforeNode: ts.Node): boolean {
  const statements: readonly ts.Statement[] | undefined =
    ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)
      ? scope.statements
      : undefined;
  if (statements === undefined) return false;
  for (const stmt of statements) {
    if (statementDeclaresName(stmt, name, beforeNode)) return true;
  }
  return false;
}

function statementDeclaresName(stmt: ts.Statement, name: string, beforeNode: ts.Node): boolean {
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (bindingNameMatches(decl.name, name) && decl.getStart() < beforeNode.getStart()) {
        return true;
      }
    }
    return false;
  }
  if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
    return true;
  }
  if (
    ts.isClassDeclaration(stmt) &&
    stmt.name?.text === name &&
    stmt.getStart() < beforeNode.getStart()
  ) {
    return true;
  }
  if (ts.isImportDeclaration(stmt)) {
    const clause = stmt.importClause;
    if (clause === undefined) return false;
    if (clause.name?.text === name) return true;
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const spec of bindings.elements) {
        // The LOCAL name is what binds. `import { useState as fetch }` binds
        // `fetch` even though the imported name is `useState`.
        if (ts.isIdentifier(spec.name) && spec.name.text === name) return true;
      }
    }
    return false;
  }
  return false;
}

function bindingNameMatches(pattern: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(pattern)) return pattern.text === name;
  if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      // `[a, , b]` produces an OmittedExpression which has no `name`; skip it.
      if (ts.isOmittedExpression(element)) continue;
      if (bindingNameMatches(element.name, name)) return true;
    }
  }
  return false;
}

/**
 * Match a `CallExpression` against the denied capability set.
 *
 *   - `fetch(...)`                  → `tsx_capability_fetch`
 *   - `eval(...)`, `(0, eval)(...)` → `tsx_capability_eval`
 *   - `import("...")`               → `tsx_capability_dynamic_import`
 *   - `require("...")`              → `tsx_capability_require`
 */
function checkCallExpression(
  node: ts.CallExpression,
  errors: DiscriminativeError[],
  sourceFile: ts.SourceFile,
): void {
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

  // `require("...")` — CommonJS entrypoint. Nothing in the vendored
  // allowlist uses CommonJS, and `require` is the explicit bypass of the
  // AST-level import check that the resolver layer cannot see (the bundler
  // turns it into a static require at build time, but it is still a
  // side-channel for forbidden packages). Reject outright.
  if (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    !isShadowedByLocalBinding(node.expression)
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

  // `fetch(...)` as a global.
  if (
    ts.isIdentifier(expression) &&
    isDeniedGlobalName(expression.text) &&
    !isShadowedByLocalBinding(expression)
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
      !isShadowedByLocalBinding(inner.right)
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
    !isShadowedByLocalBinding(expression)
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
 *
 * The constructor name is checked against the local-scope shadow chain so a
 * user-defined `class Worker` / `function Worker` does not produce a
 * violation.
 */
function checkNewExpression(
  node: ts.NewExpression,
  errors: DiscriminativeError[],
  sourceFile: ts.SourceFile,
): void {
  const expression = node.expression;
  if (!ts.isIdentifier(expression)) return;
  if (isShadowedByLocalBinding(expression)) return;
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
 * Reject variable bindings whose initializer aliases a denied global or
 * constructor. The patterns are:
 *
 *   `const g = globalThis` (or window / self / global)
 *   `const W = Worker` (or SharedWorker / Function)
 *   `const W = globalThis.Worker` (property-access equivalents)
 *   `const W = window.Worker` / `self.Worker` / `global.Worker`
 *
 * Anything more indirect (`const g = [globalThis][0]`,
 * `function getG(){return globalThis}`, computed) is OUT OF SCOPE — the
 * resolver at compile time enforces the module allowlist so an alias cannot
 * reach a forbidden module through the bundler.
 *
 * Only top-level `const X = …` and `let X = …` patterns are checked. A
 * destructure pattern (`const { Worker } = globalThis`) is NOT covered by
 * this rule and falls through to the scope shadowing logic: the destructured
 * binding shadows the global at the use site.
 */
function checkVariableStatement(
  node: ts.VariableStatement,
  errors: DiscriminativeError[],
  sourceFile: ts.SourceFile,
): void {
  for (const declaration of node.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) continue;
    if (declaration.initializer === undefined) continue;
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
    if (target === null) return false;
    if (!ALIAS_DENIED_NAMES.has(target)) return false;
    return ALIAS_DENIED_NAMES.has(init.name.text);
  }
  return false;
}

/**
 * Property access — `globalThis.fetch` (when used as a value, not called).
 * Reject the same names as call checks to keep the surface tight.
 */
function checkPropertyAccess(
  node: ts.PropertyAccessExpression,
  errors: DiscriminativeError[],
  sourceFile: ts.SourceFile,
): void {
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
function checkElementAccess(
  node: ts.ElementAccessExpression,
  errors: DiscriminativeError[],
  sourceFile: ts.SourceFile,
): void {
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
