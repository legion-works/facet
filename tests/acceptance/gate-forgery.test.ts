import { expect, test } from "bun:test";

import { publishFixture, readBackFixture } from "../helpers/facet-testkit";

const MONKEYPATCH_FIXTURE = `${import.meta.dir}/../fixtures/hostile-monkeypatch.json`;
const NESTED_SVG_FIXTURE = `${import.meta.dir}/../fixtures/hostile-svg-label.md`;
const CANVAS_SMUGGLE_FIXTURE = `${import.meta.dir}/../fixtures/hostile-canvas-smuggle.json`;
const CANVAS_MONKEYPATCH_FIXTURE = `${import.meta.dir}/../fixtures/hostile-canvas-monkeypatch.json`;

// Explicit budget ordering: the Tier 1 render barrier (30s) must report
// before the overall verifier budget (60s), and this test must remain alive
// long enough to observe that typed result. A hostile page that withholds
// render-complete must become a verdict, not a test-process timeout.
test("monkeypatched in-page shim cannot forge the verdict: protocol authority wins over a forged 2/0 page report", async () => {
  const published = await publishFixture({
    fixturePath: MONKEYPATCH_FIXTURE,
    artifactType: "markdown",
    slug: "hostile-monkeypatch",
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });
  expect(verdict.status).toBe("tampered");
}, 90_000);

test("undeclared canvas smuggling is capped as opaque content", async () => {
  const published = await publishFixture({
    fixturePath: CANVAS_SMUGGLE_FIXTURE,
    artifactType: "markdown",
    slug: "hostile-canvas-smuggle",
    screenshotMode: "deterministic",
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });
  expect(verdict.status).toBe("partial:opaque_content");
  expect(verdict.observed.opaqueRegionCount).toBe(1);
}, 90_000);

test("forged page-world canvas count is tampered", async () => {
  const published = await publishFixture({
    fixturePath: CANVAS_MONKEYPATCH_FIXTURE,
    artifactType: "markdown",
    slug: "hostile-canvas-monkeypatch",
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });
  expect(verdict.status).toBe("tampered");
  expect(verdict.observed.opaqueRegionCount).toBe(1);
}, 90_000);

test('nested-SVG forgery probe: one renderer-root SVG and one g.node graph even with an embedded <svg id="forged">', async () => {
  const published = await publishFixture({
    fixturePath: NESTED_SVG_FIXTURE,
    artifactType: "markdown",
    slug: "hostile-svg-label",
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });
  expect(verdict).toMatchObject({
    status: "ok",
    tier: 1,
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    observed: {
      rendererRootSvgCount: 1,
      graphCount: 1,
      errorCount: 0,
    },
  });
}, 90_000);
