import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import {
  artifactWorld,
  galleryBrowser,
  navigateToArtifact,
  setGalleryViewport,
} from "../helpers/gallery-live";

const HTML_BLOCKS = `<div class="bg-base-200 p-4">first block</div><p class="p-4">second block</p>`;
const TSX_BLOCKS = `import React from "react";
export default function FlowFixture() {
  return <><section>first block</section><section>second block</section></>;
}`;

async function readTopLevelRects(
  target: Awaited<ReturnType<ReturnType<typeof galleryBrowser>["launch"]>>,
): Promise<readonly { top: number; bottom: number; left: number }[]> {
  const world = await artifactWorld(target);
  const result = (await target.session.send("Runtime.evaluate", {
    contextId: world,
    returnByValue: true,
    expression: `Array.from(document.querySelector('[data-facet-renderer-root]')?.children ?? []).map((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left };
    })`,
  })) as { result?: { value?: readonly { top: number; bottom: number; left: number }[] } };
  return result.result?.value ?? [];
}

function expectVerticalFlow(rects: readonly { top: number; bottom: number; left: number }[]): void {
  expect(rects).toHaveLength(2);
  expect(rects[1]!.top).toBeGreaterThanOrEqual(rects[0]!.bottom - 2);
  expect(Math.abs(rects[1]!.left - rects[0]!.left)).toBeLessThanOrEqual(2);
}

test("gallery preserves document flow for top-level HTML and interactive TSX blocks", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-top-level-flow-"));
  const tier0Runner = createTier0RunnerForTests(0, {});
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-top-level-flow" }),
    tier0Runner,
  });
  const browser = galleryBrowser();
  let target: Awaited<ReturnType<typeof browser.launch>> | undefined;
  try {
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    target = await browser.launch();
    await setGalleryViewport(target, 1280, 800);

    await navigateToArtifact(target, client, "html", HTML_BLOCKS, undefined, {
      slug: "gallery-top-level-flow-html",
    });
    const htmlRects = await readTopLevelRects(target);

    await navigateToArtifact(target, client, "tsx", TSX_BLOCKS, "interactive", {
      slug: "gallery-top-level-flow-tsx",
    });
    const tsxRects = await readTopLevelRects(target);

    expectVerticalFlow(htmlRects);
    expectVerticalFlow(tsxRects);
  } finally {
    await target?.close();
    await service.stop();
    tier0Runner.close?.();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 90_000);
