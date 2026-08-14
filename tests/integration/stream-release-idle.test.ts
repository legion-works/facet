/**
 * Stream release → service dormancy integration test.
 *
 * The gallery shell releases a display lease via POST /api/v1/gallery/release
 * when the display closes. Before the teardown fix, `release()` dropped the
 * stream's expire listener without firing it, so the stream never learned its
 * lease was gone: its `stream:<id>` idle reason and broadcaster slot were held
 * forever and the service never reached the idle → dormant transition. This
 * test opens a real stream, releases the lease through the route, and proves
 * the service drains both idle reasons and goes dormant within the idle window.
 */

import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";

describe("stream release → dormancy", () => {
  test("releasing the lease via the route drains the stream + lease idle reasons", async () => {
    const envDir = mkdtempSync(join(tmpdir(), "facet-stream-release-"));
    const lockPath = join(envDir, "facet.lock");
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath,
      idleTimeoutMs: 200,
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 1_000,
      logger: createQuietLogger({ component: "stream-release-test" }),
      tier0Runner: stubTier0Runner,
    });
    try {
      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${service.installToken}`,
        host: `127.0.0.1:${service.port}`,
      };
      const command = async (requestId: string, data: Record<string, unknown>) => {
        const res = await fetch(`${service.url}/api/v1/commands`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            schemaVersion: "facet.v1",
            requestId,
            ok: true,
            data: { requestId, ...data },
          }),
        });
        const json = (await res.json()) as {
          ok: boolean;
          data: Record<string, unknown>;
        };
        if (!json.ok) throw new Error(`command failed: ${requestId}`);
        return json.data;
      };

      const created = await command("r-create", {
        command: "create",
        projectId: "p",
        slug: "stream-release",
        title: "Stream release",
      });
      const artifactId = (created.artifact as { id: string }).id;
      const published = await command("r-publish", {
        command: "publish",
        artifactId,
        artifactType: "markdown",
        bytes: Buffer.from("# release dormancy\n").toString("base64"),
      });
      const revisionSha = (published.revision as { sha256: string }).sha256;
      const opened = await command("r-open", { command: "open", artifactId, revisionSha });
      const leaseId = (opened.lease as { leaseId: string }).leaseId;

      const streamRes = await fetch(`${service.url}/api/v1/stream`, {
        headers: {
          authorization: `Bearer ${service.installToken}`,
          host: `127.0.0.1:${service.port}`,
          "x-gallery-lease": leaseId,
          "x-gallery-artifact": artifactId,
        },
      });
      expect(streamRes.status).toBe(200);
      const reader = streamRes.body!.getReader();
      await reader.read();

      const releaseRes = await fetch(`${service.url}/api/v1/gallery/release`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${service.installToken}`,
          host: `127.0.0.1:${service.port}`,
          "x-gallery-lease": leaseId,
          "x-gallery-artifact": artifactId,
        },
      });
      expect(releaseRes.status).toBe(204);

      // Both idle reasons are now gone (the stream's via the fired expire
      // listener, the lease's via the route). The service must go idle —
      // and, because going idle also runs the shutdown cleanup, the lock
      // must be released (the dormant proof).
      await service.waitUntilIdle();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await service.stop().catch(() => {});
      try {
        rmSync(envDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }, 30_000);
});
