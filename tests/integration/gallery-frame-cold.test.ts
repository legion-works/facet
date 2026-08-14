/**
 * Cold-dist recovery for HTML and TSX gallery frame documents.
 *
 * Every frame route calls `ensureGalleryBuild()` before emitting a document.
 * HTML and TSX additionally link `artifact.css`, so deleting that asset proves
 * the uniform build recovery rather than a type-specific fallback.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFacetService, type RunningService } from "../../src/service/server";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { createQuietLogger } from "../../src/shared/logging/logger";

const scratchRoot = mkdtempSync(join(tmpdir(), "facet-frame-cold-"));
const ARTIFACT_CSS = join(import.meta.dir, "../../dist/gallery/frame/artifact.css");

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

interface FrameEnv {
  service: RunningService;
  envDir: string;
}

async function startEnv(): Promise<FrameEnv> {
  const envDir = join(scratchRoot, crypto.randomUUID());
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 5_000,
    logger: createQuietLogger({ component: "frame-cold-test" }),
    tier0Runner: stubTier0Runner,
  });
  return { service, envDir };
}

describe("/gallery/frame — cold-dist recovery", () => {
  test("rebuilds missing artifact.css before serving HTML and TSX frame documents", async () => {
    const { service } = await startEnv();
    try {
      rmSync(ARTIFACT_CSS, { force: true });
      expect(existsSync(ARTIFACT_CSS)).toBe(false);
      for (const type of ["html", "tsx"] as const) {
        const response = await fetch(`${service.url}/gallery/frame?type=${type}`);
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(body).toContain('<link rel="stylesheet" href="/gallery/frame/artifact.css">');
        expect(body).not.toMatch(/at\s+\S+\s+\(|node_modules|\.ts:\d+|TypeError:|Error:/);
      }
      expect(existsSync(ARTIFACT_CSS)).toBe(true);
    } finally {
      await service.stop();
    }
  });
});
