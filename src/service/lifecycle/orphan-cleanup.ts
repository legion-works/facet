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

import { existsSync, rmSync, unlinkSync } from "node:fs";

import {
  isPidAlive,
  readLockMetadata,
  readPidStartTimeTicks as readPidStartTimeTicksReal,
} from "./process-lock";

export interface OrphanProfile {
  readonly path: string;
  readonly pid: number;
  readonly startTime: number;
}

export interface OrphanProcess {
  readonly pid: number;
  readonly startTime: number;
}

export interface OrphanCleanupInput {
  readonly lockPath: string;
  readonly databasePath: string;
  readonly profiles?: readonly OrphanProfile[];
  readonly processes?: readonly OrphanProcess[];
  /** Test seam: override start-time reads (e.g. to simulate unreadable /proc). Defaults to the real reader. */
  readonly readPidStartTimeTicks?: (pid: number) => number | null;
}

export interface OrphanCleanupResult {
  readonly removed: {
    readonly lock: boolean;
    readonly walSidecars: readonly string[];
    readonly profiles: readonly string[];
  };
  readonly killedPids: readonly number[];
}

export function runOrphanCleanup(input: OrphanCleanupInput): OrphanCleanupResult {
  const readPidStartTimeTicks = input.readPidStartTimeTicks ?? readPidStartTimeTicksReal;
  let removedLock = false;
  const removedSidecars: string[] = [];
  const removedProfiles: string[] = [];
  const killedPids: number[] = [];

  const lockMetadata = readLockMetadata(input.lockPath);
  if (lockMetadata !== null && (!isPidAlive(lockMetadata.pid) || isLockOwnerStale(lockMetadata))) {
    try {
      unlinkSync(input.lockPath);
      removedLock = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  for (const profile of input.profiles ?? []) {
    if (isPidAlive(profile.pid)) {
      const startTime = readPidStartTimeTicks(profile.pid);
      // Fail closed: a live pid whose start time we could not read is
      // NOT evidence of a mismatch — `null !== profile.startTime` would
      // otherwise fall through to deletion below and remove a live
      // process's profile directory on transient/unreadable /proc
      // metadata. Only a confirmed dead pid or a confirmed start-time
      // mismatch is grounds for cleanup.
      if (startTime === null || startTime === profile.startTime) continue;
    }
    if (!existsSync(profile.path)) continue;
    rmSync(profile.path, { recursive: true, force: true });
    removedProfiles.push(profile.path);
  }
  for (const process of input.processes ?? []) {
    if (!isPidAlive(process.pid) || readPidStartTimeTicks(process.pid) !== process.startTime)
      continue;
    try {
      processKill(process.pid);
      killedPids.push(process.pid);
    } catch {
      // The process may have exited between the identity check and the signal.
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

  return {
    removed: { lock: removedLock, walSidecars: removedSidecars, profiles: removedProfiles },
    killedPids,
  };
}

function isLockOwnerStale(metadata: { pid: number; startTimeTicks?: number | null }): boolean {
  return (
    metadata.startTimeTicks !== undefined &&
    metadata.startTimeTicks !== null &&
    readPidStartTimeTicksReal(metadata.pid) !== metadata.startTimeTicks
  );
}

function processKill(pid: number): void {
  process.kill(pid, "SIGTERM");
}
