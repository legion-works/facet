import { expect, test } from "bun:test";

import { publishFixture, readBackFixture } from "../helpers/facet-testkit";

const SMUGGLE_FIXTURE = `${import.meta.dir}/../fixtures/hostile-canvas-smuggle.json`;
const LAYOUT_FIXTURE = `${import.meta.dir}/../fixtures/plain-markdown.md`;

function expectScreenshotUnavailable(value: unknown): void {
  expect(value).toMatchObject({
    code: "screenshot_unavailable",
    message: expect.stringContaining("screenshot"),
  });
}

test("opaque verdict survives a forced screenshot failure with evidence annotation", async () => {
  const published = await publishFixture({
    fixturePath: SMUGGLE_FIXTURE,
    artifactType: "markdown",
    slug: "opaque-screenshot-unavailable",
    screenshotMode: "fail",
  });
  expect(published.tier1Status).toBe("partial:opaque_content");
  expect(published.tier1ScreenshotPath).toBeNull();
  expectScreenshotUnavailable(published.tier1ScreenshotError);

  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });
  expect(verdict.status).toBe("partial:opaque_content");
  expectScreenshotUnavailable(verdict.screenshotError);
}, 90_000);

test("layout verdict survives a forced screenshot failure with evidence annotation", async () => {
  const published = await publishFixture({
    fixturePath: LAYOUT_FIXTURE,
    artifactType: "markdown",
    slug: "layout-screenshot-unavailable",
    screenshotMode: "fail",
  });
  expect(published.tier1Status).toBe("partial:layout_unverified");
  expect(published.tier1ScreenshotPath).toBeNull();
  expectScreenshotUnavailable(published.tier1ScreenshotError);

  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });
  expect(verdict.status).toBe("partial:layout_unverified");
  expectScreenshotUnavailable(verdict.screenshotError);
}, 90_000);
