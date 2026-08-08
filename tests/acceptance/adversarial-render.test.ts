import { expect, test } from "bun:test";

import { publishFixture, readBackFixture } from "../helpers/facet-testkit";

const FIXTURE_PATH = `${import.meta.dir}/../fixtures/adversarial-md-mermaid.md`;

test("40-node / two-Mermaid fixture renders Tier-1 with two renderer-root SVGs bound to the revision sha", async () => {
  const published = await publishFixture({
    fixturePath: FIXTURE_PATH,
    artifactType: "markdown",
    slug: "adversarial-md-mermaid",
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
    observed: { rendererRootSvgCount: 2, errorCount: 0 },
  });
  // 30s budget: a transport wedge on the launch path costs one watchdog
  // interval plus a relaunch before the verdict lands.
}, 30_000);
