import { expect, test } from "bun:test";

import { publishFixture, readBackFixture } from "../helpers/facet-testkit";

const UNSTABLE_FIXTURE = `${import.meta.dir}/../fixtures/tsx/unstable-source.tsx`;
const STABLE_FIXTURE = `${import.meta.dir}/../fixtures/tsx/interactive-source.tsx`;

test("a stable interactive verdict records forced screenshot loss", async () => {
  const published = await publishFixture({
    fixturePath: STABLE_FIXTURE,
    artifactType: "tsx",
    execution: "interactive",
    slug: "tsx-stable-screenshot-unavailable",
    screenshotMode: "fail",
    productionTier0: true,
  });

  expect({
    status: published.tier1Status,
    screenshotPath: published.tier1ScreenshotPath,
    screenshotError: published.tier1ScreenshotError,
  }).toEqual({
    status: "ok",
    screenshotPath: null,
    screenshotError: expect.objectContaining({ code: "screenshot_unavailable" }),
  });
}, 90_000);

test("an unstable interactive TSX verdict keeps a typed screenshot marker when capture fails", async () => {
  const published = await publishFixture({
    fixturePath: UNSTABLE_FIXTURE,
    artifactType: "tsx",
    execution: "interactive",
    slug: "tsx-unstable-screenshot-unavailable",
    screenshotMode: "fail",
    productionTier0: true,
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
    productionTier0: true,
  });

  expect({
    status: published.tier1Status,
    execution: verdict.execution,
    observed: verdict.observed,
    screenshotPath: published.tier1ScreenshotPath,
    screenshotError: published.tier1ScreenshotError,
    retainedPath: published.tier1ScreenshotPath,
  }).toEqual({
    status: "partial:unstable",
    execution: "interactive",
    observed: expect.objectContaining({
      html: expect.objectContaining({ rendererRootCount: 1, headingCount: 1, listCount: 1 }),
      errorCount: 0,
      discriminativeErrors: [],
    }),
    screenshotPath: null,
    screenshotError: expect.objectContaining({ code: "screenshot_unavailable" }),
    retainedPath: null,
  });
  expect(verdict.screenshotError).toEqual(
    expect.objectContaining({ code: "screenshot_unavailable" }),
  );
}, 90_000);
