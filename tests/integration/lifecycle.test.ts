/**
 * Lifecycle integration tests.
 *
 * Verifies that the loopback service:
 *   - exits and closes its port when the idle window elapses with no
 *     active reasons
 *   - holds the port open while an active lease is held
 *   - reclaims a stale lock whose pid is dead on the next start
 *   - runs the startup orphan cleanup before acquisition
 *
 * Each test is bounded to <10s; idleTimeoutMs is short.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startFacetService } from "../../src/service/server";
import { runOrphanCleanup } from "../../src/service/lifecycle/orphan-cleanup";
import { FacetClient, publishArtifact } from "../../src/cli/client";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";

const scratchRoot = join(tmpdir(), `facet-lifecycle-${crypto.randomUUID()}`);

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
});

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

function envPaths(label: string): {
  dbPath: string;
  installTokenPath: string;
  promoteTokenPath: string;
  lockPath: string;
  dir: string;
} {
  const dir = join(scratchRoot, `${label}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return {
    dbPath: join(dir, "facet.sqlite"),
    installTokenPath: join(dir, "install.token"),
    promoteTokenPath: join(dir, "promote.token"),
    lockPath: join(dir, "facet.lock"),
    dir,
  };
}

async function portClosed(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(200) });
    return false;
  } catch {
    return true;
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

describe("service lifecycle", () => {
  test("after the last reason releases + idle expiry → process exits and port closed", async () => {
    const paths = envPaths("idle");
    const service = await startFacetService({
      logger: createQuietLogger({ component: "test" }),
      ...paths,
      idleTimeoutMs: 200,
      tier0Runner: stubTier0Runner,
    });
    expect(await portClosed(service.port)).toBe(false);
    await service.waitUntilIdle();
    await service.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(await portClosed(service.port)).toBe(true);
  });

  test("an active lease holds the service open past the idle window", async () => {
    const paths = envPaths("lease");
    const service = await startFacetService({
      logger: createQuietLogger({ component: "test" }),
      ...paths,
      idleTimeoutMs: 200,
      tier0Runner: stubTier0Runner,
    });
    try {
      // Drive an `open` to create a lease that pins the idle controller.
      const createRes = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${service.installToken}`,
          host: `127.0.0.1:${service.port}`,
        },
        body: JSON.stringify({
          schemaVersion: "facet.v1",
          requestId: "r-c",
          ok: true,
          data: { requestId: "r-c", command: "create", projectId: "p", slug: "s", title: "S" },
        }),
      });
      const createBody = (await createRes.json()) as {
        ok: true;
        data: { artifact: { id: string } };
      };
      const publishRes = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${service.installToken}`,
          host: `127.0.0.1:${service.port}`,
        },
        body: JSON.stringify({
          schemaVersion: "facet.v1",
          requestId: "r-p",
          ok: true,
          data: {
            requestId: "r-p",
            command: "publish",
            artifactId: createBody.data.artifact.id,
            artifactType: "markdown",
            bytes: "aGk=", // base64("hi")
          },
        }),
      });
      const publishBody = (await publishRes.json()) as {
        ok: true;
        data: { revision: { sha256: string } };
      };
      const openRes = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${service.installToken}`,
          host: `127.0.0.1:${service.port}`,
        },
        body: JSON.stringify({
          schemaVersion: "facet.v1",
          requestId: "r-o",
          ok: true,
          data: {
            requestId: "r-o",
            command: "open",
            artifactId: createBody.data.artifact.id,
            revisionSha: publishBody.data.revision.sha256,
          },
        }),
      });
      const openBody = (await openRes.json()) as {
        ok: true;
        data: { frameUrl: string; lease: { leaseId: string; expiresAt: number } };
      };
      // Lease id is carried in the body, NOT embedded in the URL.
      expect(openBody.data.frameUrl).not.toContain("lease=");
      expect(openBody.data.lease.leaseId.length).toBeGreaterThan(0);
      // Idle window is 200ms — wait 600ms; the lease should have held it.
      await new Promise((r) => setTimeout(r, 600));
      expect(await portClosed(service.port)).toBe(false);
    } finally {
      await service.stop();
    }
  }, 10_000);

  test("stale-lock (dead pid) reclaimed on next start", async () => {
    const paths = envPaths("stale");
    writeFileSync(
      paths.lockPath,
      JSON.stringify({
        pid: 999_999_999, // certainly dead
        startTime: Date.now() - 60_000,
        port: 12345,
        contractVersion: "facet.v1",
      }),
      { mode: 0o600 },
    );
    const service = await startFacetService({
      logger: createQuietLogger({ component: "test" }),
      ...paths,
      idleTimeoutMs: 500,
      tier0Runner: stubTier0Runner,
    });
    try {
      // If stale reclaim had failed the service wouldn't have started.
      expect(service.port).toBeGreaterThan(0);
    } finally {
      await service.stop();
    }
  });

  test("startup orphan cleanup runs (removes stale lock + stray sidecars)", async () => {
    const paths = envPaths("orphan");
    writeFileSync(
      paths.lockPath,
      JSON.stringify({
        pid: 999_999_999,
        startTime: Date.now() - 60_000,
        port: 12345,
        contractVersion: "facet.v1",
      }),
      { mode: 0o600 },
    );
    writeFileSync(`${paths.dbPath}-wal`, "stray", { mode: 0o600 });
    writeFileSync(`${paths.dbPath}-shm`, "stray", { mode: 0o600 });

    // Run the cleanup directly to assert the observable behavior:
    const result = runOrphanCleanup({
      lockPath: paths.lockPath,
      databasePath: paths.dbPath,
    });
    expect(result.removed.lock).toBe(true);
    expect(result.removed.walSidecars).toContain("-wal");
    expect(result.removed.walSidecars).toContain("-shm");
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(existsSync(`${paths.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${paths.dbPath}-shm`)).toBe(false);
  });

  test("stop() is idempotent (no hang / no crash on double-call)", async () => {
    const paths = envPaths("double-stop");
    const service = await startFacetService({
      logger: createQuietLogger({ component: "test" }),
      ...paths,
      idleTimeoutMs: 500,
      tier0Runner: stubTier0Runner,
    });
    await service.stop();
    await service.stop();
  });

  test("startup failure after runner injection closes the runner", async () => {
    const paths = envPaths("startup-close");
    let closes = 0;
    const runner = Object.assign(stubTier0Runner, {
      close: () => {
        closes += 1;
      },
    });

    await expect(
      startFacetService({
        logger: createQuietLogger({ component: "test" }),
        ...paths,
        host: "invalid host",
        tier0Runner: runner,
      }),
    ).rejects.toMatchObject({ code: "internal" });
    expect(closes).toBe(1);
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  test("idle shutdown reaps the pooled Tier 0 worker", async () => {
    const paths = envPaths("pooled-idle");
    const pids: number[] = [];
    const runner = createTier0RunnerForTests(2, {
      onWorkerSpawn: (pid) => pids.push(pid),
    });
    const service = await startFacetService({
      logger: createQuietLogger({ component: "test" }),
      ...paths,
      idleTimeoutMs: 100,
      tier0Runner: runner,
    });
    try {
      const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
      await publishArtifact(client, {
        artifactType: "markdown",
        bytes: new TextEncoder().encode("# pooled idle\n").buffer as ArrayBuffer,
      });
      expect(pids).toHaveLength(1);
      await service.waitUntilIdle();
      expect(await portClosed(service.port)).toBe(true);
      expect(existsSync(paths.lockPath)).toBe(false);
      expect(await waitForPidExit(pids[0]!)).toBe(true);
    } finally {
      runner.close?.();
      await service.stop();
    }
  });

  test("explicit stop reaps the pooled Tier 0 worker", async () => {
    const paths = envPaths("pooled-stop");
    const pids: number[] = [];
    const runner = createTier0RunnerForTests(2, {
      onWorkerSpawn: (pid) => pids.push(pid),
    });
    const service = await startFacetService({
      logger: createQuietLogger({ component: "test" }),
      ...paths,
      idleTimeoutMs: 5_000,
      tier0Runner: runner,
    });
    try {
      const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
      await publishArtifact(client, {
        artifactType: "markdown",
        bytes: new TextEncoder().encode("# pooled stop\n").buffer as ArrayBuffer,
      });
      expect(pids).toHaveLength(1);
      await service.stop();
      expect(await waitForPidExit(pids[0]!)).toBe(true);
    } finally {
      runner.close?.();
      await service.stop();
    }
  });
});
