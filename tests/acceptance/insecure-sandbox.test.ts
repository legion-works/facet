import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveNetnsWrapper } from "../../src/validation/tier1/launcher";
import {
  publishFixture,
  readBackFixture,
  stopAcceptanceServiceForTests,
  type AcceptanceVerdict,
} from "../helpers/facet-testkit";

const FIXTURE_PATH = `${import.meta.dir}/../fixtures/plain-markdown.md`;
const scratch = mkdtempSync(join(tmpdir(), "facet-insecure-sandbox-"));
const sentinel = join(scratch, "tier1-wrapper-attempted");
const directMarker = join(scratch, "tier0-direct-executed");
const wrapper = join(scratch, "recording-netns-wrapper.sh");
const realWrapper = resolveNetnsWrapper({
  wrapperPath: join(process.cwd(), "scripts", "launch-netns.sh"),
});

const TEST_ENV_KEYS = [
  "FACET_TIER1_NETNS_WRAPPER",
  "FACET_TIER0_FORCE_NETNS_UNAVAILABLE",
  "FACET_TIER0_DIRECT_EXEC_MARKER",
] as const;

type TestEnvKey = (typeof TEST_ENV_KEYS)[number];
type TestEnv = Readonly<Record<TestEnvKey, string | undefined>>;

function snapshotTestEnv(): TestEnv {
  return Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]])) as TestEnv;
}

function restoreTestEnv(snapshot: TestEnv): void {
  for (const key of TEST_ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function expectRunnableVerdict(verdict: AcceptanceVerdict, level?: 1 | 2): void {
  expect({
    status: verdict.status,
    errors: verdict.observed.discriminativeErrors,
    insecure: verdict.insecure,
  }).toMatchObject({
    status: expect.not.stringMatching(/^error$/),
    ...(level === undefined ? {} : { insecure: { level } }),
  });
}

async function withTestEnv<T>(
  overrides: Partial<TestEnv>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = snapshotTestEnv();
  try {
    for (const key of TEST_ENV_KEYS) {
      if (!(key in overrides)) continue;
      if (overrides[key] === undefined) delete process.env[key];
      else process.env[key] = overrides[key];
    }
    return await operation();
  } finally {
    restoreTestEnv(previous);
  }
}

const baselineEnv = snapshotTestEnv();

beforeAll(() => {
  writeFileSync(
    wrapper,
    `#!/bin/sh\nset -eu\nprintf attempted > ${JSON.stringify(sentinel)}\nexec ${JSON.stringify(realWrapper)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
});

afterAll(async () => {
  await stopAcceptanceServiceForTests();
  rmSync(scratch, { recursive: true, force: true });
});

describe("insecure sandbox launch paths", () => {
  test("level 0 attempts the production netns wrapper before a typed unavailable result", async () => {
    await withTestEnv({ FACET_TIER1_NETNS_WRAPPER: wrapper }, async () => {
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
        expectRunnableVerdict(verdict);
      }
    });
  }, 90_000);

  test("level 1 bypasses the wrapper and still returns a real browser verdict", async () => {
    await withTestEnv({ FACET_TIER1_NETNS_WRAPPER: wrapper }, async () => {
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
      expectRunnableVerdict(verdict, 1);
    });
  }, 90_000);

  test("level 2 directly executes Tier 0 when the netns probe is unavailable", async () => {
    await withTestEnv(
      {
        FACET_TIER0_FORCE_NETNS_UNAVAILABLE: "1",
        FACET_TIER0_DIRECT_EXEC_MARKER: directMarker,
      },
      async () => {
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
        expectRunnableVerdict(directVerdict, 2);

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
      },
    );
  }, 120_000);

  test("does not leave test-only launch overrides in process state", () => {
    for (const key of TEST_ENV_KEYS) expect(process.env[key]).toBe(baselineEnv[key]);
  });
});
