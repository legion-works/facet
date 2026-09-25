import { expect, test } from "bun:test";
import { publishFixture, readBackFixture } from "../helpers/facet-testkit";

const FIXTURE_PATH = `${import.meta.dir}/../fixtures/chart-barline.vl.json`;

test("canvas chart records an opaque-content Tier 1 verdict with screenshot evidence", async () => {
  const published = await publishFixture({
    fixturePath: FIXTURE_PATH,
    artifactType: "chart",
    renderer: "canvas",
    slug: "canvas-chart-tier1",
    screenshotMode: "deterministic",
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });
  expect(verdict.status).toBe("partial:opaque_content");
  expect(verdict.observed.opaqueRegionCount).toBeGreaterThanOrEqual(1);
  expect(verdict.renderer).toBe("canvas");
  expect(published.tier1ScreenshotPath).not.toBeNull();
}, 90_000);
