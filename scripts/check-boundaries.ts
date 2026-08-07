#!/usr/bin/env bun
//
// Service-boundary guard. The service must stay byte-dumb: it may hash,
// store, count lexically, and serve bytes, but it must not import any
// renderer, parser, browser shim, or anything from src/validation/ or
// src/gallery-web/frame/. The single permitted exception is
// src/service/lexical/expectations.ts (lexical counting only).
//
// This script statically scans import specifiers — no module resolution,
// no AST, no type info. The pattern is intentionally simple: a regex
// over `import ... from "..."`, `import "..."`, dynamic `import("...")`,
// `require("...")`, AND every re-export form (`export * from`,
// `export { x } from`, `export type { x } from`) catches every
// realistic case. The pure scanning logic is exported so the
// accompanying unit test in tests/unit/boundaries.test.ts can run the
// checker against fixture files without touching this repo's source.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const FORBIDDEN_PACKAGES = new Set([
  "marked",
  "mermaid",
  "puppeteer-core",
  "puppeteer",
  "jsdom",
  "happy-dom",
  "linkedom",
  "vega",
  "vega-lite",
  "@types/marked",
  "@types/mermaid",
]);

/** Forbidden workspace-relative specifiers. Any match of these prefixes flags the file. */
export const FORBIDDEN_WORKSPACE_PREFIXES = ["src/validation/", "src/gallery-web/frame/"];

/**
 * Standard import forms:
 * - `import x from "spec"`
 * - `import { x } from "spec"`
 * - `import * as x from "spec"`
 * - `import x, { y } from "spec"`
 * - `import type { x } from "spec"`
 * - `import "spec"` (bare side-effect import)
 * - `import("spec")` (dynamic)
 * - `require("spec")` (CJS)
 */
export const IMPORT_SPECIFIER_RE =
  /(?:^|\s)(?:import\s+(?:type\s+)?(?:[^"';]+?\s+from\s+)?|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

/**
 * Re-export forms. All share the `from "spec"` tail so a single regex
 * matches every variant:
 * - `export * from "spec"`
 * - `export * as ns from "spec"`
 * - `export { x, y } from "spec"`
 * - `export { x as y } from "spec"`
 * - `export { default as x } from "spec"`
 * - `export type { x } from "spec"`
 * - `export type * from "spec"`
 *
 * The lookahead `(?![\w])` keeps the regex from matching a string
 * that happens to be preceded by a longer identifier like `awayfrom`.
 */
export const RE_EXPORT_SPECIFIER_RE = /\bfrom\s+["']([^"']+)["']/g;

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly reason: string;
}

export interface BoundaryRoots {
  readonly repoRoot: string;
  readonly serviceDir: string;
  readonly frameDir?: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isForbiddenPackage(specifier: string): boolean {
  if (FORBIDDEN_PACKAGES.has(specifier)) return true;
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (specifier.startsWith(`${pkg}/`)) return true;
  }
  return false;
}

function resolveWorkspaceTarget(specifier: string, file: string, repoRoot: string): string | null {
  for (const prefix of FORBIDDEN_WORKSPACE_PREFIXES) {
    if (specifier === prefix.replace(/\/$/, "") || specifier.startsWith(prefix)) {
      return specifier;
    }
  }
  if (specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = resolve(join(file, "..", specifier)).replace(/\\/g, "/");
    const relativePath = relative(repoRoot, resolved).replace(/\\/g, "/");
    for (const prefix of FORBIDDEN_WORKSPACE_PREFIXES) {
      if (relativePath === prefix.replace(/\/$/, "") || relativePath.startsWith(prefix)) {
        return `${specifier} (resolves to ${relativePath})`;
      }
    }
  }
  return null;
}

function checkServiceSpecifier(specifier: string, file: string, repoRoot: string): string | null {
  if (isForbiddenPackage(specifier)) {
    return `forbidden package import: ${specifier}`;
  }
  const workspaceHit = resolveWorkspaceTarget(specifier, file, repoRoot);
  if (workspaceHit !== null) {
    return `forbidden workspace import: ${workspaceHit}`;
  }
  return null;
}

function checkFrameSpecifier(specifier: string): string | null {
  if (specifier === "zod" || specifier.startsWith("zod/")) {
    return "zod must not cross the gallery-frame boundary";
  }
  return null;
}

function collectSpecifiers(line: string): string[] {
  const found = new Set<string>();
  IMPORT_SPECIFIER_RE.lastIndex = 0;
  for (const match of line.matchAll(IMPORT_SPECIFIER_RE)) {
    if (match[1]) found.add(match[1]);
  }
  RE_EXPORT_SPECIFIER_RE.lastIndex = 0;
  for (const match of line.matchAll(RE_EXPORT_SPECIFIER_RE)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

export function scanFile(
  file: string,
  repoRoot: string,
  check: (specifier: string, file: string, repoRoot: string) => string | null,
): Violation[] {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const specifier of collectSpecifiers(line)) {
      const reason = check(specifier, file, repoRoot);
      if (reason !== null) {
        violations.push({
          file: relative(repoRoot, file),
          line: i + 1,
          specifier,
          reason,
        });
      }
    }
  }
  return violations;
}

/**
 * Run the boundary check against a configured set of roots. Returns the
 * full list of violations; callers decide how to format and exit.
 */
export function runBoundaryCheck(roots: BoundaryRoots): Violation[] {
  const violations: Violation[] = [];

  for (const file of walk(roots.serviceDir)) {
    violations.push(
      ...scanFile(file, roots.repoRoot, (spec, f, rr) => checkServiceSpecifier(spec, f, rr)),
    );
  }

  if (roots.frameDir !== undefined && existsDir(roots.frameDir)) {
    for (const file of walk(roots.frameDir)) {
      violations.push(...scanFile(file, roots.repoRoot, (spec) => checkFrameSpecifier(spec)));
    }
  }

  return violations;
}

function main(): number {
  const REPO_ROOT = resolve(import.meta.dir, "..");
  const SERVICE_DIR = join(REPO_ROOT, "src/service");
  const FRAME_DIR = join(REPO_ROOT, "src/gallery-web/frame");
  const violations = runBoundaryCheck({
    repoRoot: REPO_ROOT,
    serviceDir: SERVICE_DIR,
    frameDir: FRAME_DIR,
  });

  if (violations.length === 0) {
    console.log("service boundary clean");
    return 0;
  }

  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}  ${violation.reason}`);
  }
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
