import { expect, test } from "bun:test";

import { readBackFixture, publishFixture } from "../helpers/facet-testkit";

const THROWING_FIXTURE = `${import.meta.dir}/../fixtures/tsx/throwing-source.tsx`;

test("interactive TSX runtime throw remains an error after its page marker is deleted", async () => {
  const published = await publishFixture({
    fixturePath: THROWING_FIXTURE,
    artifactType: "tsx",
    execution: "interactive",
    slug: "tsx-interactive-throwing",
    productionTier0: true,
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });

  expect(published.tier1Status).toBe("error");
  expect(verdict.observed.discriminativeErrors).toContainEqual(
    expect.objectContaining({ message: expect.stringContaining("interactive TSX render failure") }),
  );
}, 90_000);
