import { expect, test } from "bun:test";

import { readBackFixture, publishFixture } from "../helpers/facet-testkit";

const INTERACTIVE_STARTER = `${import.meta.dir}/../../templates/tsx-interactive-counter.tsx`;

test("the interactive starter mounts its component-owned heading", async () => {
  const published = await publishFixture({
    fixturePath: INTERACTIVE_STARTER,
    artifactType: "tsx",
    execution: "interactive",
    slug: "tsx-interactive-starter-mount",
    productionTier0: true,
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });

  expect(published.tier1Status).toBe("ok");
  expect(verdict).toEqual(
    expect.objectContaining({
      execution: "interactive",
      observed: expect.objectContaining({
        html: expect.objectContaining({ headingCount: 1 }),
        errorCount: 0,
      }),
    }),
  );
}, 90_000);
