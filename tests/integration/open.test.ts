import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildGalleryUrl,
  consumeBootstrapHandoff,
  releaseDisplayLease,
} from "../../src/gallery-web/app";
import { launchDisplay, type OpenLauncher } from "../../src/cli/commands/open";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";

describe("tier 2 display open", () => {
  afterEach(() => {
    // No process is launched by these tests; launchers are injected below.
  });

  test("launches exactly one loopback URL without the install token", async () => {
    const calls: string[] = [];
    const launcher: OpenLauncher = (url) => {
      calls.push(url);
    };
    const url = buildGalleryUrl("http://127.0.0.1:43123", "bootstrap-1");
    await launchDisplay({ frameUrl: url, installToken: "install-secret" }, launcher);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!).hostname).toBe("127.0.0.1");
    expect(calls[0]).not.toContain("install-secret");
    expect(new URL(calls[0]!).search).toBe("");
  });

  test("shell exchanges the one-time fragment and uses header leases", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (init === undefined) requests.push({ url: String(url) });
      else requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          authorization: "Bearer session-token",
          artifactId: "artifact-1",
          revisionSha: "a".repeat(64),
          lease: { leaseId: "lease-1", expiresAt: Date.now() + 1_000 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const result = await consumeBootstrapHandoff({
      location: "http://127.0.0.1:43123/gallery#bootstrap=one-time",
      fetchImpl,
    });
    expect(result.lease.leaseId).toBe("lease-1");
    expect(requests[0]?.url).toContain("/api/v1/gallery/bootstrap");
    expect(requests[0]?.url).not.toContain("one-time");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(result.headers.get("authorization")).toBe("Bearer session-token");
    expect(result.headers.get("x-gallery-lease")).toBe("lease-1");
    expect(result.headers.get("x-gallery-artifact")).toBe("artifact-1");
  });

  test("closing the shell releases the display lease and permits idle exit", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: URL | RequestInfo, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await releaseDisplayLease({
      baseUrl: "http://127.0.0.1:43123",
      authorization: "Bearer session-token",
      artifactId: "artifact-1",
      leaseId: "lease-1",
      fetchImpl,
    });
    const headers = new Headers(seen[0]?.headers);
    expect(headers.get("x-gallery-lease")).toBe("lease-1");
    expect(headers.get("x-gallery-artifact")).toBe("artifact-1");
    expect(headers.get("authorization")).toBe("Bearer session-token");
  });

  test("service open is display-only and bootstrap is single-use", async () => {
    const root = mkdtempSync(join(tmpdir(), "facet-open-"));
    const service = await startFacetService({
      dbPath: join(root, "facet.sqlite"),
      installTokenPath: join(root, "install.token"),
      promoteTokenPath: join(root, "promote.token"),
      lockPath: join(root, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "open-test" }),
      tier0Runner: stubTier0Runner,
    });
    const headers = {
      authorization: `Bearer ${service.installToken}`,
      host: `127.0.0.1:${service.port}`,
      "content-type": "application/json",
    };
    const command = async (data: Record<string, unknown>) => {
      const requestId = crypto.randomUUID();
      const response = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: "facet.v1",
          requestId,
          ok: true,
          data: { requestId, ...data },
        }),
      });
      return (await response.json()) as { ok: boolean; data: Record<string, unknown> };
    };
    try {
      const created = await command({
        command: "create",
        projectId: "p",
        slug: "open",
        title: "Open",
      });
      const artifactId = (created.data.artifact as { id: string }).id;
      const published = await command({
        command: "publish",
        artifactId,
        artifactType: "markdown",
        bytes: Buffer.from("# display\n").toString("base64"),
      });
      const revisionSha = (published.data.revision as { sha256: string }).sha256;
      const opened = await command({ command: "open", artifactId, revisionSha });
      const frameUrl = opened.data.frameUrl as string;
      expect(new URL(frameUrl).hostname).toBe("127.0.0.1");
      expect(frameUrl).not.toContain(service.installToken);
      const handoff = await consumeBootstrapHandoff({ location: frameUrl });
      expect(handoff.headers.get("x-gallery-lease")).toBe(handoff.lease.leaseId);
      const replay = await fetch(`${service.url}/api/v1/gallery/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: new URL(frameUrl).hash.slice("#bootstrap=".length) }),
      });
      expect(replay.status).toBe(401);
      await releaseDisplayLease({
        baseUrl: service.url,
        authorization: handoff.authorization,
        artifactId: handoff.artifactId,
        leaseId: handoff.lease.leaseId,
      });
    } finally {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
