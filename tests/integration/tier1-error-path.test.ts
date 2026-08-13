/**
 * Regression test for the Tier 1 graceful-failure path (MUST fix).
 *
 * The dispatcher wraps the Tier 1 runner in `runTier1Safe` so a
 * thrown `FacetError` (browser spawn failure, timeout, protocol
 * error, …) becomes a recorded Tier 1 `error` render_run bound to
 * the revision requested through visual read-back.
 *
 * The synthetic Tier1Result the safe-wrapper constructs had
 * `artifactId: ""` — which `VerdictSchema.artifactId.min(1)` rejects
 * with a ZodError. The catch block then re-threw INSIDE its own try,
 * so the very graceful-failure path was unreachable: every Tier 1
 * failure used to abort the publish instead of recording an error
 * run.
 *
 * The fix threads the real `command.artifactId` through to the
 * synthetic result. This test pins the contract by injecting a
 * Tier 1 runner that ALWAYS throws, publishes a real revision,
 * then requests visual read-back and asserts:
 *
 *   1. publish returns 200 without launching Tier 1
 *   2. visual read-back returns a Tier1Result-shaped verdict
 *   3. the verdict artifactId equals the published artifact's id
 *   4. the verdict revisionSha equals the published revision sha
 *   5. the verdict status is `error`
 *   6. `discriminativeErrors[0].code` is the typed
 *      runner failure code
 *
 * The test MUST fail against the pre-fix `artifactId: ""` code. The
 * pre-fix path either aborts visual read-back with an internal-error
 * envelope or fails to record the error verdict.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FACET_SCHEMA_VERSION, FacetEnvelopeSchema } from "../../src/shared/contracts/envelope";
import { CommandResultSchema } from "../../src/shared/contracts/commands";
import { FacetError } from "../../src/shared/errors/facet-error";
import { startFacetService, type RunningService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import type { Tier1Input, Tier1Runner } from "../../src/shared/contracts/validation";

interface TestEnv {
  service: RunningService;
  baseUrl: string;
  installToken: string;
  cleanup: () => Promise<void>;
}

const scratchRoot = join(tmpdir(), `facet-tier1-err-${crypto.randomUUID()}`);

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
});

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

/**
 * A Tier 1 runner that ALWAYS throws a typed FacetError. The test
 * does NOT care about the specific failure mode — only that the
 * graceful-failure path in `runTier1Safe` produces a verdict bound
 * to the real (artifactId, revisionSha) the dispatcher committed.
 */
const alwaysFailingTier1Runner: Tier1Runner = async (_input: Tier1Input) => {
  throw new FacetError("tier1_browser_died", "test-injected: simulated browser death", {
    retryable: false,
  });
};

async function startServiceWithFailingTier1(): Promise<TestEnv> {
  const envDir = join(scratchRoot, crypto.randomUUID());
  mkdirSync(envDir, { recursive: true });
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 5_000,
    logger: createQuietLogger({ component: "tier1-error-test" }),
    tier0Runner: stubTier0Runner,
    tier1Runner: alwaysFailingTier1Runner,
  });
  return {
    service,
    baseUrl: service.url,
    installToken: service.installToken,
    cleanup: async () => {
      await service.stop();
    },
  };
}

async function envelopeRequest(env: TestEnv, body: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${env.installToken}`,
    host: new URL(env.baseUrl).host,
  };
  const innerRequestId = `req-${crypto.randomUUID()}`;
  const wrapped = {
    schemaVersion: FACET_SCHEMA_VERSION,
    requestId: innerRequestId,
    ok: true,
    data: { requestId: innerRequestId, ...(body as Record<string, unknown>) },
  };
  return fetch(`${env.baseUrl}/api/v1/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify(wrapped),
  });
}

describe("Tier 1 graceful-failure path binds to real artifactId+revisionSha", () => {
  test('a throwing tier1Runner records an error verdict bound to the published revision, not "" ', async () => {
    const env = await startServiceWithFailingTier1();
    try {
      // 1. Create the artifact.
      const createRes = await envelopeRequest(env, {
        command: "create",
        projectId: "project-tier1-err",
        slug: "fixture",
        title: "Fixture",
      });
      const createText = await createRes.text();
      const createEnv = FacetEnvelopeSchema.parse(JSON.parse(createText));
      expect(createEnv.ok).toBe(true);
      const createParsed = CommandResultSchema.parse(
        (createEnv as { ok: true; data: unknown }).data,
      );
      if (createParsed.command !== "create") throw new Error("expected create result");
      const artifactId = createParsed.artifact.id;

      // 2. Publish stays browser-free.
      const pubRes = await envelopeRequest(env, {
        command: "publish",
        artifactId,
        artifactType: "markdown",
        bytes: Buffer.from("# Hello tier1 graceful failure").toString("base64"),
      });
      expect(pubRes.status).toBe(200);
      const pubEnv = FacetEnvelopeSchema.parse(JSON.parse(await pubRes.text()));
      expect(pubEnv.ok).toBe(true);
      const pubParsed = CommandResultSchema.parse((pubEnv as { ok: true; data: unknown }).data);
      if (pubParsed.command !== "publish") throw new Error("expected publish result");
      const revisionSha = pubParsed.revision.sha256;

      expect(pubParsed.tier1Verdict).toBeUndefined();

      // 3. A visual request runs Tier 1 and records its typed failure.
      const rbRes = await envelopeRequest(env, {
        command: "readBack",
        artifactId,
        revisionSha,
        tier: 1,
      });
      const rbEnv = FacetEnvelopeSchema.parse(JSON.parse(await rbRes.text()));
      expect(rbEnv.ok).toBe(true);
      const rbParsed = CommandResultSchema.parse((rbEnv as { ok: true; data: unknown }).data);
      if (rbParsed.command !== "readBack") throw new Error("expected readBack result");
      expect(rbParsed.verdict.artifactId).toBe(artifactId);
      expect(rbParsed.verdict.artifactId).not.toBe("");
      expect(rbParsed.verdict.revisionSha).toBe(revisionSha);
      expect(rbParsed.verdict.status).toBe("error");
      expect((rbParsed.verdict.observed.discriminativeErrors ?? []).length).toBeGreaterThan(0);
      expect(rbParsed.verdict.observed.discriminativeErrors?.[0]?.code).toBe("tier1_browser_died");
    } finally {
      await env.cleanup();
    }
  });
});
