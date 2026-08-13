import { expect, test } from "bun:test";

import { readBackFixture, publishFixture } from "../helpers/facet-testkit";

const NON_COMPONENT_FIXTURE = `${import.meta.dir}/../fixtures/tsx/non-component-source.tsx`;
const NO_DEFAULT_FIXTURE = `${import.meta.dir}/../fixtures/tsx/no-default-source.tsx`;

test("interactive TSX non-component default export is an error", async () => {
  const published = await publishFixture({
    fixturePath: NON_COMPONENT_FIXTURE,
    artifactType: "tsx",
    execution: "interactive",
    slug: "tsx-interactive-non-component",
    productionTier0: true,
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });

  expect(published.tier1Status).toBe("error");
  expect(verdict.observed.discriminativeErrors).toContainEqual(
    expect.objectContaining({ code: "runtime_exception" }),
  );
}, 90_000);

test("interactive TSX without a default export is rejected before Tier 1", async () => {
  const published = await publishFixture({
    fixturePath: NO_DEFAULT_FIXTURE,
    artifactType: "tsx",
    execution: "interactive",
    slug: "tsx-interactive-no-default",
    productionTier0: true,
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 0,
  });

  expect(published.tier1Status).toBeNull();
  expect(verdict.status).toBe("error");
  expect(verdict.observed.discriminativeErrors).toContainEqual(
    expect.objectContaining({ code: "tsx_compile_error" }),
  );
}, 90_000);
