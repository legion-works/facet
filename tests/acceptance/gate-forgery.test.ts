import { expect, test } from "bun:test";

import { publishFixture, readBackFixture } from "../helpers/facet-testkit";

const MONKEYPATCH_FIXTURE = `${import.meta.dir}/../fixtures/hostile-monkeypatch.json`;
const NESTED_SVG_FIXTURE = `${import.meta.dir}/../fixtures/hostile-svg-label.md`;

// Explicit budgets: a transport wedge on the shared launch path costs
// one watchdog interval (~10s) plus a relaunch before the verdict lands,
// so bun's 5s default is too tight for these browser-backed probes.
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
}, 150_000);

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
}, 30_000);
