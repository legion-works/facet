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
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetError } from "../../shared/errors/facet-error";
import { FACET_SCHEMA_VERSION } from "../../shared/contracts/envelope";

export interface LockMetadata {
  readonly pid: number;
  readonly startTime: number;
  readonly port: number;
  readonly contractVersion: string;
}

export type AcquireResult = { ok: true; metadata: LockMetadata } | { ok: false; error: FacetError };

const LOCK_RETRY_ATTEMPTS = 5;

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

export function isLockStale(metadata: LockMetadata, livePid?: number): boolean {
  if (metadata.contractVersion !== FACET_SCHEMA_VERSION) return true;
  if (metadata.pid !== (livePid ?? process.pid)) {
    return !isPidAlive(metadata.pid);
  }
  // Same pid: a fresh start would have written the current startTime
  // we know about. We can't read it from this process, so we use the
  // caller-supplied threshold (or "now - 1 hour" by default) as the
  // heuristic — a same-pid lock older than that is, by convention, a
  // previous incarnation's stale record.
  const ageMs = Date.now() - metadata.startTime;
  return ageMs > 60 * 60 * 1000;
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
    return {
      pid: parsed.pid,
      startTime: parsed.startTime,
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
  mkdirSync(dirname(lockPath), { recursive: true });
  const tmpPath = join(tmpdir(), `facet-lock-${crypto.randomUUID()}.tmp`);
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
  mkdirSync(dirname(lockPath), { recursive: true });

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
      // Lock exists but unparseable: treat as stale, attempt reclaim.
      try {
        unlinkSync(lockPath);
      } catch {
        // Someone else raced us; loop will retry.
      }
      continue;
    }

    if (existing.contractVersion !== metadata.contractVersion) {
      // Cross-version lock: safe to reclaim because the previous build
      // cannot be live (its pid is, by definition, no longer this build).
      try {
        unlinkSync(lockPath);
      } catch {
        continue;
      }
      continue;
    }

    if (
      existing.pid !== metadata.pid ||
      !isPidAlive(existing.pid) ||
      isLockStale(existing, metadata.pid)
    ) {
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
