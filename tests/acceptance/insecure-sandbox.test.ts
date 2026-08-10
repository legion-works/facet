import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveNetnsWrapper } from "../../src/validation/tier1/launcher";
import {
  publishFixture,
  readBackFixture,
  stopAcceptanceServiceForTests,
} from "../helpers/facet-testkit";

const FIXTURE_PATH = `${import.meta.dir}/../fixtures/plain-markdown.md`;
const scratch = mkdtempSync(join(tmpdir(), "facet-insecure-sandbox-"));
const sentinel = join(scratch, "tier1-wrapper-attempted");
const directMarker = join(scratch, "tier0-direct-executed");
const wrapper = join(scratch, "recording-netns-wrapper.sh");
const realWrapper = resolveNetnsWrapper({
  wrapperPath: join(process.cwd(), "scripts", "launch-netns.sh"),
});

const previousWrapper = process.env.FACET_TIER1_NETNS_WRAPPER;
const previousProbe = process.env.FACET_TIER0_FORCE_NETNS_UNAVAILABLE;
const previousDirect = process.env.FACET_TIER0_DIRECT_EXEC_MARKER;

beforeAll(() => {
  writeFileSync(
    wrapper,
    `#!/bin/sh\nset -eu\nprintf attempted > ${JSON.stringify(sentinel)}\nexec ${JSON.stringify(realWrapper)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  process.env.FACET_TIER1_NETNS_WRAPPER = wrapper;
});

afterAll(async () => {
  await stopAcceptanceServiceForTests();
  if (previousWrapper === undefined) delete process.env.FACET_TIER1_NETNS_WRAPPER;
  else process.env.FACET_TIER1_NETNS_WRAPPER = previousWrapper;
  if (previousProbe === undefined) delete process.env.FACET_TIER0_FORCE_NETNS_UNAVAILABLE;
  else process.env.FACET_TIER0_FORCE_NETNS_UNAVAILABLE = previousProbe;
  if (previousDirect === undefined) delete process.env.FACET_TIER0_DIRECT_EXEC_MARKER;
  else process.env.FACET_TIER0_DIRECT_EXEC_MARKER = previousDirect;
  rmSync(scratch, { recursive: true, force: true });
});

describe("insecure sandbox launch paths", () => {
  test("level 0 attempts the production netns wrapper before a typed unavailable result", async () => {
    const published = await publishFixture({
      fixturePath: FIXTURE_PATH,
      artifactType: "markdown",
      screenshotMode: "live",
      insecureLevel: 0,
    });
    expect(existsSync(sentinel)).toBe(true);
    const verdict = await readBackFixture({
      artifactId: published.artifactId,
      revisionSha: published.revisionSha,
      tier: 1,
      insecureLevel: 0,
    });
    if (verdict.status === "error") {
      expect(verdict.observed.discriminativeErrors?.map((error) => error.code)).toContain(
        "tier1_unavailable",
      );
    } else {
      expect(verdict.status).not.toBe("error");
    }
  }, 90_000);

  test("level 1 bypasses the wrapper and still returns a real browser verdict", async () => {
    rmSync(sentinel, { force: true });
    const published = await publishFixture({
      fixturePath: FIXTURE_PATH,
      artifactType: "markdown",
      screenshotMode: "live",
      insecureLevel: 1,
    });
    expect(existsSync(sentinel)).toBe(false);
    const verdict = await readBackFixture({
      artifactId: published.artifactId,
      revisionSha: published.revisionSha,
      tier: 1,
      insecureLevel: 1,
    });
    expect(verdict.status).not.toBe("error");
    expect(verdict.insecure).toMatchObject({ level: 1 });
  }, 90_000);

  test("level 2 directly executes Tier 0 when the netns probe is unavailable", async () => {
    process.env.FACET_TIER0_FORCE_NETNS_UNAVAILABLE = "1";
    process.env.FACET_TIER0_DIRECT_EXEC_MARKER = directMarker;
    const level2 = await publishFixture({
      fixturePath: FIXTURE_PATH,
      artifactType: "markdown",
      screenshotMode: "deterministic",
      insecureLevel: 2,
      productionTier0: true,
    });
    expect(existsSync(directMarker)).toBe(true);
    const directVerdict = await readBackFixture({
      artifactId: level2.artifactId,
      revisionSha: level2.revisionSha,
      tier: 0,
      insecureLevel: 2,
      productionTier0: true,
    });
    expect(directVerdict.status).not.toBe("error");
    expect(directVerdict.insecure).toMatchObject({ level: 2 });

    unlinkSync(directMarker);
    const level0 = await publishFixture({
      fixturePath: FIXTURE_PATH,
      artifactType: "markdown",
      screenshotMode: "deterministic",
      insecureLevel: 0,
      productionTier0: true,
    });
    const secureVerdict = await readBackFixture({
      artifactId: level0.artifactId,
      revisionSha: level0.revisionSha,
      tier: 0,
      insecureLevel: 0,
      productionTier0: true,
    });
    expect(secureVerdict.status).toBe("error");
    expect(secureVerdict.observed.discriminativeErrors?.map((error) => error.code)).toContain(
      "tier0_unavailable",
    );
    expect(existsSync(directMarker)).toBe(false);
  }, 120_000);
});
