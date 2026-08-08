/**
 * Orphan cleanup tests.
 *
 * On startup we detect and remove artifacts from a previous crashed
 * run: a stale lock whose pid is dead, or a stray WAL/SHM sidecar
 * without a corresponding live database. We never touch files that
 * belong to a live process.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runOrphanCleanup,
  type OrphanCleanupInput,
} from "../../src/service/lifecycle/orphan-cleanup";

const scratchDir = join(tmpdir(), `facet-orphan-${crypto.randomUUID()}`);

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function setup(): OrphanCleanupInput {
  mkdirSync(scratchDir, { recursive: true });
  return {
    lockPath: join(scratchDir, "facet.lock"),
    databasePath: join(scratchDir, "facet.sqlite"),
  };
}

describe("runOrphanCleanup", () => {
  test("does nothing when no orphan files exist", () => {
    const input = setup();
    const result = runOrphanCleanup(input);
    expect(result.removed.lock).toBe(false);
    expect(result.removed.walSidecars).toEqual([]);
  });

  test("removes a stale lock whose pid is dead", () => {
    const input = setup();
    writeFileSync(
      input.lockPath,
      JSON.stringify({
        pid: 999_999_999,
        startTime: Date.now() - 60_000,
        port: 12345,
        contractVersion: "facet.v1",
      }),
      { mode: 0o600 },
    );
    const result = runOrphanCleanup(input);
    expect(result.removed.lock).toBe(true);
    expect(existsSync(input.lockPath)).toBe(false);
  });

  test("does NOT remove a lock whose pid is alive", () => {
    const input = setup();
    writeFileSync(
      input.lockPath,
      JSON.stringify({
        pid: process.pid,
        startTime: Date.now(),
        port: 12345,
        contractVersion: "facet.v1",
      }),
      { mode: 0o600 },
    );
    const result = runOrphanCleanup(input);
    expect(result.removed.lock).toBe(false);
    expect(existsSync(input.lockPath)).toBe(true);
  });

  test("removes stray WAL/SHM sidecars with no live database", () => {
    const input = setup();
    writeFileSync(`${input.databasePath}-wal`, "stray", { mode: 0o600 });
    writeFileSync(`${input.databasePath}-shm`, "stray", { mode: 0o600 });
    const result = runOrphanCleanup(input);
    expect(result.removed.walSidecars).toContain("-wal");
    expect(result.removed.walSidecars).toContain("-shm");
    expect(existsSync(`${input.databasePath}-wal`)).toBe(false);
    expect(existsSync(`${input.databasePath}-shm`)).toBe(false);
  });

  test("leaves a live database + its WAL/SHM sidecars alone", () => {
    const input = setup();
    writeFileSync(input.databasePath, "live", { mode: 0o600 });
    writeFileSync(`${input.databasePath}-wal`, "live-wal", { mode: 0o600 });
    writeFileSync(`${input.databasePath}-shm`, "live-shm", { mode: 0o600 });
    const result = runOrphanCleanup(input);
    expect(result.removed.walSidecars).toEqual([]);
    expect(existsSync(`${input.databasePath}-wal`)).toBe(true);
    expect(existsSync(`${input.databasePath}-shm`)).toBe(true);
  });
});
