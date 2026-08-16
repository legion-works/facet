/**
 * TypeScript AST policy for TSX artifacts.
 *
 * This public module keeps the stable import surface while the walker and its
 * capability rules live in focused modules.
 */

import ts from "typescript";

import type { DiscriminativeError } from "../../../shared/contracts/validation";
import { classifyTsxImport, type TsxImportDenial } from "../../../shared/tsx/import-policy";
import {
  checkCallExpression,
  checkElementAccess,
  checkNewExpression,
  checkPropertyAccess,
  checkVariableStatement,
} from "./ast-policy-capabilities";

export { TSX_CAPABILITY_CODES } from "./ast-policy-shared";

export function isShadowedByLocalBinding(node: ts.Identifier): boolean {
  let current: ts.Node = node;
  while (true) {
    const parent = current.parent;
    if (parent === undefined) return false;
    if (
      (ts.isVariableDeclaration(parent) && parent.name === current) ||
      (ts.isFunctionDeclaration(parent) && parent.name === current) ||
      (ts.isParameter(parent) && parent.name === current) ||
      (ts.isBindingElement(parent) && parent.name === current)
    ) {
      return true;
    }
    if (scopeDeclaresName(parent, node.text, node)) return true;
    current = parent;
  }
}

function scopeDeclaresName(scope: ts.Node, name: string, beforeNode: ts.Node): boolean {
  if (
    ts.isFunctionDeclaration(scope) ||
    ts.isFunctionExpression(scope) ||
    ts.isArrowFunction(scope) ||
    ts.isMethodDeclaration(scope) ||
    ts.isConstructorDeclaration(scope) ||
    ts.isGetAccessorDeclaration(scope) ||
    ts.isSetAccessorDeclaration(scope)
  ) {
    for (const param of scope.parameters) {
      if (parameterDeclaresName(param, name)) return true;
    }
    return false;
  }
  if (ts.isCatchClause(scope)) {
    const decl = scope.variableDeclaration;
    if (decl !== undefined && bindingNameMatches(decl.name, name)) return true;
    return false;
  }
  if (ts.isForStatement(scope)) {
    const init = scope.initializer;
    if (init !== undefined && ts.isVariableDeclarationList(init)) {
      for (const decl of init.declarations) {
        if (bindingNameMatches(decl.name, name) && decl.getStart() < beforeNode.getStart())
          return true;
      }
    }
    return false;
  }
  if (ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const init = scope.initializer;
    if (init !== undefined && ts.isVariableDeclarationList(init)) {
      for (const decl of init.declarations) {
        if (bindingNameMatches(decl.name, name)) return true;
      }
    }
    return false;
  }
  let statements: readonly ts.Statement[] | undefined;
  if (ts.isSourceFile(scope)) statements = scope.statements;
  else if (ts.isBlock(scope)) statements = scope.statements;
  else if (ts.isModuleBlock(scope)) statements = scope.statements;
  if (statements === undefined) return false;
  for (const stmt of statements) {
    if (statementDeclaresName(stmt, name, beforeNode)) return true;
  }
  return false;
}

function parameterDeclaresName(param: ts.ParameterDeclaration, name: string): boolean {
  if (param.name === undefined) return false;
  return bindingNameMatches(param.name, name);
}

function statementDeclaresName(stmt: ts.Statement, name: string, beforeNode: ts.Node): boolean {
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (bindingNameMatches(decl.name, name) && decl.getStart() < beforeNode.getStart())
        return true;
    }
    return false;
  }
  if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return true;
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
        if (ts.isIdentifier(spec.name) && spec.name.text === name) return true;
      }
    }
  }
  return false;
}

function bindingNameMatches(pattern: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(pattern)) return pattern.text === name;
  if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (bindingNameMatches(element.name, name)) return true;
    }
  }
  return false;
}

export function validateTsxAst(sourceText: string): readonly DiscriminativeError[] {
  const sourceFile = ts.createSourceFile(
    "artifact.tsx",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const errors: DiscriminativeError[] = [];
  for (const statement of sourceFile.statements) {
    collectImportErrors(statement, errors);
    collectExportErrors(statement, errors);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node))
      checkCallExpression(node, errors, sourceFile, isShadowedByLocalBinding);
    else if (ts.isNewExpression(node))
      checkNewExpression(node, errors, sourceFile, isShadowedByLocalBinding);
    else if (ts.isVariableStatement(node)) checkVariableStatement(node, errors, sourceFile);
    else if (ts.isPropertyAccessExpression(node)) checkPropertyAccess(node, errors, sourceFile);
    else if (ts.isElementAccessExpression(node)) checkElementAccess(node, errors, sourceFile);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return errors;
}

function collectImportErrors(statement: ts.Statement, errors: DiscriminativeError[]): void {
  if (!ts.isImportDeclaration(statement)) return;
  const specifier = statement.moduleSpecifier;
  if (!ts.isStringLiteral(specifier)) return;
  const denial = classifyTsxImport(specifier.text);
  if (denial !== null) errors.push(denialToError(denial));
}

function collectExportErrors(statement: ts.Statement, errors: DiscriminativeError[]): void {
  if (!ts.isExportDeclaration(statement)) return;
  const specifier = statement.moduleSpecifier;
  if (specifier === undefined || !ts.isStringLiteral(specifier)) return;
  const denial = classifyTsxImport(specifier.text);
  if (denial !== null) errors.push(denialToError(denial));
}

function denialToError(denial: TsxImportDenial): DiscriminativeError {
  return { code: denial.code, message: denial.message };
}
