/**
 * Network namespace launcher for the Tier 0 parse worker.
 *
 * The wrapper enforces egress denial by kernel topology, NOT by
 * flagging the artifact: `unshare --map-current-user --net` creates a
 * rootless network namespace in which `lo` is DOWN and no other
 * interface exists. The worker cannot reach any addressable host
 * because there is no route to one — `fetch`, `XMLHttpRequest`,
 * `WebSocket`, raw sockets, WebRTC, and any future IP API all see the
 * same empty namespace.
 *
 * The reference spike at `.facet-build/phase-0-spikes/egress/` proved
 * this candidate blocks 0/12 known browser escape channels on the
 * Chromium build; the same boundary holds for a Bun process.
 *
 * If `unshare` / user namespaces are unavailable in the host
 * environment, `probeNetnsSupport()` returns `false` so callers can
 * surface a typed `tier0_unavailable` error instead of silently
 * running un-sandboxed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";

import { TIER0_MEMORY_CAP_BYTES } from "./limits";

/**
 * The unshare wrapper. The shell fragment applies `ulimit -v` (RLIMIT_AS)
 * so the worker cannot grow past `TIER0_MEMORY_CAP_BYTES` regardless of
 * what library code inside it does, then `exec`s `unshare` so the
 * `unshare` PID is reused and signals reach the inner process.
 *
 * `--` terminates unshare's own option parsing so a worker argv
 * beginning with `-` cannot be mistaken for a wrapper flag.
 */
const NETNS_WRAPPER = [
  "ulimit -v",
  TIER0_MEMORY_CAP_BYTES,
  "; exec unshare --map-current-user --net -- ",
].join(" ");

export interface NetnsProbe {
  /** True iff `unshare --map-current-user --net` is runnable as the current user. */
  readonly available: boolean;
  /**
   * When `available` is `false`, a short reason suitable for an error
   * body — e.g. "unshare: operation not permitted" (user namespaces
   * disabled) or "unshare: not found".
   */
  readonly reason: string | null;
}

/**
 * Run a single `unshare --map-current-user --net -- true` invocation
 * to detect whether rootless user namespaces are enabled in the host.
 * The result is cached per process because the probe itself is
 * expensive and the capability does not change while the service runs.
 */
let cachedProbe: NetnsProbe | null = null;

export function probeNetnsSupport(): NetnsProbe {
  if (cachedProbe !== null) return cachedProbe;
  try {
    const probe = spawn("unshare", ["--map-current-user", "--net", "--", "/bin/true"], {
      stdio: "ignore",
    });
    const outcome = (() => {
      let resolved = false;
      let result: NetnsProbe = { available: false, reason: "unshare probe did not exit" };
      probe.on("error", (error) => {
        resolved = true;
        result = { available: false, reason: `unshare: ${error.message}` };
      });
      probe.on("exit", (code, signal) => {
        resolved = true;
        if (code === 0) result = { available: true, reason: null };
        else if (signal !== null)
          result = { available: false, reason: `unshare killed by ${signal}` };
        else result = { available: false, reason: `unshare exited with code ${code}` };
      });
      return { isResolved: () => resolved, result };
    })();
    if (!outcome.isResolved()) {
      // `exit` should fire synchronously for a successful spawn + /bin/true;
      // if it doesn't, return a conservative unavailable verdict.
      return (cachedProbe = { available: false, reason: "unshare probe did not resolve" });
    }
    return (cachedProbe = outcome.result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (cachedProbe = { available: false, reason: `unshare probe threw: ${message}` });
  }
}

/** Reset the cached probe. Test-only; production code never invalidates it. */
// oxlint-disable-next-line no-underscore-dangle
export function _resetNetnsProbeForTests(): void {
  cachedProbe = null;
}

/**
 * Returns the path to the `unshare` binary, asserting it exists.
 * Surfacing a typed error here (rather than letting `spawn` fail with
 * ENOENT later) gives the parent a single, deterministic
 * `tier0_unavailable` failure mode for "binary missing".
 */
export function resolveUnsharePath(): string {
  const candidates = [
    "/usr/bin/unshare",
    "/bin/unshare",
    "/usr/local/bin/unshare",
    "/home/linuxbrew/.linuxbrew/bin/unshare",
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error("unshare binary not found in known locations");
}

/**
 * Spawn the worker inside a rootless network namespace.
 *
 * The returned `ChildProcess` has STDIN, STDOUT, and STDERR piped so
 * the parent can stream the input payload and parse the bounded
 * result. Memory cap and netns are applied by the wrapper command;
 * wall-clock + output cap are enforced by the parent runner on top of
 * the returned streams.
 *
 * The caller MUST close STDIN after writing the input so the worker
 * observes EOF and exits.
 */
export function spawnNetnsWorker(args: readonly string[]): ChildProcess {
  const bunPath = process.execPath;
  // Build the shell command string. Using `sh -c` because the wrapper
  // needs to apply ulimit BEFORE exec-ing unshare; ulimit is a shell
  // builtin and not exposed as a freestanding command. The final argv
  // we hand unshare is `<bun> <args...>` so the worker is the bun
  // subprocess inside the namespace, not `unshare` itself.
  const tail = [quoteShell(bunPath), ...args.map(quoteShell)].join(" ");
  const shellCommand = `${NETNS_WRAPPER}${tail}`;
  return spawn("/bin/sh", ["-c", shellCommand], {
    stdio: ["pipe", "pipe", "pipe"],
    // Detach from the parent's controlling terminal so SIGINT to the
    // parent does not cascade into the worker.
    detached: false,
    env: {
      ...process.env,
      // Force a deterministic locale so worker diagnostics don't pull
      // in the host's UTF-8 assumptions about error message text.
      LC_ALL: "C.UTF-8",
    },
  });
}

/**
 * Quote a single argv element for the shell command. Single-quotes
 * the value and escapes embedded single quotes; safe for paths and
 * flags that contain no shell metacharacters.
 */
function quoteShell(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9._/=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
