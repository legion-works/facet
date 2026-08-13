import { expect, test } from "bun:test";

import { readBackFixture, publishFixture } from "../helpers/facet-testkit";

const STABLE_FIXTURE = `${import.meta.dir}/../fixtures/tsx/interactive-source.tsx`;
const UNSTABLE_FIXTURE = `${import.meta.dir}/../fixtures/tsx/unstable-source.tsx`;
const THROWING_FIXTURE = `${import.meta.dir}/../fixtures/tsx/throwing-source.tsx`;
const REJECTED_FIXTURE = `${import.meta.dir}/../fixtures/tsx/rejected-source.tsx`;
const EMPTY_FIXTURE = `${import.meta.dir}/../fixtures/tsx/empty-source.tsx`;
const NON_COMPONENT_FIXTURE = `${import.meta.dir}/../fixtures/tsx/non-component-source.tsx`;
const NO_DEFAULT_FIXTURE = `${import.meta.dir}/../fixtures/tsx/no-default-source.tsx`;

test("interactive TSX records a nested-frame Tier 1 verdict", async () => {
  const published = await publishFixture({
    fixturePath: STABLE_FIXTURE,
    artifactType: "tsx",
    execution: "interactive",
    slug: "tsx-interactive-tier1",
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
      status: "ok",
      execution: "interactive",
      observed: expect.objectContaining({
        html: expect.objectContaining({ headingCount: 1 }),
        errorCount: 0,
        discriminativeErrors: [],
      }),
    }),
  );
}, 90_000);

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

test("interactive TSX component returning null remains an honest ok verdict", async () => {
  const published = await publishFixture({
    fixturePath: EMPTY_FIXTURE,
    artifactType: "tsx",
    execution: "interactive",
    slug: "tsx-interactive-empty",
    productionTier0: true,
  });

  expect(published.tier1Status).toBe("ok");
}, 90_000);

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
