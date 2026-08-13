import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { publishFixture, readBackFixture } from "../helpers/facet-testkit";

const STATIC_FIXTURE = `${import.meta.dir}/../fixtures/tsx/static-source.tsx`;

test("static TSX renders through the shared HTML path in Tier 1", async () => {
  const published = await publishFixture({
    fixturePath: STATIC_FIXTURE,
    artifactType: "tsx",
    execution: "static",
    slug: "tsx-static-html-path",
    productionTier0: true,
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });

  expect({
    status: published.tier1Status,
    execution: verdict.execution,
    observed: verdict.observed,
    screenshotPath: published.tier1ScreenshotPath,
    screenshotError: published.tier1ScreenshotError,
  }).toEqual({
    status: "ok",
    execution: "static",
    observed: {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 0,
      html: {
        rendererRootCount: 1,
        headingCount: 0,
        tableCount: 0,
        listCount: 0,
        imageCount: 0,
        canvasCount: 0,
        externalImageCount: 0,
      },
      viewBoxes: [],
      errorCount: 0,
      discriminativeErrors: [],
    },
    screenshotPath: expect.any(String),
    screenshotError: null,
  });
  expect(existsSync(published.tier1ScreenshotPath!)).toBe(true);
}, 90_000);
