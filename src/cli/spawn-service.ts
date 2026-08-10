/**
 * Lazy service spawn.
 *
 * First cold CLI call reads the validated service metadata record
 * written by `startFacetService` (see
 * `src/service/lifecycle/process-lock.ts`). If the record is absent
 * or stale, the spawner reaps the stale lock and forks a DETACHED
 * `bun run src/service/main.ts` child carrying the same `FACET_HOME`
 * so the child sees the same paths the parent did.
 *
 * Concurrency: a single in-process `inflight` Promise is shared
 * across every cold caller. The Promise resolves only when the
 * metadata record reports a live, contract-version-matching service
 * (poll-with-deadline — never a fixed sleep). A second caller that
 * arrives while the first is waiting joins the SAME Promise, so
 * 20 concurrent cold calls result in exactly ONE spawn and ONE
 * metadata record on disk.
 *
 * The child is started with `child_process.spawn` detached + `unref`,
 * so the parent can exit without leaving the service as a zombie;
 * the service owns its own lifecycle via the idle controller.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { unlinkSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import { FACET_SCHEMA_VERSION } from "../shared/contracts/envelope";
import { isLockStale, readLockMetadata } from "../service/lifecycle/process-lock";
import { computeFacetPaths, type FacetRuntimePaths } from "../shared/config/paths";
import { isPidAlive } from "../service/lifecycle/process-lock";
import type { LockMetadata } from "../service/lifecycle/process-lock";

import {
  contractMismatchError,
  readInstallToken,
  readLiveMetadata,
  waitForReady,
} from "./service-metadata";

export interface SpawnServiceOptions {
  readonly env: NodeJS.ProcessEnv;
  /** Override the runtime paths; defaults to `computeFacetPaths(env)`. */
  readonly paths?: FacetRuntimePaths;
  /** Override the service entrypoint (default: `src/service/main.ts`). */
  readonly entrypoint?: string;
  /** Override the bun binary (default: `process.execPath`). */
  readonly bunPath?: string;
  /** Polling deadline in ms (default: 15000). */
  readonly readyTimeoutMs?: number;
  /** Poll interval in ms (default: 25). */
  readonly pollIntervalMs?: number;
  /** Override the service idle window; used by lifecycle probes and tests. */
  readonly idleTimeoutMs?: number;
  /**
   * Override the Tier 0 runner module path. Defaults to
   * `src/validation/tier0/runner.ts` resolved relative to this file.
   * The CLI owns this path because only the CLI may import the
   * validation module directly; the service child dynamic-imports
   * the path passed here.
   */
  readonly tier0RunnerPath?: string;
  /** Override the Tier 1 runner module path for insecure boots. */
  readonly tier1RunnerPath?: string;
}

/**
 * Test-side hooks. The `onServiceSpawn` callback fires once per
 * REAL `child_process.spawn` call in the cold-start path; the
 * concurrency test counts these to assert that 20 concurrent
 * cold callers result in exactly ONE spawn (not 20). The
 * `bypassInflight` flag skips the in-process inflight wait map
 * so the test can prove the "exactly one" assertion is meaningful
 * (with bypass on, the same 20 callers produce 20 spawns).
 */
export interface ServiceHooks {
  readonly onServiceSpawn?: (argv?: readonly string[]) => void;
  readonly bypassInflight?: boolean;
}

export interface ResolvedService {
  readonly metadata: LockMetadata;
  readonly installToken: string;
  readonly baseUrl: string;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

/**
 * One-process registry of in-flight spawn waits. The CLI is
 * short-lived (one invocation per process), so the table holds at
 * most ONE entry at a time in practice. The map exists so the
 * test that races 20 cold callers can observe the join path:
 * callers 2..N must NOT acquire the lock or fork a new process.
 */
const inflight = new Map<string, Promise<ResolvedService>>();

/**
 * Spawn the service as a detached child. The child inherits
 * `FACET_HOME` so its paths match the parent's; the parent passes
 * the same paths on the command line so a future change to
 * `computeFacetPaths` cannot desync parent and child.
 */
function spawnChild(
  paths: FacetRuntimePaths,
  options: SpawnServiceOptions,
  onSpawn?: (argv?: readonly string[]) => void,
): ChildProcess {
  const bunPath = options.bunPath ?? process.execPath;
  const entrypoint = options.entrypoint ?? resolvePath(import.meta.dir, "..", "service", "main.ts");
  const facetHome = paths.database
    ? resolvePath(dirname(dirname(dirname(paths.database))))
    : (options.env.FACET_HOME ?? "");
  const childEnv: NodeJS.ProcessEnv = {
    ...options.env,
    FACET_HOME: facetHome,
  };
  // The CLI owns the concrete path to the Tier 0 runner module; the
  // service child dynamic-imports this path so the service's static
  // boundary check stays clean (no `import "../validation/..."`).
  const tier0RunnerPath = options.tier0RunnerPath ?? resolveDefaultTier0RunnerPath();
  // Pass per-path overrides as flags so the child does not have to
  // recompute paths from FACET_HOME; this keeps parent + child
  // identical even when an operator sets XDG_* vars.
  const args = [
    entrypoint,
    "--db-path",
    paths.database,
    "--install-token-path",
    paths.token.replace(/promote\.token$/, "install.token"),
    "--promote-token-path",
    paths.token,
    "--lock-path",
    paths.lock,
    "--tier0-runner-path",
    tier0RunnerPath,
  ];
  if (["1", "2", "3"].includes(options.env.FACET_INSECURE ?? "")) {
    args.push("--tier1-runner-path", options.tier1RunnerPath ?? resolveDefaultTier1RunnerPath());
  }
  if (options.idleTimeoutMs !== undefined) {
    args.push("--idle-timeout-ms", String(options.idleTimeoutMs));
  }
  onSpawn?.(args);
  return spawn(bunPath, args, {
    env: childEnv,
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });
}

/**
 * Default Tier 0 runner module path. Resolved relative to this file
 * (which lives in `src/cli/`) so the import is `../validation/tier0/runner`.
 * Callers can override via `SpawnServiceOptions.tier0RunnerPath` for
 * tests or for custom builds.
 */
function resolveDefaultTier0RunnerPath(): string {
  return resolvePath(import.meta.dir, "..", "validation", "tier0", "runner.ts");
}

function resolveDefaultTier1RunnerPath(): string {
  return resolvePath(import.meta.dir, "..", "validation", "tier1", "runner.ts");
}

/**
 * Reap a stale lock whose owner is dead, so the spawn path can
 * fork a fresh service. Best-effort: a parallel cold start may
 * race and either win the lock or retry; both outcomes are safe.
 */
function reapStaleLock(lockPath: string): void {
  const existing = readLockMetadata(lockPath);
  if (existing === null) return;
  if (isPidAlive(existing.pid) && !isLockStale(existing)) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // ignore — a parallel cold start will retry.
  }
}

/**
 * Cold-start: fork the child + wait for ready. Throws typed
 * `FacetError` on contract-mismatch and on ready-timeout.
 *
 * The CLI does NOT call `acquireLock` under its own pid — that
 * would be a foreign-pid lock the child could never reclaim without
 * killing the parent. Instead the CLI reaps a stale lock and forks
 * the child, which acquires the lock on its own startup path via
 * `startFacetService`.
 *
 * The `onServiceSpawn` hook fires once before each real
 * `child_process.spawn` call; the concurrency test uses it to
 * assert that 20 concurrent cold callers produce exactly ONE
 * spawn (not 20).
 */
async function coldStart(
  options: SpawnServiceOptions,
  hooks: ServiceHooks = {},
): Promise<ResolvedService> {
  const env = options.env.FACET_HOME !== undefined ? { facetHome: options.env.FACET_HOME } : {};
  const paths = options.paths ?? computeFacetPaths(env);
  reapStaleLock(paths.lock);
  // Pre-spawn guard: a live same-version foreign-pid owner means a
  // peer service is already running. The CLI joins that peer via
  // the metadata record instead of forking a second instance.
  const precheck = readLockMetadata(paths.lock);
  if (precheck !== null && isPidAlive(precheck.pid) && !isLockStale(precheck)) {
    if (precheck.contractVersion !== FACET_SCHEMA_VERSION) {
      throw contractMismatchError(precheck);
    }
    return {
      metadata: precheck,
      installToken: readInstallToken(paths),
      baseUrl: `http://127.0.0.1:${precheck.port}`,
    };
  }
  const child = spawnChild(paths, options, hooks.onServiceSpawn);
  // Detach the child from the parent's lifecycle — when the CLI
  // exits, the service keeps running until its idle window closes.
  child.unref();
  void child;
  const meta = await waitForReady(
    paths,
    options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  return {
    metadata: meta,
    installToken: readInstallToken(paths),
    baseUrl: `http://127.0.0.1:${meta.port}`,
  };
}

/**
 * Ensure a live, contract-version-matching service is running. If
 * one is already running, return its info; if not, lazily start one
 * and share the wait across concurrent callers.
 *
 * Returns the resolved service's baseUrl, metadata, and install
 * token. Throws typed `FacetError` on contract-version mismatch
 * and on the ready deadline.
 */
export async function ensureService(
  options: SpawnServiceOptions,
  hooks: ServiceHooks = {},
): Promise<ResolvedService> {
  const env = options.env.FACET_HOME !== undefined ? { facetHome: options.env.FACET_HOME } : {};
  const paths = options.paths ?? computeFacetPaths(env);
  const key = paths.lock;

  // Fast path: a usable same-version record already exists.
  const live = readLiveMetadata(paths);
  if (live !== null) {
    return {
      metadata: live,
      installToken: readInstallToken(paths),
      baseUrl: `http://127.0.0.1:${live.port}`,
    };
  }

  // Cross-version fast path: record exists but the contract does not
  // match. Surface the typed mismatch — the CLI must NOT talk to a
  // service built against a different schema.
  const raw = readLockMetadata(paths.lock);
  if (raw !== null) {
    if (raw.contractVersion !== FACET_SCHEMA_VERSION) {
      throw contractMismatchError(raw);
    }
    // Same-version but stale (dead pid): fall through to the cold
    // path so a fresh service replaces it.
  }

  // Concurrent-caller fast path: another caller in this process is
  // already spawning. Join the same wait. `bypassInflight` is a
  // test-only flag that disables this join so the concurrency
  // test can prove the join path is doing real work.
  if (!hooks.bypassInflight) {
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
  }

  // Cold path: become the spawner.
  const promise = coldStart(options, hooks).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}
