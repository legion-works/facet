import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MAX_LINES = 50;
const ADAPTER_ROOT = resolve(dirname(import.meta.path), "../src/harness-adapters");
const ADAPTER_NAMES = ["opencode/facet.sh", "claude-code/facet.sh", "codex/facet.sh"] as const;
const FORBIDDEN: readonly [RegExp, string][] = [
  [/\b(?:curl|wget|fetch|http:\/\/|https:\/\/)/i, "HTTP or network access"],
  [/\b(?:token|bearer|authorization)\b/i, "token or authorization handling"],
  [/\.db\b|(?:sqlite|database|DB_PATH|FACET_HOME)/i, "database or runtime path handling"],
  [/\bzod\b|\b(?:renderer|render|validation|validator)\b/i, "renderer or validation logic"],
];

export function checkAdapterSource(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  const issues: string[] = [];
  if (lines.length > MAX_LINES)
    issues.push(`${path}: ${lines.length} physical lines (maximum is 50 lines)`);
  for (const [pattern, label] of FORBIDDEN) {
    if (pattern.test(source)) issues.push(`${path}: forbidden ${label}`);
  }
  return issues;
}

export function adapterPaths(root = ADAPTER_ROOT): string[] {
  return ADAPTER_NAMES.map((relative) => join(root, relative));
}

export function verifyAdapters(root = ADAPTER_ROOT): string[] {
  const issues: string[] = [];
  if (!existsSync(root)) return [`${root}: adapter root does not exist`];
  for (const path of adapterPaths(root)) {
    if (!existsSync(path)) issues.push(`${path}: adapter does not exist`);
    else issues.push(...checkAdapterSource(path));
  }
  return issues;
}

export function main(): void {
  const issues = verifyAdapters();
  if (issues.length > 0) {
    for (const issue of issues) console.error(`✗ ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${ADAPTER_NAMES.length} adapters ≤ ${MAX_LINES} lines with CLI-only bodies`);
}

if (import.meta.main) main();
