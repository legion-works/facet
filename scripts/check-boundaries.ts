#!/usr/bin/env bun
//
// Service-boundary guard. The service must stay byte-dumb: it may hash,
// store, count lexically, and serve bytes, but it must not import any
// renderer, parser, browser shim, or anything from src/validation/ or
// src/gallery-web/frame/. The single permitted exception is
// src/service/lexical/expectations.ts (lexical counting only).
//
// This script statically scans import specifiers — no module resolution,
// no AST, no type info. The scan runs over each file's WHOLE TEXT (not
// line-by-line): a per-line scan missed any import/require call whose
// specifier was split across lines by legal formatting (a multiline
// backtick dynamic import, or `} from` on its own line), because the
// regex needs the opening `import(`/`require(` and its literal argument
// on the same scanned unit. Comments are stripped file-wide (multi-line
// block comments included) before scanning, and match offsets are mapped
// back to line numbers for reporting.

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
 * Static import/export literal forms only (dynamic `import(`/`require(`
 * calls are handled separately by `DYNAMIC_CALL_RE`, which fails closed on
 * any non-literal argument instead of silently matching only the quoted
 * case):
 * - `import x from "spec"`
 * - `import { x } from "spec"`
 * - `import * as x from "spec"`
 * - `import x, { y } from "spec"`
 * - `import type { x } from "spec"`
 * - `import "spec"` (bare side-effect import)
 */
export const STATIC_IMPORT_SPECIFIER_RE =
  /(?:^|\s)import\s+(?:type\s+)?(?:[\s\S]+?\s+from\s+)?["']([^"']+)["']/g;

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
 */
export const RE_EXPORT_SPECIFIER_RE = /\bfrom\s+["']([^"']+)["']/g;

/**
 * Every dynamic `import(...)` / `require(...)` call, capturing its raw
 * argument text verbatim (including newlines — the non-greedy `[\s\S]*?`
 * stops at the first `)`, which is a known limitation for an argument that
 * itself contains parens, e.g. `import(path.join(a, b))`; the truncated
 * capture then fails `classifyDynamicArg`'s literal check and is reported
 * as unclassifiable, which is the safe direction to be wrong in).
 *
 * `classifyDynamicArg` below decides, per match, whether the argument is:
 *   - a literal specifier (quoted string, or a template literal with no
 *     `${` substitution) — folded into the same package/workspace checks
 *     as a static import;
 *   - unclassifiable — a `${}` substitution, a bare identifier, string
 *     concatenation, a function call, anything that is not a plain
 *     literal — and fails closed as a violation UNLESS the exact call site
 *     is on `DYNAMIC_RUNNER_INJECTION_ALLOWANCE` below.
 */
export const DYNAMIC_CALL_RE = /\b(?:import|require)\s*\(\s*([\s\S]*?)\)/g;

/**
 * The service's ONE deliberate variable-path dynamic import:
 * `src/service/main.ts` loads the Tier 0/1 runner module from a
 * CLI-supplied path (`--tier0-runner-path` / `--tier1-runner-path`)
 * because the concrete runner lives in `src/validation/**` and the CLI is
 * the only place that knows which module to load — the service process
 * never hardcodes that import.
 *
 * This is scoped to the exact (file, identifier) pair, not a blanket
 * "variable dynamic imports are fine" rule: a new variable-path dynamic
 * import anywhere else in `src/service/**`, or a renamed identifier at
 * this same call site, still fails closed. Checked BEFORE assuming this
 * is safe: `main.ts:143,169` are the only two dynamic-import call sites
 * with a non-literal argument under `src/service/`.
 */
export const DYNAMIC_RUNNER_INJECTION_ALLOWANCE: ReadonlyArray<{
  readonly file: string;
  readonly identifier: string;
}> = [{ file: "src/service/main.ts", identifier: "dynamicPath" }];

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
 * Blank out `/* ... *\/` and `// ...` comments across the WHOLE file,
 * replacing every stripped character with a space (newlines are kept as
 * newlines) so character offsets — and therefore line numbers computed
 * from them — stay identical to the original text. Prose inside a
 * multi-line block comment routinely contains `from "..."` (e.g. a doc
 * comment reading `distinguishes "no host" from "wrong host"`), which the
 * re-export regex would otherwise read as an import specifier; scanning
 * the raw text line-by-line and only recognizing a block comment when
 * each line happened to start with `*` missed exactly that case for any
 * differently formatted block comment, and missed a dynamic import split
 * across lines entirely (the opening `import(` and its literal argument
 * never shared a line to match against).
 *
 * Known limitation, unchanged from the prior per-line stripper: this is
 * not string-aware, so a `//` or `/*` inside a string literal (e.g. a URL)
 * would be misread as a comment start. Acceptable for a lexical guard —
 * over-stripping can only hide a legitimate import behind a false
 * "comment", not let a real bypass through.
 */
function stripCommentsWholeFile(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let j = i; j < stop; j += 1) out += text[j] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** 1-based line number for a character offset into `text`. */
function lineForOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

interface DynamicArgClassification {
  readonly kind: "literal" | "unclassifiable";
  readonly value: string;
}

/**
 * Classify a dynamic `import(...)`/`require(...)` call's raw argument
 * text. A plain quoted string, or a template literal with no `${`
 * substitution, is a literal specifier — everything else (a `${}`
 * substitution, a bare identifier, a concatenation, a nested call) cannot
 * be statically resolved and is reported as unclassifiable so the caller
 * fails closed on it.
 */
function classifyDynamicArg(raw: string): DynamicArgClassification {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^["']([^"']*)["']$/);
  if (quoted) return { kind: "literal", value: quoted[1] ?? "" };
  const backtick = trimmed.match(/^`([^`]*)`$/);
  if (backtick) {
    const body = backtick[1] ?? "";
    if (body.includes("${")) return { kind: "unclassifiable", value: trimmed };
    return { kind: "literal", value: body };
  }
  return { kind: "unclassifiable", value: trimmed };
}

export function scanFile(
  file: string,
  repoRoot: string,
  check: (specifier: string, file: string, repoRoot: string) => string | null,
  // Fail-closed reporting for a dynamic import()/require() argument that
  // is NOT a static literal only applies where it is meaningful: the
  // service boundary, which must not silently gain a renderer/parser
  // dependency through an unresolvable specifier. Literal (quoted or
  // no-substitution backtick) dynamic-import arguments are still checked
  // either way. The gallery-frame scan's `checkFrameSpecifier` only cares
  // about `zod` crossing the boundary, and frame code has legitimate
  // runtime-variable dynamic imports (e.g. blob-URL tsx module loading)
  // that are not the byte-dumb-service risk this defends against.
  failClosedOnUnclassifiableDynamic = true,
): Violation[] {
  const raw = readFileSync(file, "utf8");
  const stripped = stripCommentsWholeFile(raw);
  const relativeFile = relative(repoRoot, file).replace(/\\/g, "/");
  const violations: Violation[] = [];
  // `import x from "spec"` matches BOTH the static-import regex and the
  // generic `from "spec"` re-export regex (its text literally contains a
  // `from "spec"` clause). Both matches end at the same offset — the
  // closing quote — for the same clause, so dedupe on end offset instead
  // of reporting the same specifier twice.
  const reportedEndOffsets = new Set<number>();

  const pushLiteral = (specifier: string, offset: number, endOffset: number): void => {
    if (reportedEndOffsets.has(endOffset)) return;
    reportedEndOffsets.add(endOffset);
    const reason = check(specifier, file, repoRoot);
    if (reason !== null) {
      violations.push({
        file: relativeFile,
        line: lineForOffset(stripped, offset),
        specifier,
        reason,
      });
    }
  };

  STATIC_IMPORT_SPECIFIER_RE.lastIndex = 0;
  for (const match of stripped.matchAll(STATIC_IMPORT_SPECIFIER_RE)) {
    if (match[1] !== undefined) pushLiteral(match[1], match.index, match.index + match[0].length);
  }
  RE_EXPORT_SPECIFIER_RE.lastIndex = 0;
  for (const match of stripped.matchAll(RE_EXPORT_SPECIFIER_RE)) {
    if (match[1] !== undefined) pushLiteral(match[1], match.index, match.index + match[0].length);
  }

  DYNAMIC_CALL_RE.lastIndex = 0;
  for (const match of stripped.matchAll(DYNAMIC_CALL_RE)) {
    const classification = classifyDynamicArg(match[1] ?? "");
    const endOffset = match.index + match[0].length;
    if (classification.kind === "literal") {
      pushLiteral(classification.value, match.index, endOffset);
      continue;
    }
    if (!failClosedOnUnclassifiableDynamic) continue;
    if (reportedEndOffsets.has(endOffset)) continue;
    reportedEndOffsets.add(endOffset);
    const allowed = DYNAMIC_RUNNER_INJECTION_ALLOWANCE.some(
      (entry) => entry.file === relativeFile && entry.identifier === classification.value,
    );
    if (allowed) continue;
    violations.push({
      file: relativeFile,
      line: lineForOffset(stripped, match.index),
      specifier: classification.value,
      reason:
        "unclassifiable dynamic specifier: import()/require() argument is not a static literal and cannot be resolved \u2014 failing closed",
    });
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
      violations.push(
        ...scanFile(file, roots.repoRoot, (spec) => checkFrameSpecifier(spec), false),
      );
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
