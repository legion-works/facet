import { expect, test } from "bun:test";

import { publishFixture, readBackFixture } from "../helpers/facet-testkit";

const fixture = (name: string): string => `${import.meta.dir}/../fixtures/${name}`;

async function publishHtml(
  name: string,
  slug: string,
  screenshotMode: "live" | "deterministic" = "live",
) {
  const published = await publishFixture({
    fixturePath: fixture(name),
    artifactType: "html",
    slug,
    screenshotMode,
    productionTier0: true,
  });
  const tier = name === "html-http-image.html" ? 0 : published.tier1Status === null ? 0 : 1;
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier,
    productionTier0: true,
  });
  return { published, verdict };
}

test("real HTML pipeline derives the complete structural status matrix", async () => {
  const clean = await publishHtml("html-clean.html", "html-matrix-clean");
  expect(clean.verdict.status).toBe("ok");
  expect(clean.verdict.observed.html).toEqual({
    rendererRootCount: 1,
    headingCount: 2,
    tableCount: 1,
    listCount: 1,
    imageCount: 0,
    canvasCount: 0,
    externalImageCount: 0,
  });

  const embedded = await publishHtml("html-data-image.html", "html-matrix-data");
  expect(embedded.verdict.status).toBe("ok");

  const canvas = await publishHtml("html-canvas.html", "html-matrix-canvas", "deterministic");
  expect(canvas.verdict.status).toBe("partial:opaque_content");
  expect(canvas.verdict.observed.html?.canvasCount).toBe(1);

  const external = await publishHtml(
    "html-external-image.html",
    "html-matrix-external",
    "deterministic",
  );
  expect(external.verdict.status).toBe("partial:external_resources");
  expect(external.verdict.observed.html?.externalImageCount).toBe(1);
  expect(external.published.tier1ScreenshotPath).not.toBeNull();

  const malformed = await publishHtml(
    "html-malformed-data-image.html",
    "html-matrix-malformed-data",
  );
  expect(malformed.verdict.status).toBe("ok");
  expect(malformed.verdict.status).not.toBe("tampered");

  const relative = await publishHtml("html-relative-image.html", "html-matrix-relative");
  expect(relative.verdict.status).toBe("ok");
  expect(relative.verdict.status).not.toBe("tampered");

  const forged = await publishHtml("html-shim-divergence.json", "html-matrix-forged");
  expect(forged.verdict.status).toBe("tampered");

  const http = await publishHtml("html-http-image.html", "html-matrix-http");
  expect(http.verdict.status).toBe("error");
  expect(http.published.tier1Status).toBeNull();
}, 180_000);
