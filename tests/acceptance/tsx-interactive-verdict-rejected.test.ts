import { expect, test } from "bun:test";

import { readBackFixture, publishFixture } from "../helpers/facet-testkit";

const REJECTED_FIXTURE = `${import.meta.dir}/../fixtures/tsx/rejected-source.tsx`;

test("interactive TSX async rejection is an error", async () => {
  const published = await publishFixture({
    fixturePath: REJECTED_FIXTURE,
    artifactType: "tsx",
    execution: "interactive",
    slug: "tsx-interactive-rejected",
    productionTier0: true,
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });

  expect(published.tier1Status).toBe("error");
  expect(verdict.observed.discriminativeErrors).toContainEqual(
    expect.objectContaining({ message: expect.stringContaining("interactive TSX async failure") }),
  );
}, 90_000);
