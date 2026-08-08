/**
 * Resolves the PINNED chrome-headless-shell binary and the production
 * netns wrapper. Both paths live behind narrow helpers so the runner
 * never inlines a path string and so the egress penetration harness
 * can share the same lookup logic.
 *
 * The wrapper script (`scripts/launch-netns.sh`) is the egress boundary
 * — `unshare --map-current-user --net --` removes every reachable
 * interface, route, and DNS context from the browser process. A future
 * regression that swaps the wrapper for a plain chromium exec would
 * silently re-enable off-loopback traffic; the harness's CI test would
 * catch that, but the path resolution here is the only place that
 * names the wrapper script.
 *
 * The shell binary is pinned per ADR 0001 D3. The cache layout matches
 * what `puppeteer` writes under `~/.cache/puppeteer/chrome-headless-shell/`.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { TIER1_PINNED_VERSION } from "./limits";

const ENV_PINNED_VERSION = "FACET_TIER1_PINNED_VERSION";
const ENV_CACHE_DIR = "FACET_TIER1_BROWSER_CACHE";

/**
 * A pair of resolved paths the runner hands to puppeteer-core. The
 * wrapper (`executablePath`) is what puppeteer-core actually `exec`s;
 * `binaryPath` records the absolute path to the shell inside the
 * wrapper's argv so a failure diagnostic can cite it.
 */
export interface ResolvedLauncher {
  readonly executablePath: string;
  readonly binaryPath: string;
  readonly pinnedVersion: string;
}

/**
 * Default lookup locations for the cached shell. The cache directory
 * layout matches what `puppeteer browsers install chrome-headless-shell`
 * writes — pinning that layout here means the project does not need
 * its own installer.
 */
function defaultCacheRoot(): string {
  return join(homedir(), ".cache", "puppeteer", "chrome-headless-shell");
}

/** Read an env var or return undefined. */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Probe the cache layout for the pinned shell. Returns null when no
 * candidate file exists; the caller turns that into a typed
 * `tier1_launcher_missing` error.
 */
export function resolveShellBinary(
  overrides: { readonly version?: string; readonly cacheRoot?: string } = {},
): string | null {
  const version = overrides.version ?? readEnv(ENV_PINNED_VERSION) ?? TIER1_PINNED_VERSION;
  const cacheRoot = overrides.cacheRoot ?? readEnv(ENV_CACHE_DIR) ?? defaultCacheRoot();
  const candidates = [
    join(cacheRoot, version, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    join(cacheRoot, `linux-${version}`, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    join(cacheRoot, version, "chrome-headless-shell"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the production netns wrapper script. The wrapper is the
 * only egress boundary — when it is missing, callers surface a typed
 * `tier1_unavailable` instead of falling back to a plain exec.
 */
export function resolveNetnsWrapper(overrides: { readonly wrapperPath?: string } = {}): string {
  const override = overrides.wrapperPath ?? readEnv("FACET_TIER1_NETNS_WRAPPER");
  if (override !== undefined) return override;
  const fromRepo = join(process.cwd(), "scripts", "launch-netns.sh");
  if (existsSync(fromRepo)) return fromRepo;
  const fromSibling = join(import.meta.dir, "..", "..", "..", "scripts", "launch-netns.sh");
  return fromSibling;
}

/**
 * The Puppeteer-compatible browser args. Every flag here is required:
 *
 *   - `--headless=new` selects the modern headless mode that owns the
 *     same renderer as full Chrome.
 *   - `--no-sandbox` is OMITTED — we keep Chromium's browser sandbox
 *     (the netns wrapper passes `--map-current-user` so the user is
 *     not mapped to root, and the renderer retains its sandbox).
 *   - `--no-first-run`, `--disable-background-networking`,
 *     `--disable-component-update`, `--disable-default-apps`,
 *     `--disable-sync` keep first-launch noise and network from
 *     contaminating an isolated run.
 *   - `--user-data-dir=$tmp/...` plus the verifier's profile-mode
 *     (0o700) keeps the on-disk footprint ephemeral.
 *
 * `--single-process --no-zygote` are NOT used. The Phase-0 fidelity
 * spike relied on them to bound the process tree, but the pinned
 * 131.0.6778.204 build aborts the CDP target during `newPage()` when
 * those flags are present (verified empirically against the wrapper).
 * The multi-process model is fine inside an isolated verifier run
 * because every renderer lives under the same netns pid and exits
 * when the wrapper does.
 *
 * CDP transport (`--remote-debugging-pipe`) is added by puppeteer-core
 * itself when `pipe: true` is set on the launch options; the netns
 * wrapper inherits the pipe through `exec`.
 */
export function buildBrowserArgs(userDataDir: string): readonly string[] {
  return [
    "--headless=new",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-features=AutofillServerCommunication,OptimizationHints",
    `--user-data-dir=${userDataDir}`,
  ];
}

/**
 * Resolve every launcher path needed for a single run. Throws a
 * plain `Error` (not `FacetError`) because the verifier is the only
 * caller and maps the error into a typed `tier1_launcher_missing` or
 * `tier1_unavailable` upstream.
 */
export function resolveLauncher(
  overrides: {
    readonly version?: string;
    readonly cacheRoot?: string;
    readonly wrapperPath?: string;
  } = {},
): ResolvedLauncher {
  const binaryPath = resolveShellBinary({
    ...(overrides.version !== undefined ? { version: overrides.version } : {}),
    ...(overrides.cacheRoot !== undefined ? { cacheRoot: overrides.cacheRoot } : {}),
  });
  if (binaryPath === null) {
    throw new Error(
      `pinned chrome-headless-shell ${overrides.version ?? TIER1_PINNED_VERSION} not found in cache`,
    );
  }
  return {
    executablePath: resolveNetnsWrapper(
      overrides.wrapperPath !== undefined ? { wrapperPath: overrides.wrapperPath } : {},
    ),
    binaryPath,
    pinnedVersion: overrides.version ?? TIER1_PINNED_VERSION,
  };
}
