import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFacetService } from "../../src/service/server";
import { FacetClient, publishArtifact } from "../../src/cli/client";
import { CommandResultSchema } from "../../src/shared/contracts/commands";
import { generateRequestId } from "../../src/shared/util/time";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";

const GALLERY_DIR = join(import.meta.dir, "../../dist/gallery");
const originalGalleryDir = mkdtempSync(join(tmpdir(), "facet-gallery-route-original-"));
rmSync(originalGalleryDir, { recursive: true, force: true });

function moveGalleryDir(destination: string): void {
  if (existsSync(GALLERY_DIR)) {
    cpSync(GALLERY_DIR, destination, { recursive: true });
    rmSync(GALLERY_DIR, { recursive: true, force: true });
  }
}

function restoreGalleryDir(): void {
  rmSync(GALLERY_DIR, { recursive: true, force: true });
  if (existsSync(originalGalleryDir)) {
    cpSync(originalGalleryDir, GALLERY_DIR, { recursive: true });
  }
}

describe("GET /gallery", () => {
  let service: Awaited<ReturnType<typeof startFacetService>> | undefined;
  let envDir: string | undefined;

  afterEach(async () => {
    await service?.stop();
    service = undefined;
    restoreGalleryDir();
    if (envDir !== undefined) rmSync(envDir, { recursive: true, force: true });
    envDir = undefined;
  });

  test("builds the real shell on demand and serves its referenced asset", async () => {
    moveGalleryDir(originalGalleryDir);
    rmSync(GALLERY_DIR, { recursive: true, force: true });
    const testEnvDir = mkdtempSync(join(tmpdir(), "facet-gallery-route-"));
    envDir = testEnvDir;
    service = await startFacetService({
      dbPath: join(testEnvDir, "facet.sqlite"),
      installTokenPath: join(testEnvDir, "install.token"),
      promoteTokenPath: join(testEnvDir, "promote.token"),
      lockPath: join(testEnvDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-route-test" }),
      tier0Runner: stubTier0Runner,
    });

    const response = await fetch(`${service.url}/gallery`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain("Loading facet gallery…");
    expect(html).toMatch(/<script[^>]+src=["'][^"']+["']/i);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");

    const assetPath = html.match(/<script[^>]+src=["']([^"']+)["']/i)?.[1];
    expect(assetPath).toBeDefined();
    const asset = await fetch(new URL(assetPath!, `${service.url}/gallery`));
    expect(asset.status).toBe(200);
    const galleryAsset = await fetch(new URL(assetPath!, `${service.url}/gallery/`));
    expect(galleryAsset.status).toBe(200);
  });

  test("serves source only through the matching live gallery lease", async () => {
    const testEnvDir = mkdtempSync(join(tmpdir(), "facet-gallery-source-"));
    envDir = testEnvDir;
    service = await startFacetService({
      dbPath: join(testEnvDir, "facet.sqlite"),
      installTokenPath: join(testEnvDir, "install.token"),
      promoteTokenPath: join(testEnvDir, "promote.token"),
      lockPath: join(testEnvDir, "facet.lock"),
      idleTimeoutMs: 30_000,
      logger: createQuietLogger({ component: "gallery-source-test" }),
      tier0Runner: stubTier0Runner,
    });
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    const first = await publishArtifact(client, {
      artifactType: "mermaid",
      bytes: new TextEncoder().encode("graph TD\n A-->B").buffer as ArrayBuffer,
      slug: "source-a",
    });
    const second = await publishArtifact(client, {
      artifactType: "mermaid",
      bytes: new TextEncoder().encode("graph TD\n C-->D").buffer as ArrayBuffer,
      slug: "source-b",
    });
    const openResponse = await client.sendCommand({
      command: "open",
      requestId: generateRequestId(),
      artifactId: first.artifactId,
      revisionSha: first.revisionSha,
    });
    expect(openResponse.ok).toBe(true);
    if (!openResponse.ok) throw new Error("open request failed");
    const open = CommandResultSchema.parse(openResponse.data);
    expect(open.command).toBe("open");
    if (open.command !== "open") throw new Error("open result mismatch");
    const bootstrap = await fetch(new URL(open.frameUrl).origin + "/api/v1/gallery/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: new URL(open.frameUrl).hash.split("=")[1] }),
    });
    const handoff = (await bootstrap.json()) as {
      authorization: string;
      artifactId: string;
      lease: { leaseId: string };
    };
    const sourceUrl = `${service.url}/api/v1/gallery/source?revisionSha=${first.revisionSha}`;
    const source = await fetch(sourceUrl, {
      headers: {
        authorization: handoff.authorization,
        "x-gallery-lease": handoff.lease.leaseId,
        "x-gallery-artifact": first.artifactId,
      },
    });
    expect(source.status).toBe(200);
    expect(await source.json()).toMatchObject({
      artifactId: first.artifactId,
      artifactType: "mermaid",
    });
    expect((await fetch(sourceUrl)).status).toBe(401);
    expect(
      (
        await fetch(sourceUrl, {
          headers: {
            authorization: handoff.authorization,
            "x-gallery-lease": "wrong",
            "x-gallery-artifact": first.artifactId,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${service.url}/api/v1/gallery/source?revisionSha=${second.revisionSha}`, {
          headers: {
            authorization: handoff.authorization,
            "x-gallery-lease": handoff.lease.leaseId,
            "x-gallery-artifact": first.artifactId,
          },
        })
      ).status,
    ).toBe(404);
  });
});
