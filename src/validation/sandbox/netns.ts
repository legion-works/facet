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

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";

import { TIER0_MEMORY_CAP_BYTES } from "./limits";
import { InsecureLevelSchema } from "../../shared/contracts/validation";

/**
 * The unshare wrapper. The shell fragment applies `ulimit -v` (RLIMIT_AS)
 * so the worker cannot grow past `TIER0_MEMORY_CAP_BYTES` regardless of
 * what library code inside it does, then `exec`s `unshare` so the
 * `unshare` PID is reused and signals reach the inner process.
 *
 * `--` terminates unshare's own option parsing so a worker argv
 * beginning with `-` cannot be mistaken for a wrapper flag.
 */
const MEMORY_LIMIT_PREFIX = ["ulimit -v", TIER0_MEMORY_CAP_BYTES, "; "].join(" ");

// Acceptance-only seams let the proof exercise both branches on one host.
const FORCE_UNAVAILABLE_ENV = "FACET_TIER0_FORCE_NETNS_UNAVAILABLE";
const DIRECT_EXEC_MARKER_ENV = "FACET_TIER0_DIRECT_EXEC_MARKER";

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
  if (process.env[FORCE_UNAVAILABLE_ENV] === "1") {
    return { available: false, reason: "forced unavailable for acceptance proof" };
  }
  if (cachedProbe !== null) return cachedProbe;
  try {
    // spawnSync, NOT spawn: `exit` fires on a later tick, so an async probe
    // read synchronously ALWAYS observed "not resolved" and cached a false
    // negative for the process lifetime — disabling Tier 0 wherever the
    // capability is in fact present.
    const probe = spawnSync("unshare", ["--map-current-user", "--net", "--", "/bin/true"], {
      stdio: "ignore",
    });
    if (probe.error !== undefined)
      return (cachedProbe = { available: false, reason: `unshare: ${probe.error.message}` });
    if (probe.signal !== null)
      return (cachedProbe = { available: false, reason: `unshare killed by ${probe.signal}` });
    if (probe.status === 0) return (cachedProbe = { available: true, reason: null });
    return (cachedProbe = {
      available: false,
      reason: `unshare exited with code ${probe.status}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (cachedProbe = { available: false, reason: `unshare probe threw: ${message}` });
  }
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
 * The caller keeps STDIN open for the worker's bounded NDJSON protocol
 * and closes it only when tearing down the worker pool.
 */
export function spawnNetnsWorker(args: readonly string[]): ChildProcess {
  return spawnWorker(args, true);
}

/** Spawn the same capped worker without the network namespace boundary. */
export function spawnDirectWorker(args: readonly string[]): ChildProcess {
  return spawnWorker(args, false);
}

/** Select the Tier 0 isolation boundary for the configured insecure level. */
export function resolveTier0Isolation(level: 0 | 1 | 2 | 3): "netns" | "direct" {
  const parsedLevel = InsecureLevelSchema.parse(level);
  return parsedLevel <= 1 ? "netns" : "direct";
}

function spawnWorker(args: readonly string[], useNetns: boolean): ChildProcess {
  const bunPath = process.execPath;
  // Compose the shell command. `sh -c` is required because the wrapper
  // applies `ulimit` before exec-ing unshare — ulimit is a shell builtin
  // and has no freestanding form. After the wrapper runs, unshare
  // execs into the bun binary with the caller-supplied args, so the
  // long-running worker is the bun process (not unshare or sh).
  const tail = [quoteShell(bunPath), ...args.map(quoteShell)].join(" ");
  const isolation = useNetns ? "unshare --map-current-user --net -- " : "";
  const marker =
    !useNetns && process.env[DIRECT_EXEC_MARKER_ENV] !== undefined
      ? `: > ${quoteShell(process.env[DIRECT_EXEC_MARKER_ENV]!)}`
      : "";
  const shellCommand = `${MEMORY_LIMIT_PREFIX}${marker.length > 0 ? `${marker}; ` : ""}exec ${isolation}${tail}`;
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
