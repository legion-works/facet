import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname } from "node:path";

export const FORMAT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".json",
  ".jsonc",
  ".js",
  ".jsx",
  ".md",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

export interface FormatCheckDeps {
  readonly trackedPaths: () => readonly string[];
  readonly pathExists: (path: string) => boolean;
  readonly invoke: (paths: readonly string[]) => number;
}

export function selectFormatPaths(
  paths: readonly string[],
  pathExists: (path: string) => boolean = existsSync,
): string[] {
  return [...new Set(paths)].filter(
    (path) => FORMAT_EXTENSIONS.has(extname(path).toLowerCase()) && pathExists(path),
  );
}

const defaultDeps: FormatCheckDeps = {
  trackedPaths: () =>
    execFileSync("git", ["ls-files", "-z"]).toString().split("\0").filter(Boolean),
  pathExists: existsSync,
  invoke: (paths) => spawnSync("oxfmt", ["--check", ...paths], { stdio: "inherit" }).status ?? 1,
};

export function runFormatCheck(
  args: readonly string[] = process.argv.slice(2),
  deps: FormatCheckDeps = defaultDeps,
): number {
  const explicit = args.filter((path) => path !== "--");
  const candidates = selectFormatPaths(
    explicit.length === 0 ? deps.trackedPaths() : explicit,
    deps.pathExists,
  );
  return candidates.length === 0 ? 0 : deps.invoke(candidates);
}

if (import.meta.main) process.exitCode = runFormatCheck();
