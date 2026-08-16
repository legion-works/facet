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

/**
 * External packages `src/service/**` MAY import. This is an ALLOWLIST, and the
 * direction is the point.
 *
 * A denylist of known renderers can only reject what someone remembered to
 * list, so every dependency added after the list was written escapes it
 * silently — and the guard reporting "clean" is precisely why nobody re-checks.
 * Proven, not theorised: with the old denylist in place, `src/service/` could
 * `import { XMLParser } from "fast-xml-parser"` — a real XML parser, in the
 * component whose defining rule is that it does not parse — and the guard
 * printed "service boundary clean" and exited 0.
 *
 * Inverting it makes the check enforce the PROPERTY (the service touches only
 * bytes, storage, and crypto) instead of a snapshot of one afternoon's package
 * list. A new dependency now fails closed and has to be justified here.
 */
export const SERVICE_ALLOWED_PACKAGES = new Set(["bun:sqlite", "zod"]);

/** Node builtins the service may use — filesystem, crypto, path, process. */
export const SERVICE_ALLOWED_BUILTIN_PREFIX = "node:";

/**
 * Retained for the explicit-diagnostic path and the unit test: these names get
 * a targeted "forbidden package" message rather than the generic allowlist
 * rejection. Being absent from this set no longer implies a package is allowed.
 */
export const FORBIDDEN_PACKAGES = new Set([
  "marked",
  "mermaid",
  "puppeteer-core",
  "puppeteer",
  "jsdom",
  "happy-dom",
  "linkedom",
  "parse5",
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
 * Dynamic `import(\`spec\`)` / `require(\`spec\`)` forms using a template
 * literal instead of a quoted string. Static `import`/`export ... from`
 * declarations cannot take a template literal (syntax error), so only the
 * two dynamic call forms need this second pattern.
 *
 * A no-substitution literal (no `${`) is a real, known specifier and is
 * treated exactly like a quoted string. A literal WITH a `${` substitution
 * is not staticaly resolvable at all — rather than silently letting it
 * through unclassified, this fails closed: `collectSpecifiers` reports it as
 * an unconditional violation regardless of what the substituted value might
 * be, because a scanner that can't classify a dynamic specifier must not
 * treat that as evidence of safety.
 */
export const DYNAMIC_TEMPLATE_SPECIFIER_RE = /(?:import\s*\(|require\s*\()\s*`([^`]*)`/g;

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

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

function checkServiceSpecifier(specifier: string, file: string, repoRoot: string): string | null {
  if (isForbiddenPackage(specifier)) {
    return `forbidden package import: ${specifier}`;
  }
  // Fail CLOSED on anything external that is not explicitly allowed. Relative
  // specifiers fall through to the workspace check below, which owns them.
  if (!isRelativeSpecifier(specifier)) {
    const isBuiltin = specifier.startsWith(SERVICE_ALLOWED_BUILTIN_PREFIX);
    if (!isBuiltin && !SERVICE_ALLOWED_PACKAGES.has(specifier)) {
      const base = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : (specifier.split("/")[0] ?? specifier);
      if (!SERVICE_ALLOWED_PACKAGES.has(base)) {
        return `package not on the service allowlist: ${specifier} (the service is byte-dumb \u2014 add it to SERVICE_ALLOWED_PACKAGES only if it neither renders nor parses)`;
      }
    }
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

/**
 * Strip line comments and the leading `*` of a block-comment body before
 * scanning. Prose routinely contains `from "..."` (e.g. a doc comment reading
 * `distinguishes "no host" from "wrong host"`), which the re-export regex reads
 * as an import specifier. The old denylist hid this — prose never happens to
 * name `mermaid` — so the weakness only surfaced when the check was inverted to
 * fail closed. A scanner that reads comments as code is a false-positive
 * generator, and a guard people learn to override is worse than no guard.
 */
function stripComments(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  const lineComment = line.indexOf("//");
  return lineComment === -1 ? line : line.slice(0, lineComment);
}

interface CollectedSpecifiers {
  /** Statically known specifiers — quoted strings and no-substitution template literals. */
  readonly literal: string[];
  /** Template literals with a `${` substitution: unresolvable, flagged unconditionally. */
  readonly unclassifiable: string[];
}

function collectSpecifiers(rawLine: string): CollectedSpecifiers {
  const line = stripComments(rawLine);
  const literal = new Set<string>();
  const unclassifiable = new Set<string>();
  IMPORT_SPECIFIER_RE.lastIndex = 0;
  for (const match of line.matchAll(IMPORT_SPECIFIER_RE)) {
    if (match[1]) literal.add(match[1]);
  }
  RE_EXPORT_SPECIFIER_RE.lastIndex = 0;
  for (const match of line.matchAll(RE_EXPORT_SPECIFIER_RE)) {
    if (match[1]) literal.add(match[1]);
  }
  DYNAMIC_TEMPLATE_SPECIFIER_RE.lastIndex = 0;
  for (const match of line.matchAll(DYNAMIC_TEMPLATE_SPECIFIER_RE)) {
    const body = match[1] ?? "";
    if (body.includes("${")) {
      unclassifiable.add(match[0].trim());
    } else {
      literal.add(body);
    }
  }
  return { literal: [...literal], unclassifiable: [...unclassifiable] };
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
    const collected = collectSpecifiers(line);
    for (const specifier of collected.literal) {
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
    for (const raw of collected.unclassifiable) {
      violations.push({
        file: relative(repoRoot, file),
        line: i + 1,
        specifier: raw,
        reason:
          "unclassifiable dynamic specifier: template literal with a ${} substitution cannot be statically resolved — failing closed",
      });
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

export function main(): number {
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
