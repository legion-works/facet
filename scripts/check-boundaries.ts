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
// and `require("...")` lines catches every realistic case.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SERVICE_DIR = join(REPO_ROOT, "src/service");
const FRAME_DIR = join(REPO_ROOT, "src/gallery-web/frame");

/**
 * Forbidden package specifiers. The check uses an exact or "starts-with
 * + subpath" match so a hostile addition of `marked/lib/...` is caught.
 */
const FORBIDDEN_PACKAGES = new Set([
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
const FORBIDDEN_WORKSPACE_PREFIXES = ["src/validation/", "src/gallery-web/frame/"];

const IMPORT_SPECIFIER_RE =
  /(?:^|\s)(?:import\s+(?:[^"';]+?\s+from\s+)?|import\(|require\()\s*["']([^"']+)["']/g;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly reason: string;
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

function checkSpecifier(specifier: string, file: string): string | null {
  if (FORBIDDEN_PACKAGES.has(specifier)) {
    return `forbidden package import: ${specifier}`;
  }
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
      return `forbidden package import: ${specifier}`;
    }
  }
  for (const prefix of FORBIDDEN_WORKSPACE_PREFIXES) {
    if (specifier === prefix.replace(/\/$/, "") || specifier.startsWith(prefix)) {
      return `forbidden workspace import: ${specifier}`;
    }
  }
  // Normalize absolute paths to repo-relative for the workspace check.
  if (specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = resolve(join(file, "..", specifier)).replace(/\\/g, "/");
    const relativePath = relative(REPO_ROOT, resolved).replace(/\\/g, "/");
    for (const prefix of FORBIDDEN_WORKSPACE_PREFIXES) {
      if (relativePath === prefix.replace(/\/$/, "") || relativePath.startsWith(prefix)) {
        return `forbidden workspace import: ${specifier} (resolves to ${relativePath})`;
      }
    }
  }
  return null;
}

function scanFile(file: string, check: (spec: string) => string | null): Violation[] {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    IMPORT_SPECIFIER_RE.lastIndex = 0;
    for (const match of line.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = match[1] ?? "";
      const reason = check(specifier);
      if (reason !== null) {
        violations.push({
          file: relative(REPO_ROOT, file),
          line: i + 1,
          specifier,
          reason,
        });
      }
    }
  }
  return violations;
}

function main(): number {
  const violations: Violation[] = [];

  // 1. Service layer: no renderers/parsers/DOM shims/validation/frame.
  for (const file of walk(SERVICE_DIR)) {
    violations.push(...scanFile(file, (spec) => checkSpecifier(spec, file)));
  }

  // 2. Gallery frame: zod is forbidden (this dir is a future bundle;
  // the check still runs so a violation is caught the moment it lands).
  if (existsDir(FRAME_DIR)) {
    for (const file of walk(FRAME_DIR)) {
      violations.push(
        ...scanFile(file, (spec) => {
          if (spec === "zod" || spec.startsWith("zod/")) {
            return "zod must not cross the gallery-frame boundary";
          }
          return null;
        }),
      );
    }
  }

  if (violations.length === 0) {
    console.log("service boundary clean");
    return 0;
  }

  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}  ${violation.reason}`);
  }
  return 1;
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

process.exit(main());
