import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import {
  inspectDormancy,
  startDetachedPerfService,
  stopDetachedProcess,
  waitForDormancy,
} from "../../scripts/perf/service";
import {
  sampleProcessMemory,
  startBareBunFloor,
  stopBareBunFloor,
} from "../../scripts/perf/process";

test("bare Bun floor is a separate measurable process and cleans up", async () => {
  const floor = await startBareBunFloor();
  try {
    await Bun.sleep(100);
    const memory = sampleProcessMemory(floor.pid);
    expect(memory.rssBytes).toBeGreaterThan(0);
    expect(memory.pssBytes).toBeGreaterThan(0);
  } finally {
    await stopBareBunFloor(floor);
  }
  expect(() => process.kill(floor.pid, 0)).toThrow();
});

test("dormancy check turns red before a real service exits, then passes after idle", async () => {
  const running = await startDetachedPerfService({ idleTimeoutMs: 500 });
  try {
    const active = await inspectDormancy(running);
    expect(active).toEqual({ processExited: false, portClosed: false, lockRemoved: false });

    const dormant = await waitForDormancy(running, 5_000);
    expect(dormant).toEqual({ processExited: true, portClosed: true, lockRemoved: true });
  } finally {
    await stopDetachedProcess(running.pid);
    rmSync(running.home, { recursive: true, force: true });
  }
}, 10_000);
