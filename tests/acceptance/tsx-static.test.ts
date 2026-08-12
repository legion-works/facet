import { expect, test } from "bun:test";

import { publishFixture, readBackFixture } from "../helpers/facet-testkit";

const STATIC_FIXTURE = `${import.meta.dir}/../fixtures/tsx/static-source.tsx`;

test("static TSX renders through the shared HTML path in Tier 1", async () => {
  const published = await publishFixture({
    fixturePath: STATIC_FIXTURE,
    artifactType: "tsx",
    slug: "tsx-static-html-path",
    productionTier0: true,
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });

  expect({ status: published.tier1Status, observed: verdict.observed }).toEqual({
    status: "ok",
    observed: expect.objectContaining({
      html: expect.objectContaining({ rendererRootCount: 1 }),
      errorCount: 0,
    }),
  });
  expect(verdict.execution).toBe("static");
}, 90_000);
