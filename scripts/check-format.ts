import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";

export const FORMATTER_EXECUTABLE = resolve("node_modules/.bin/oxfmt");

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

// Machine-generated files whose formatting belongs to the tool that emits them.
// release-please rewrites CHANGELOG.md on every release, so formatting it here
// would fail each release PR until a human reformatted output they do not own.
export const GENERATED_PATHS = new Set(["CHANGELOG.md"]);

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
    (path) =>
      FORMAT_EXTENSIONS.has(extname(path).toLowerCase()) &&
      !GENERATED_PATHS.has(path) &&
      pathExists(path),
  );
}

const defaultDeps: FormatCheckDeps = {
  trackedPaths: () =>
    execFileSync("git", ["ls-files", "-z"]).toString().split("\0").filter(Boolean),
  pathExists: existsSync,
  invoke: (paths) =>
    spawnSync(FORMATTER_EXECUTABLE, ["--check", ...paths], { stdio: "inherit" }).status ?? 1,
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
