import { describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { PassThrough } from "node:stream";

import * as tier0Runner from "../../src/validation/tier0/runner";
import * as sandbox from "../../src/validation/sandbox/netns";
import type { Tier0Input } from "../../src/shared/contracts/validation";
import {
  TIER0_TIMEOUT_MS,
  TIER0_TSX_COLD_P95_BASELINE_MS,
  TIER0_TSX_CONTENTION_FACTOR,
  TIER0_TSX_TIMEOUT_MS,
} from "../../src/validation/sandbox/limits";

function input(
  revisionSha: string,
  source = "fast",
  artifactType: Tier0Input["artifactType"] = "markdown",
): Tier0Input {
  return {
    revisionSha,
    artifactType,
    renderer: "svg",
    source: new TextEncoder().encode(source) as Uint8Array<ArrayBuffer>,
    lexical: {
      rendererRootSvgCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 0,
    },
    ...(artifactType === "tsx" ? { execution: "interactive" as const } : {}),
  };
}

async function withFakeWorker<T>(fn: (workerEntry: string) => Promise<T>): Promise<T> {
  const workerEntry = resolvePath(import.meta.dir, `._tier0-pool-${crypto.randomUUID()}.ts`);
  await Bun.write(
    workerEntry,
    `
const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let buffer = "";
let active = false;

function response(request) {
  return JSON.stringify({
    requestId: request.requestId,
    result: {
      tier: 0,
      status: "ok",
      revisionSha: request.revisionSha,
      expected: request.lexical,
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
    externalImageCount: 0,
        errorCount: 0,
      },
    },
  });
}

function respond(request) {
  process.stdout.write(response(request) + "\\n");
}

for (;;) {
  const next = await reader.read();
  if (next.done) break;
  if (next.value === undefined) continue;
  buffer += decoder.decode(next.value, { stream: true });
  let end = buffer.indexOf("\\n");
  while (end >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    end = buffer.indexOf("\\n");
    const request = JSON.parse(line);
    const source = Buffer.from(request.sourceBase64, "base64").toString("utf8");
    if (source === "crash") {
      process.stderr.write("parser process crashed");
      process.exit(9);
    }
    if (source === "oversized") {
      process.stdout.write("x".repeat(256) + "\\n");
      continue;
    }
    if (source === "trailing") {
      process.stdout.write(response(request) + "\\nGARBAGE");
      continue;
    }
    if (source === "missing-result") {
      process.stdout.write(JSON.stringify({ requestId: request.requestId }) + "\\n");
      continue;
    }
    if (source === "null-envelope") {
      process.stdout.write("null\\n");
      continue;
    }
    if (active) {
      process.stdout.write("CONCURRENT\\n");
      process.exit(7);
    }
    active = true;
    if (source === "stall") continue;
    setTimeout(() => {
      respond(request);
      active = false;
    }, source === "slow" ? 2_000 : 25);
  }
}
`,
  );
  try {
    return await fn(workerEntry);
  } finally {
    rmSync(workerEntry, { force: true });
  }
}

async function waitForPidExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(25);
  }
  return false;
}

function fakeWorker(): { readonly child: ChildProcess; readonly stderr: PassThrough } {
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr,
    kill: () => true,
  }) as unknown as ChildProcess;
  return { child, stderr };
}

describe("Tier 0 insecure isolation selection", () => {
  test.each([0, 1] as const)("level %d selects the netns worker path", (level) => {
    expect(tier0Runner.resolveTier0Isolation(level)).toBe("netns");
  });

  test.each([2, 3] as const)("level %d selects the direct worker path", (level) => {
    expect(tier0Runner.resolveTier0Isolation(level)).toBe("direct");
  });

  test("the exported runner remains the secure level-0 implementation", () => {
    expect(tier0Runner.resolveTier0Isolation(0)).toBe("netns");
    expect(tier0Runner.createTier0Runner(0)).toBeDefined();
    expect(tier0Runner.runTier0).toBeDefined();
  });

  test("rejects a type-bypassed insecure level instead of failing open", () => {
    expect(() => tier0Runner.resolveTier0Isolation(99 as never)).toThrow();
  });
});

describe("Tier 0 worker pool", () => {
  test("keeps the TSX timeout ordered below the legacy Tier 0 budget", () => {
    expect(TIER0_TSX_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TIER0_TSX_TIMEOUT_MS).toBeLessThan(TIER0_TIMEOUT_MS);
  });

  test("keeps measured cold TSX compile within the stated contention headroom", () => {
    expect(TIER0_TSX_TIMEOUT_MS).toBeGreaterThan(
      TIER0_TSX_COLD_P95_BASELINE_MS * TIER0_TSX_CONTENTION_FACTOR * 2,
    );
  });

  test("a malformed TSX verdict does not kill the pooled worker", async () => {
    const pids: number[] = [];
    const runner = tier0Runner.createTier0RunnerForTests(2, {
      onWorkerSpawn: (pid) => pids.push(pid),
    });
    try {
      const malformed = await runner({
        ...input("7".repeat(64), "export default function App(){ return <div>; }", "tsx"),
        execution: "static",
      });
      expect(malformed.status).toBe("error");
      expect(malformed.observed.discriminativeErrors?.[0]?.code).toBe("tsx_compile_error");
      expect(malformed.observed.discriminativeErrors?.[0]?.message).toContain("Syntax Error");
      const markdown = await runner(input("8".repeat(64), "# markdown"));
      expect(markdown.status).toBe("ok");
      expect(pids).toHaveLength(1);
    } finally {
      runner.close?.();
    }
  });

  test("a TSX timeout resets the pool before markdown is served", async () => {
    await withFakeWorker(async (workerEntry) => {
      const pids: number[] = [];
      const runner = tier0Runner.createTier0RunnerForTests(2, {
        workerEntry,
        timeoutMs: 1_000,
        tsxTimeoutMs: 10,
        onWorkerSpawn: (pid) => pids.push(pid),
      });
      try {
        await expect(runner(input("7".repeat(64), "stall", "tsx"))).rejects.toMatchObject({
          code: "tier0_timeout",
        });
        await expect(runner(input("8".repeat(64)))).resolves.toMatchObject({ status: "ok" });
      } finally {
        runner.close?.();
      }
      expect(pids).toHaveLength(2);
      expect(pids[1]).not.toBe(pids[0]);
    });
  });

  test("one worker serializes concurrent requests and preserves each revision identity", async () => {
    await withFakeWorker(async (workerEntry) => {
      const pids: number[] = [];
      const runner = tier0Runner.createTier0RunnerForTests(2, {
        workerEntry,
        onWorkerSpawn: (pid) => pids.push(pid),
      });
      const firstSha = "1".repeat(64);
      const secondSha = "2".repeat(64);

      try {
        const [first, second] = await Promise.all([
          runner(input(firstSha)),
          runner(input(secondSha)),
        ]);

        expect(first.status).toBe("ok");
        expect(second.status).toBe("ok");
        expect(first.revisionSha).toBe(firstSha);
        expect(second.revisionSha).toBe(secondSha);
        expect(pids).toHaveLength(1);
      } finally {
        runner.close?.();
      }

      expect(await waitForPidExit(pids[0]!)).toBe(true);
    });
  });

  test("a timed-out request reaps its worker and a later request starts a new worker", async () => {
    await withFakeWorker(async (workerEntry) => {
      const pids: number[] = [];
      const runner = tier0Runner.createTier0RunnerForTests(2, {
        workerEntry,
        timeoutMs: 1_000,
        onWorkerSpawn: (pid) => pids.push(pid),
      });

      try {
        await expect(runner(input("3".repeat(64), "slow"))).rejects.toMatchObject({
          code: "tier0_timeout",
        });
        await expect(runner(input("4".repeat(64)))).resolves.toMatchObject({ status: "ok" });
      } finally {
        runner.close?.();
      }

      expect(pids).toHaveLength(2);
      expect(pids[1]).not.toBe(pids[0]);
      expect(await waitForPidExit(pids[0]!)).toBe(true);
    });
  });

  test("a worker crash during a request is typed and the following request recovers", async () => {
    await withFakeWorker(async (workerEntry) => {
      const pids: number[] = [];
      const runner = tier0Runner.createTier0RunnerForTests(2, {
        workerEntry,
        onWorkerSpawn: (pid) => pids.push(pid),
      });

      try {
        await expect(runner(input("5".repeat(64), "crash"))).rejects.toMatchObject({
          code: "tier0_worker_died",
          details: { exitCode: 9, stderr: "parser process crashed" },
        });
        await expect(runner(input("6".repeat(64)))).resolves.toMatchObject({ status: "ok" });
      } finally {
        runner.close?.();
      }

      expect(pids).toHaveLength(2);
      expect(pids[1]).not.toBe(pids[0]);
    });
  });

  test("retains spawn error metadata and buffered stderr", async () => {
    const { child: worker, stderr } = fakeWorker();
    let markSpawned: () => void;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const spawn = spyOn(sandbox, "spawnDirectWorker").mockImplementation(() => {
      markSpawned();
      return worker;
    });
    const stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true);
    const runner = tier0Runner.createTier0RunnerForTests(2, {});
    const spawnError = Object.assign(new Error("spawn /bin/sh EMFILE"), {
      code: "EMFILE",
      errno: -24,
      syscall: "spawn /bin/sh",
    });
    try {
      const pending = runner(input("b".repeat(64)));
      await spawned;
      await new Promise<void>((resolve) => {
        stderr.once("data", () => resolve());
        stderr.write("worker bootstrap failed");
      });
      queueMicrotask(() => worker.emit("error", spawnError));
      await expect(pending).rejects.toMatchObject({
        code: "tier0_worker_died",
        message: expect.stringMatching(/EMFILE.*worker bootstrap failed/),
        details: {
          code: "EMFILE",
          errno: -24,
          syscall: "spawn /bin/sh",
          stderr: "worker bootstrap failed",
        },
      });
    } finally {
      runner.close?.();
      spawn.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  test("trailing worker output is a typed protocol error and output over the cap is typed", async () => {
    await withFakeWorker(async (workerEntry) => {
      const protocolRunner = tier0Runner.createTier0RunnerForTests(2, { workerEntry });
      try {
        await expect(protocolRunner(input("7".repeat(64), "trailing"))).rejects.toMatchObject({
          code: "tier0_protocol_error",
        });
      } finally {
        protocolRunner.close?.();
      }

      const capRunner = tier0Runner.createTier0RunnerForTests(2, {
        workerEntry,
        outputCap: 64,
      });
      try {
        await expect(capRunner(input("8".repeat(64), "oversized"))).rejects.toMatchObject({
          code: "tier0_output_cap",
        });
      } finally {
        capRunner.close?.();
        capRunner.close?.();
      }
    });
  });

  test("a response without result is a typed protocol error", async () => {
    await withFakeWorker(async (workerEntry) => {
      const runner = tier0Runner.createTier0RunnerForTests(2, { workerEntry });
      try {
        await expect(runner(input("9".repeat(64), "missing-result"))).rejects.toMatchObject({
          code: "tier0_protocol_error",
        });
      } finally {
        runner.close?.();
      }
    });
  });

  test("a null response envelope is a typed protocol error", async () => {
    await withFakeWorker(async (workerEntry) => {
      const runner = tier0Runner.createTier0RunnerForTests(2, { workerEntry });
      try {
        await expect(runner(input("a".repeat(64), "null-envelope"))).rejects.toMatchObject({
          code: "tier0_protocol_error",
        });
      } finally {
        runner.close?.();
      }
    });
  });
});
