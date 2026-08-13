import { expect, test } from "bun:test";

import { readBackFixture, publishFixture } from "../helpers/facet-testkit";

const UNSTABLE_FIXTURE = `${import.meta.dir}/../fixtures/tsx/unstable-source.tsx`;

test("interactive TSX reports delayed structure as unstable", async () => {
  const published = await publishFixture({
    fixturePath: UNSTABLE_FIXTURE,
    artifactType: "tsx",
    execution: "interactive",
    slug: "tsx-interactive-unstable",
    productionTier0: true,
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });

  expect(published.tier1Status).toBe("partial:unstable");
  expect(verdict).toEqual(
    expect.objectContaining({
      status: "partial:unstable",
      execution: "interactive",
      observed: expect.objectContaining({
        html: expect.objectContaining({ headingCount: 1, listCount: 1 }),
        errorCount: 0,
        discriminativeErrors: [],
      }),
    }),
  );
}, 90_000);
