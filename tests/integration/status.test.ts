import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectFacetStatus } from "../../src/cli/commands/status";
import { runOrphanCleanup } from "../../src/service/lifecycle/orphan-cleanup";
import { readPidStartTimeTicks } from "../../src/shared/util/process";

const root = join(tmpdir(), `facet-status-${crypto.randomUUID()}`);

beforeEach(() => mkdirSync(root, { recursive: true }));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function paths(label: string) {
  const home = join(root, label);
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, "run"), { recursive: true });
  return {
    database: join(home, "db", "facet.sqlite"),
    evidence: join(home, "evidence"),
    token: join(home, "secrets", "promote.token"),
    lock: join(home, "run", "facet.lock"),
    metadata: join(home, "metadata.json"),
  };
}

describe("facet status", () => {
  test("dormant status does not spawn or create state", () => {
    const runtime = paths("dormant");
    const status = collectFacetStatus(runtime);
    expect(status.state).toBe("dormant");
    expect(status.process).toBeNull();
    expect(existsSync(runtime.lock)).toBe(false);
  });

  test("active status reports metadata and byte sizes", () => {
    const runtime = paths("active");
    mkdirSync(join(root, "active", "db"), { recursive: true });
    mkdirSync(join(root, "active", "evidence"), { recursive: true });
    writeFileSync(runtime.database, "db");
    writeFileSync(join(root, "active", "evidence", "shot.png"), "evidence");
    const ticks = readPidStartTimeTicks(process.pid);
    writeFileSync(
      runtime.lock,
      JSON.stringify({
        pid: process.pid,
        startTime: Date.now(),
        startTimeTicks: ticks,
        port: 4321,
        contractVersion: "facet.v1",
      }),
    );
    const status = collectFacetStatus(runtime, {
      activeLeases: 2,
      activeJobs: 1,
      browserJobs: 1,
      idleDeadline: Date.now() + 1000,
    });
    expect(readPidStartTimeTicks(process.pid)).toBe(ticks);
    expect(status.state).toBe("active");
    expect(status.process?.pid).toBe(process.pid);
    expect(status.dbBytes).toBe(2);
    expect(status.evidenceBytes).toBe(8);
    expect(status.activeLeases).toBe(2);
    expect(status.activeJobs).toBe(1);
  });

  test("stale pid reuse is dormant when start time does not match", () => {
    const runtime = paths("reused");
    writeFileSync(
      runtime.lock,
      JSON.stringify({
        pid: process.pid,
        startTime: Date.now(),
        startTimeTicks: (readPidStartTimeTicks(process.pid) ?? 0) + 1,
        port: 4321,
        contractVersion: "facet.v1",
      }),
    );
    expect(collectFacetStatus(runtime).state).toBe("dormant");
  });
});

describe("orphan cleanup", () => {
  test("removes abandoned profile and process without collateral kill", () => {
    const runtime = paths("orphan");
    const abandoned = join(root, "orphan", "profile-abandoned");
    mkdirSync(abandoned, { recursive: true });
    const result = runOrphanCleanup({
      lockPath: runtime.lock,
      databasePath: runtime.database,
      profiles: [{ path: abandoned, pid: 999_999_999, startTime: 1 }],
    });
    expect(result.removed.profiles).toContain(abandoned);
    expect(existsSync(abandoned)).toBe(false);
    expect(result.killedPids).toEqual([]);
  });

  test("does not kill a live pid when start time differs", () => {
    const runtime = paths("guard");
    const result = runOrphanCleanup({
      lockPath: runtime.lock,
      databasePath: runtime.database,
      processes: [{ pid: process.pid, startTime: 1 }],
    });
    expect(result.killedPids).toEqual([]);
  });
});
