import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

import {
  inspectDormancy,
  listServiceChildPids,
  startDetachedPerfService,
  stopDetachedProcess,
  waitForDormancy,
} from "../../scripts/perf/service";
import { FacetClient, publishArtifact } from "../../src/cli/client";
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
    expect(active).toEqual({
      processExited: false,
      portClosed: false,
      lockRemoved: false,
      workerProcesses: 0,
    });

    const dormant = await waitForDormancy(running, 5_000);
    expect(dormant).toEqual({
      processExited: true,
      portClosed: true,
      lockRemoved: true,
      workerProcesses: 0,
    });
  } finally {
    await stopDetachedProcess(running.pid);
    rmSync(running.home, { recursive: true, force: true });
  }
}, 10_000);

test("publish then idle expiry reaps each captured pooled worker PID", async () => {
  const running = await startDetachedPerfService({ idleTimeoutMs: 500 });
  try {
    const client = new FacetClient({
      baseUrl: running.baseUrl,
      installToken: running.installToken,
    });
    await publishArtifact(client, {
      artifactType: "markdown",
      bytes: new TextEncoder().encode("# perf dormancy\n").buffer as ArrayBuffer,
    });
    const workerPids = listServiceChildPids(running.pid);
    expect(workerPids.length).toBeGreaterThan(0);

    const dormant = await waitForDormancy(running, 5_000);
    expect(dormant).toEqual({
      processExited: true,
      portClosed: true,
      lockRemoved: true,
      workerProcesses: 0,
    });
    for (const pid of workerPids) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await stopDetachedProcess(running.pid);
    rmSync(running.home, { recursive: true, force: true });
  }
}, 10_000);

test.each(["SIGTERM", "SIGINT"] as const)(
  "%s shutdown reaps each captured pooled worker PID",
  async (signal) => {
    const running = await startDetachedPerfService({ idleTimeoutMs: 5_000 });
    try {
      const client = new FacetClient({
        baseUrl: running.baseUrl,
        installToken: running.installToken,
      });
      await publishArtifact(client, {
        artifactType: "markdown",
        bytes: new TextEncoder().encode(`# ${signal} shutdown\n`).buffer as ArrayBuffer,
      });
      const workerPids = listServiceChildPids(running.pid);
      expect(workerPids.length).toBeGreaterThan(0);

      process.kill(running.pid, signal);
      const dormant = await waitForDormancy(running, 5_000);
      expect(dormant).toEqual({
        processExited: true,
        portClosed: true,
        lockRemoved: true,
        workerProcesses: 0,
      });
      for (const pid of workerPids) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await stopDetachedProcess(running.pid);
      rmSync(running.home, { recursive: true, force: true });
    }
  },
  10_000,
);
