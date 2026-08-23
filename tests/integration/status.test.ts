import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { tmpdir } from "node:os";

import { collectFacetStatus } from "../../src/cli/commands/status";
import { runOrphanCleanup } from "../../src/service/lifecycle/orphan-cleanup";
import { readPidStartTimeTicks } from "../../src/shared/util/process";
import { runCli, type CliIo } from "../../src/cli/main";
import { startFacetService } from "../../src/service/server";
import { FacetClient, publishArtifact } from "../../src/cli/client";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";

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

function cliIo(env: NodeJS.ProcessEnv): { io: CliIo; output: { value: string } } {
  const output = { value: "" };
  return {
    output,
    io: {
      env,
      stdin: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stdout: {
        write(chunk) {
          output.value += String(chunk);
          return true;
        },
      },
      stderr: {
        write() {
          return true;
        },
      },
    },
  };
}

describe("facet status", () => {
  test("CLI dormant health status does not spawn", async () => {
    const home = join(root, "cli-dormant");
    mkdirSync(home, { recursive: true });
    const { io, output } = cliIo({ ...process.env, FACET_HOME: home });
    const exit = await runCli(["status"], io);
    const body = JSON.parse(output.value) as {
      data: { command: string; state: string };
      ok: boolean;
    };
    expect(exit.spawnedPid).toBeNull();
    expect(exit.code).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.data.command).toBe("status");
    expect(body.data.state).toBe("dormant");
    expect(existsSync(join(home, "run", "facet.lock"))).toBe(false);
  });

  test("CLI active status reads the service lease manager", async () => {
    const home = join(root, "cli-active");
    const runtime = paths("cli-active");
    const service = await startFacetService({
      dbPath: runtime.database,
      installTokenPath: runtime.token.replace(/promote\.token$/, "install.token"),
      promoteTokenPath: runtime.token,
      lockPath: runtime.lock,
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "status-test" }),
      tier0Runner: stubTier0Runner,
    });
    try {
      const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
      const published = await publishArtifact(client, {
        artifactType: "markdown",
        bytes: new TextEncoder().encode("# status lease\n").buffer as ArrayBuffer,
      });
      const opened = await client.sendCommand({
        command: "open",
        requestId: crypto.randomUUID(),
        artifactId: published.artifactId,
        revisionSha: published.revisionSha,
      });
      expect(opened.ok).toBe(true);

      const { io, output } = cliIo({ ...process.env, FACET_HOME: home });
      const exit = await runCli(["status"], io);
      const body = JSON.parse(output.value) as {
        data: { activeLeases: number; state: string };
        ok: boolean;
      };
      expect(exit.code).toBe(0);
      expect(body.ok).toBe(true);
      expect(body.data.state).toBe("active");
      expect(body.data.activeLeases).toBe(1);
    } finally {
      await service.stop();
    }
  });

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
    expect(status.process?.rssBytes).toBeGreaterThan(0);
    expect(status.process?.pssBytes).toBeGreaterThan(0);
    expect(status.dbBytes).toBe(2);
    expect(status.evidenceBytes).toBe(8);
    expect(status.activeLeases).toBe(2);
    expect(status.activeJobs).toBe(1);
    expect(status.version).toBe(packageJson.version);
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
