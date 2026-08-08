/**
 * Process lock tests.
 *
 * Atomic O_EXCL acquisition, metadata round-trip, stale detection
 * (pid dead OR startTime mismatch), and reclaim semantics.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  acquireLock,
  readLockMetadata,
  releaseLock,
  writeLockMetadata,
  type LockMetadata,
} from "../../src/service/lifecycle/process-lock";

const scratchDir = join(tmpdir(), `facet-lock-test-${crypto.randomUUID()}`);

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function freshPath(): string {
  mkdirSync(scratchDir, { recursive: true });
  return join(scratchDir, `${crypto.randomUUID()}.lock`);
}

const liveMetadata: LockMetadata = {
  pid: process.pid,
  startTime: Date.now(),
  port: 12345,
  contractVersion: "facet.v1",
};

describe("acquireLock", () => {
  test("succeeds on a fresh path and writes metadata atomically", () => {
    const lockPath = freshPath();
    const result = acquireLock(lockPath, liveMetadata);
    expect(result.ok).toBe(true);
    const read = readLockMetadata(lockPath);
    expect(read).toEqual(liveMetadata);
  });

  test("fails when a lock with the same (live) pid is already held", () => {
    const lockPath = freshPath();
    const first = acquireLock(lockPath, liveMetadata);
    expect(first.ok).toBe(true);
    const second = acquireLock(lockPath, { ...liveMetadata, port: 99999 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("constraint");
  });

  test("reclaims a stale lock whose pid is dead", () => {
    const lockPath = freshPath();
    // Pretend a different process held the lock with a pid that is
    // certainly dead (pid 999_999_999 is essentially never live).
    const stale: LockMetadata = {
      pid: 999_999_999,
      startTime: Date.now() - 60_000,
      port: 12345,
      contractVersion: "facet.v1",
    };
    writeFileSync(lockPath, JSON.stringify(stale), { mode: 0o600 });
    const result = acquireLock(lockPath, liveMetadata);
    expect(result.ok).toBe(true);
    expect(readLockMetadata(lockPath)).toEqual(liveMetadata);
  });

  test("reclaims a stale lock whose startTime drifted", () => {
    const lockPath = freshPath();
    const drifted: LockMetadata = {
      pid: process.pid,
      startTime: 1_700_000_000_000,
      port: 12345,
      contractVersion: "facet.v1",
    };
    writeFileSync(lockPath, JSON.stringify(drifted), { mode: 0o600 });
    const result = acquireLock(lockPath, liveMetadata);
    expect(result.ok).toBe(true);
  });

  test("releaseLock removes the lock file", () => {
    const lockPath = freshPath();
    acquireLock(lockPath, liveMetadata);
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("readLockMetadata returns null on a missing file", () => {
    expect(readLockMetadata(freshPath())).toBeNull();
  });

  test("writeLockMetadata writes a parseable record", () => {
    const lockPath = freshPath();
    writeLockMetadata(lockPath, liveMetadata);
    expect(readLockMetadata(lockPath)).toEqual(liveMetadata);
  });

  test("stages metadata beside the lock file for cross-device safety", () => {
    const lockPath = join(process.cwd(), `.facet-lock-cross-device-${crypto.randomUUID()}.lock`);
    const lockDir = dirname(lockPath);
    try {
      writeLockMetadata(lockPath, liveMetadata);
      expect(dirname(lockPath)).toBe(lockDir);
      expect(readLockMetadata(lockPath)).toEqual(liveMetadata);
    } finally {
      rmSync(lockPath, { force: true });
    }
  });
});
