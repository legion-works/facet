import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { artifactBlockRects, galleryBrowser, navigateToArtifact } from "../helpers/gallery-live";

test("gallery frame geometry stacks markdown blocks vertically", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-geometry-"));
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-geometry" }),
    tier0Runner: stubTier0Runner,
  });
  const browser = galleryBrowser();
  let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
  try {
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    target = await browser.launch();
    await navigateToArtifact(
      target,
      client,
      "markdown",
      "# Q3 ingest pipeline — status\n\nSummary of the current release.\n\n| Stage | State |\n| --- | --- |\n| Ingest | Ready |\n\n## Next\n\n- Publish\n- Verify",
    );
    const blocks = await artifactBlockRects(target);
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (let index = 1; index < blocks.length; index += 1) {
      const previous = blocks[index - 1]!;
      const next = blocks[index]!;
      expect(next.top).toBeGreaterThanOrEqual(previous.bottom - 2);
      expect(Math.abs(next.left - blocks[0]!.left)).toBeLessThanOrEqual(2);
    }
  } finally {
    await target?.close();
    await service.stop();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 45_000);
