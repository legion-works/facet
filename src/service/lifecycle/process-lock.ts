/**
 * Process lock with metadata.
 *
 * The lock file holds a JSON record describing the live service
 * instance: pid, startTime, port, contractVersion. Acquisition is
 * atomic — a missing/empty lock file is claimed via O_EXCL, a present
 * lock is reclaimed only when the recorded pid is dead OR the
 * startTime disagrees with the live process. Live contention surfaces
 * as a typed constraint error so a second service start fails loud.
 *
 * The contract-version field is recorded at acquisition so an upgrade
 * that changes `FACET_SCHEMA_VERSION` cannot silently bind to a stale
 * lock from the previous build.
 */

import { constants as fsConstants } from "node:fs";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { FacetError } from "../../shared/errors/facet-error";
import { FACET_SCHEMA_VERSION } from "../../shared/contracts/envelope";
import { isPidAlive, readPidStartTimeTicks } from "../../shared/util/process";
import { ensureOwnerOnlyDirectory } from "../../shared/util/dir-permissions";

export { isPidAlive, readPidStartTimeTicks };

export interface LockMetadata {
  readonly pid: number;
  readonly startTime: number;
  readonly startTimeTicks?: number | null;
  readonly port: number;
  readonly contractVersion: string;
}

export type AcquireResult = { ok: true; metadata: LockMetadata } | { ok: false; error: FacetError };

const LOCK_RETRY_ATTEMPTS = 5;

const STALE_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isLockStale(metadata: LockMetadata): boolean {
  if (metadata.contractVersion !== FACET_SCHEMA_VERSION) {
    // Cross-version lock: only stale when the recorded pid is dead.
    // A live foreign cross-version pid is still a legitimate owner
    // of its lock — we never reclaim a live peer.
    return !isPidAlive(metadata.pid);
  }
  // Strong signal: the OS-recorded start time for the recorded pid
  // does not match the startTime we have on file. If the pid is dead
  // (or unreadable) and the record is older than the staleness budget,
  // the lock is stale.
  const pidAlive = isPidAlive(metadata.pid);
  if (pidAlive) {
    const osStart = readPidStartTimeTicks(metadata.pid);
    if (osStart === null) {
      // Cannot verify the OS start time; be conservative and treat the
      // lock as LIVE so we never unlink a live foreign pid.
      return false;
    }
    if (metadata.startTimeTicks !== undefined && metadata.startTimeTicks !== null) {
      return osStart !== metadata.startTimeTicks;
    }
    // The recorded startTime is wall-clock ms; compare the age in
    // ms against a coarse staleness budget. If a live pid's recorded
    // startTime is far in the past, this lock is from a previous
    // incarnation of that pid slot and is stale.
    const ageMs = Date.now() - metadata.startTime;
    return ageMs > STALE_LOCK_MAX_AGE_MS;
  }
  // Pid is dead → lock is stale regardless of recorded startTime.
  return true;
}

/**
 * Read the metadata record from `lockPath`. Returns null when the file
 * is missing, unreadable, or not valid JSON — a corrupt lock is treated
 * as "no live owner", so the next acquireLock() call reclaims it.
 */
export function readLockMetadata(lockPath: string): LockMetadata | null {
  if (!existsSync(lockPath)) return null;
  try {
    const text = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(text) as Partial<LockMetadata>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.startTime !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.contractVersion !== "string"
    ) {
      return null;
    }
    const startTimeTicks = typeof parsed.startTimeTicks === "number" ? parsed.startTimeTicks : null;
    return {
      pid: parsed.pid,
      startTime: parsed.startTime,
      ...(startTimeTicks === null ? {} : { startTimeTicks }),
      port: parsed.port,
      contractVersion: parsed.contractVersion,
    };
  } catch {
    return null;
  }
}

/**
 * Atomically write the metadata record. Uses a tmpfile+rename so a
 * crashed write never leaves a half-formed JSON on disk.
 */
export function writeLockMetadata(lockPath: string, metadata: LockMetadata): void {
  const lockDir = dirname(lockPath);
  ensureOwnerOnlyDirectory(lockDir);
  const tmpPath = join(lockDir, `.facet-lock-${crypto.randomUUID()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(metadata), { mode: 0o600 });
  renameSync(tmpPath, lockPath);
}

/**
 * Acquire the process lock. If the lock file is missing, claim it
 * atomically via O_EXCL. If it exists and is stale (pid dead or
 * contract-version mismatch or empty metadata), reclaim. Otherwise
 * return a typed constraint error.
 */
export function acquireLock(lockPath: string, metadata: LockMetadata): AcquireResult {
  ensureOwnerOnlyDirectory(dirname(lockPath));

  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = -1;
    }
    if (fd >= 0) {
      closeSync(fd);
      writeLockMetadata(lockPath, metadata);
      return { ok: true, metadata };
    }

    const existing = readLockMetadata(lockPath);
    if (existing === null) {
      // Lock exists but unparseable: there is no live owner we can
      // verify, so reclaim is safe (no foreign pid to clobber).
      try {
        unlinkSync(lockPath);
      } catch {
        // Someone else raced us; loop will retry.
      }
      continue;
    }

    // Cross-version lock: only reclaim if the recorded owner is dead.
    // A live foreign-pid owner running a different build is still a
    // legitimate owner of its lock — we must not unlink it. Per D3,
    // reclaim requires independent proof of death (kill(pid,0) ESRCH)
    // OR an OS startTime mismatch, never a bare pid inequality.
    if (existing.contractVersion !== metadata.contractVersion) {
      if (!isPidAlive(existing.pid) || isLockStale(existing)) {
        try {
          unlinkSync(lockPath);
        } catch {
          continue;
        }
        continue;
      }
      return {
        ok: false,
        error: new FacetError("constraint", "Another facet service holds the lock", {
          retryable: false,
          details: { pid: existing.pid, port: existing.port, lockPath },
        }),
      };
    }

    // Same-version lock: reclaim ONLY when the recorded pid is dead
    // OR the recorded startTime disagrees with what we can verify for
    // that pid. A pid-mismatch alone is never sufficient — that would
    // let any process clobber a live sibling's lock.
    if (!isPidAlive(existing.pid) || isLockStale(existing)) {
      try {
        unlinkSync(lockPath);
      } catch {
        continue;
      }
      continue;
    }

    return {
      ok: false,
      error: new FacetError("constraint", "Another facet service holds the lock", {
        retryable: false,
        details: { pid: existing.pid, port: existing.port, lockPath },
      }),
    };
  }

  // We've retried the race window; give up with a typed error rather
  // than blocking forever.
  return {
    ok: false,
    error: new FacetError("constraint", "Could not acquire process lock after retries", {
      retryable: false,
      details: { lockPath, attempts: LOCK_RETRY_ATTEMPTS },
    }),
  };
}

export function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
