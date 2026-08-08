import { expect, test } from "bun:test";

import { publishFixture, stopAcceptanceServiceForTests } from "../helpers/facet-testkit";

const FIXTURE = `${import.meta.dir}/../fixtures/hostile-svg-label.md`;

test("acceptance harness restarts a cached service after it stops", async () => {
  const first = await publishFixture({
    fixturePath: FIXTURE,
    artifactType: "markdown",
    slug: "harness-recovery-before-stop",
  });
  await stopAcceptanceServiceForTests();
  const second = await publishFixture({
    fixturePath: FIXTURE,
    artifactType: "markdown",
    slug: "harness-recovery-after-stop",
  });

  expect(second.artifactId).not.toBe(first.artifactId);
  expect(second.revisionSha).toBe(first.revisionSha);
});
