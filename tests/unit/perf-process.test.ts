import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  removeBareBunFloor,
  sampleProcessCpuPercent,
  sampleProcessMemory,
  snapshotTier1Leaks,
  startBareBunFloor,
  stopBareBunFloor,
  stopProcess,
  waitForTier1Cleanup,
} from "../../scripts/perf/process";
import { isPidAlive } from "../../src/shared/util/process";

describe("perf process probes", () => {
  test("reads real RSS and PSS for a live process", () => {
    const memory = sampleProcessMemory(process.pid);
    // A live Bun process always occupies resident memory; asserting a positive
    // byte count rather than a range keeps the check honest across machines.
    expect(memory.rssBytes).toBeGreaterThan(0);
    expect(memory.pssBytes).toBeGreaterThan(0);
  });

  test("reports near-zero CPU for an idle process", async () => {
    const percent = await sampleProcessCpuPercent(process.pid, 120);
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThan(100);
  });

  test("starts and stops a bare Bun floor process", async () => {
    const floor = await startBareBunFloor();
    try {
      expect(isPidAlive(floor.pid)).toBe(true);
      expect(sampleProcessMemory(floor.pid).rssBytes).toBeGreaterThan(0);
    } finally {
      await stopBareBunFloor(floor);
    }
    expect(isPidAlive(floor.pid)).toBe(false);
  });

  test("stopProcess is a no-op for a pid that already exited", async () => {
    const floor = await startBareBunFloor();
    await stopProcess(floor.pid);
    expect(isPidAlive(floor.pid)).toBe(false);
    await stopProcess(floor.pid);
    expect(isPidAlive(floor.pid)).toBe(false);
    removeBareBunFloor(floor);
  });

  test("snapshots tier1 profile directories and diffs new ones", async () => {
    const baseline = snapshotTier1Leaks();
    const planted = mkdtempSync(join(tmpdir(), "facet-tier1-"));
    try {
      const after = snapshotTier1Leaks();
      expect(after.profiles.has(planted)).toBe(true);
      expect(baseline.profiles.has(planted)).toBe(false);

      // waitForTier1Cleanup must REPORT a directory that never disappears
      // rather than waiting it out silently — a leak detector that times out
      // into success would be exactly the vacuous guard this repo keeps finding.
      const leaked = await waitForTier1Cleanup(baseline, 100);
      expect(leaked.profiles).toContain(planted);
    } finally {
      rmSync(planted, { recursive: true, force: true });
    }
    expect(await waitForTier1Cleanup(baseline, 500)).toEqual({ pids: [], profiles: [] });
  });

  test("removeBareBunFloor deletes the scratch home", () => {
    const home = mkdtempSync(join(tmpdir(), "facet-bun-floor-test-"));
    writeFileSync(join(home, "server.ts"), "// scratch\n", { mode: 0o600 });
    removeBareBunFloor({ pid: -1, home });
    expect(() => sampleProcessMemory(-1)).toThrow();
  });
});
