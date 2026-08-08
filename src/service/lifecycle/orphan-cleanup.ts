/**
 * Orphan cleanup — remove artifacts from a previous crashed run before
 * we acquire the lock for this process.
 *
 * Two categories of orphan:
 *   1. Stale lock files: a lock whose pid is dead. We never touch a
 *      lock whose pid is alive — that would be a destructive kill of
 *      a healthy sibling service.
 *   2. Stray WAL/SHM sidecars with no matching database file: a
 *      crash after SQLite created sidecars but before it durably
 *      renamed them leaves those files behind. The next start deletes
 *      them so the new SQLite open sees a clean WAL mode.
 *
 * Anything tied to a LIVE pid is left alone — orphan cleanup is for
 * after a crash, not against a running peer.
 */

import { existsSync, unlinkSync } from "node:fs";

import { readLockMetadata } from "./process-lock";

export interface OrphanCleanupInput {
  readonly lockPath: string;
  readonly databasePath: string;
}

export interface OrphanCleanupResult {
  readonly removed: {
    readonly lock: boolean;
    readonly walSidecars: readonly string[];
  };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function runOrphanCleanup(input: OrphanCleanupInput): OrphanCleanupResult {
  let removedLock = false;
  const removedSidecars: string[] = [];

  const lockMetadata = readLockMetadata(input.lockPath);
  if (lockMetadata !== null && !isPidAlive(lockMetadata.pid)) {
    try {
      unlinkSync(input.lockPath);
      removedLock = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // Sidecars are only orphan if the database itself is gone.
  if (!existsSync(input.databasePath)) {
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${input.databasePath}${suffix}`;
      if (!existsSync(sidecar)) continue;
      try {
        unlinkSync(sidecar);
        removedSidecars.push(suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  return { removed: { lock: removedLock, walSidecars: removedSidecars } };
}
