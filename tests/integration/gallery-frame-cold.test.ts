/**
 * Cold-dist recovery for `/gallery/frame?type=html`.
 *
 * Pre-fix, the html frame route read `<dist>/gallery/frame/bootstrap/html.css`
 * with a bare `Bun.file(...).text()` — no `ensureGalleryBuild()`, no existence
 * check, no try/catch. A fresh clone (or a `rm -rf dist/` + restart) hit a
 * 500 with a 67 KB RAW STACK TRACE as the response body. Every other type
 * self-heals because their frame route already calls `ensureGalleryBuild()`.
 *
 * This test pins both halves of the fix:
 *
 *   1. The html frame route must NOT return a raw stack trace as the
 *      response body — that's an information-disclosure defect.
 *   2. The html frame route must recover when the asset is missing —
 *      either by building on demand or by returning a typed plain-text
 *      error with a 5xx status. Both shapes are acceptable; a 500 with a
 *      raw exception dump is not.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFacetService, type RunningService } from "../../src/service/server";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { createQuietLogger } from "../../src/shared/logging/logger";

const scratchRoot = mkdtempSync(join(tmpdir(), "facet-frame-cold-"));

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

describe("/gallery/frame?type=html — cold-dist recovery", () => {
  test("removes the built stylesheet and asserts the html route recovers without leaking a stack trace", async () => {
    const { service } = await startEnv();
    try {
      // Trigger a gallery build by hitting the html frame route ONCE
      // (which is the route that triggers the build for the html
      // bundle, so the html.css asset is now on disk).
      const buildProbe = await fetch(
        `${service.url}/gallery/frame?nonce=${"a".repeat(32)}&type=html`,
      );
      expect(buildProbe.status).toBe(200);
      // The service writes dist/gallery into the PROJECT root (not
      // FACET_HOME) — see router.ts's galleryRoot = `<import.meta.dir>/../../dist/gallery`.
      const repoRoot = join(import.meta.dir, "..", "..");
      const cssPath = join(repoRoot, "dist", "gallery", "frame", "bootstrap", "html.css");
      const cssBytes = await Bun.file(cssPath).bytes();
      expect(cssBytes.byteLength).toBeGreaterThan(0);
      // Move the asset aside: cold-equivalent of a fresh clone that
      // somehow lost dist/. The same-filesystem rename keeps the test
      // portable (mv across filesystems would EXDEV).
      const movedAside = `${cssPath}.moved-aside`;
      await Bun.write(movedAside, cssBytes);
      rmSync(cssPath, { force: true });

      // Touch the html frame route directly. The pre-fix failure is a
      // 500 with a 67 KB raw stack trace as the response body.
      const response = await fetch(
        `${service.url}/gallery/frame?nonce=${"a".repeat(32)}&type=html`,
      );
      const body = await response.text();

      // No raw stack trace in the response body. The fingerprint:
      // BunError / Error: messages, file paths with `src/`, node_modules
      // stacks. A typed plain-text message has none of those.
      const looksLikeStack = /at\s+\S+\s+\(|node_modules|\.ts:\d+|TypeError:|Error:/.test(body);
      expect(looksLikeStack).toBe(false);

      // The html frame route either succeeds (build-on-demand heals)
      // or returns a 5xx with a short plain-text body.
      if (response.status === 200) {
        expect(body).toContain("text/html");
      } else {
        expect(response.status).toBeGreaterThanOrEqual(500);
        // Typed plain-text error — not a stack trace, not JSON.
        const contentType = response.headers.get("content-type") ?? "";
        expect(contentType).toMatch(/text\/plain/);
        // A reasonable upper bound on a typed message body.
        expect(body.length).toBeLessThan(2_000);
        // Response must not leak internal paths or framework noise.
        expect(body).not.toMatch(/bun:|internal\/process|ENOENT/);
      }
    } finally {
      await service.stop();
    }
  });

  test("non-html frame routes continue to recover without an ensureGalleryBuild call", async () => {
    const { service } = await startEnv();
    try {
      // Wipe the entire dist/gallery tree so every frame route starts cold.
      const repoRoot = join(import.meta.dir, "..", "..");
      rmSync(join(repoRoot, "dist", "gallery"), { recursive: true, force: true });

      for (const type of ["markdown", "mermaid", "svg", "chart"]) {
        const response = await fetch(
          `${service.url}/gallery/frame?nonce=${"b".repeat(32)}&type=${type}`,
        );
        expect(response.status).toBe(200);
      }
    } finally {
      await service.stop();
    }
  });
});
