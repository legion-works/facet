import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFacetService } from "../../src/service/server";
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
});
