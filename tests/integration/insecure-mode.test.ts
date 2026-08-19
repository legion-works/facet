import { afterEach, describe, expect, test } from "bun:test";

import { FACET_SCHEMA_VERSION, FacetEnvelopeSchema } from "../../src/shared/contracts/envelope";
import { CommandResultSchema, type CommandResult } from "../../src/shared/contracts/commands";
import {
  type InsecureLevel,
  type Tier0Input,
  type Tier0WorkerResult,
  type Tier1Input,
  type Tier1Result,
  type Tier0Runner,
  type Tier1Runner,
} from "../../src/shared/contracts/validation";
import { startFacetService, type RunningService } from "../../src/service/server";
import { openDatabase } from "../../src/service/store/database";

interface TestEnv {
  readonly service: RunningService;
  readonly cleanup: () => Promise<void>;
}

const environments: TestEnv[] = [];

afterEach(async () => {
  for (const env of environments.splice(0)) await env.cleanup();
});

function observed(errorCount = 0) {
  return {
    rendererRootSvgCount: 1,
    graphCount: 0,
    mermaidNodeCount: 0,
    visibleSvgCount: 0,
    opaqueRegionCount: 0,
    externalImageCount: 0,
    errorCount,
    ...(errorCount > 0
      ? { discriminativeErrors: [{ code: "synthetic_test", message: "synthetic test result" }] }
      : {}),
  };
}

function runners(statuses: {
  readonly tier0: Tier0WorkerResult["status"];
  readonly tier1: Tier1Result["status"];
}): {
  readonly tier0: Tier0Runner;
  readonly tier1: Tier1Runner;
  readonly calls: { tier0: number; tier1: number };
} {
  const calls = { tier0: 0, tier1: 0 };
  const tier0: Tier0Runner = async (input: Tier0Input): Promise<Tier0WorkerResult> => {
    calls.tier0 += 1;
    return {
      tier: 0,
      status: statuses.tier0,
      revisionSha: input.revisionSha,
      expected: input.lexical,
      observed: observed(statuses.tier0 === "error" ? 1 : 0),
    };
  };
  const tier1: Tier1Runner = async (input: Tier1Input): Promise<Tier1Result> => {
    calls.tier1 += 1;
    return {
      tier: 1,
      status: statuses.tier1,
      artifactId: "worker-placeholder",
      revisionSha: input.revisionSha,
      expected: input.lexical,
      observed: observed(statuses.tier1 === "tampered" ? 1 : 0),
      screenshotPath: null,
      consolePath: null,
    };
  };
  return { tier0, tier1, calls };
}

async function startEnv(
  insecureLevel?: InsecureLevel,
  configured?: ReturnType<typeof runners>,
): Promise<TestEnv> {
  const service = await startFacetService({
    dbPath: `/tmp/facet-insecure-mode-${crypto.randomUUID()}.sqlite`,
    installTokenPath: `/tmp/facet-insecure-mode-${crypto.randomUUID()}.install`,
    promoteTokenPath: `/tmp/facet-insecure-mode-${crypto.randomUUID()}.promote`,
    lockPath: `/tmp/facet-insecure-mode-${crypto.randomUUID()}.lock`,
    idleTimeoutMs: 2_000,
    ...(insecureLevel === undefined ? {} : { insecureLevel }),
    tier0Runner:
      configured?.tier0 ??
      (async (input) => ({
        tier: 0,
        status: "ok" as const,
        revisionSha: input.revisionSha,
        expected: input.lexical,
        observed: observed(),
      })),
    ...(configured === undefined ? {} : { tier1Runner: configured.tier1 }),
  });
  const env = { service, cleanup: async () => service.stop() };
  environments.push(env);
  return env;
}

async function command(env: TestEnv, body: Record<string, unknown>): Promise<CommandResult> {
  const requestId = `req-${crypto.randomUUID()}`;
  const response = await fetch(`${env.service.url}/api/v1/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.service.installToken}`,
      host: new URL(env.service.url).host,
    },
    body: JSON.stringify({
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId,
      ok: true,
      data: { ...body, requestId },
    }),
  });
  const envelope = FacetEnvelopeSchema.parse(await response.json());
  if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
  return CommandResultSchema.parse(envelope.data);
}

async function publish(env: TestEnv): Promise<Extract<CommandResult, { command: "publish" }>> {
  const created = await command(env, {
    command: "create",
    projectId: "project",
    slug: crypto.randomUUID(),
    title: "test",
  });
  if (created.command !== "create") throw new Error("expected create result");
  const result = await command(env, {
    command: "publish",
    artifactId: created.artifact.id,
    artifactType: "markdown",
    bytes: Buffer.from("hello", "utf8").toString("base64"),
  });
  if (result.command !== "publish") throw new Error("expected publish result");
  return result;
}

async function visualReadBack(
  env: TestEnv,
  published: Extract<CommandResult, { command: "publish" }>,
): Promise<Extract<CommandResult, { command: "readBack" }>> {
  const result = await command(env, {
    command: "readBack",
    artifactId: published.revision.artifactId,
    revisionSha: published.revision.sha256,
    tier: 1,
  });
  if (result.command !== "readBack") throw new Error("expected readBack result");
  return result;
}

describe("insecure dispatcher semantics", () => {
  test("gallery source exposes insecure markers while keeping secure verdicts marker-free", async () => {
    const insecure = await startEnv(1, runners({ tier0: "ok", tier1: "ok" }));
    const insecurePublished = await publish(insecure);
    const insecureOpened = await command(insecure, {
      command: "open",
      artifactId: insecurePublished.revision.artifactId,
      revisionSha: insecurePublished.revision.sha256,
    });
    if (insecureOpened.command !== "open") throw new Error("expected insecure open result");
    const insecureSource = await fetch(
      `${insecure.service.url}/api/v1/gallery/source?revisionSha=${insecurePublished.revision.sha256}`,
      {
        headers: {
          authorization: `Bearer ${insecure.service.installToken}`,
          host: new URL(insecure.service.url).host,
          "x-gallery-lease": insecureOpened.lease.leaseId,
          "x-gallery-artifact": insecurePublished.revision.artifactId,
        },
      },
    );
    expect(insecureSource.status).toBe(200);
    const insecureBody = (await insecureSource.json()) as { verdict: { insecure?: unknown } };
    expect(insecureBody.verdict.insecure).toEqual({ level: 1, reason: expect.any(String) });

    const secure = await startEnv(undefined);
    const securePublished = await publish(secure);
    const secureOpened = await command(secure, {
      command: "open",
      artifactId: securePublished.revision.artifactId,
      revisionSha: securePublished.revision.sha256,
    });
    if (secureOpened.command !== "open") throw new Error("expected secure open result");
    const secureSource = await fetch(
      `${secure.service.url}/api/v1/gallery/source?revisionSha=${securePublished.revision.sha256}`,
      {
        headers: {
          authorization: `Bearer ${secure.service.installToken}`,
          host: new URL(secure.service.url).host,
          "x-gallery-lease": secureOpened.lease.leaseId,
          "x-gallery-artifact": securePublished.revision.artifactId,
        },
      },
    );
    expect(secureSource.status).toBe(200);
    const secureBody = (await secureSource.json()) as { verdict: { insecure?: unknown } };
    expect(secureBody.verdict.insecure).toBeUndefined();
  });

  test.each([1, 2] as const)(
    "level %d runs Tier 1 only on explicit visual read-back and marks every verdict",
    async (level) => {
      const configured = runners({ tier0: "error", tier1: "tampered" });
      const env = await startEnv(level, configured);
      const result = await publish(env);

      expect(configured.calls).toEqual({ tier0: 1, tier1: 0 });
      expect(result.verdict).toMatchObject({
        status: "error",
        insecure: { level, reason: expect.any(String) },
      });
      const tier1 = await visualReadBack(env, result);
      expect(configured.calls).toEqual({ tier0: 1, tier1: 1 });
      expect(tier1.verdict).toMatchObject({
        status: "tampered",
        insecure: { level, reason: expect.any(String) },
      });
    },
  );

  test.each([1, 2] as const)("level %d preserves markers when runners throw", async (level) => {
    const env = await startEnv(level, {
      tier0: async () => {
        throw new Error("tier0 runner failed");
      },
      tier1: async () => {
        throw new Error("tier1 runner failed");
      },
      calls: { tier0: 0, tier1: 0 },
    });
    const result = await publish(env);

    expect(result.verdict).toMatchObject({ insecure: { level } });
    const tier1 = await visualReadBack(env, result);
    expect(tier1.verdict).toMatchObject({ insecure: { level } });
  });

  test("level 3 skips both runners and records a zero-valued unvalidated verdict", async () => {
    const configured = runners({ tier0: "error", tier1: "tampered" });
    const env = await startEnv(3, configured);
    const result = await publish(env);

    expect(configured.calls).toEqual({ tier0: 0, tier1: 0 });
    const verdict = result.verdict;
    if (verdict === undefined) throw new Error("expected level-3 publish verdict");
    expect(verdict).toEqual({
      status: "insecure:unvalidated",
      tier: 0,
      artifactId: verdict.artifactId,
      revisionSha: result.revision.sha256,
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        externalImageCount: 0,
        errorCount: 0,
      },
      insecure: { level: 3, reason: expect.any(String) },
    });

    const readBack = await command(env, {
      command: "readBack",
      artifactId: result.revision.artifactId,
      revisionSha: result.revision.sha256,
      tier: 0,
    });
    if (readBack.command !== "readBack") throw new Error("expected read-back result");
    expect(readBack.verdict.status).toBe("insecure:unvalidated");
    expect(readBack.verdict.observed).toEqual(verdict.observed);
    expect(readBack.verdict.insecure).toEqual(verdict.insecure);
  });

  test("auto-downgraded publish persists the auto reason in render_runs", async () => {
    const dbPath = `/tmp/facet-insecure-auto-persist-${crypto.randomUUID()}.sqlite`;
    const service = await startFacetService({
      dbPath,
      installTokenPath: `${dbPath}.install`,
      promoteTokenPath: `${dbPath}.promote`,
      lockPath: `${dbPath}.lock`,
      idleTimeoutMs: 2_000,
      insecureLevel: 1,
      insecureReason: "auto:tier 1 unavailable",
      tier0Runner: async (input) => ({
        tier: 0,
        status: "ok" as const,
        revisionSha: input.revisionSha,
        expected: input.lexical,
        observed: observed(),
      }),
    });
    const env = { service, cleanup: async () => service.stop() };
    environments.push(env);
    const result = await publish(env);
    const db = openDatabase(dbPath);
    try {
      const row = db.query("SELECT insecure_json FROM render_runs LIMIT 1").get() as {
        insecure_json: string | null;
      };
      expect(row.insecure_json).toBe(
        JSON.stringify({ level: 1, reason: "auto:tier 1 unavailable" }),
      );
      expect(result.verdict?.insecure).toEqual({ level: 1, reason: "auto:tier 1 unavailable" });
    } finally {
      db.close();
    }
  });

  test.each([undefined, 0] as const)(
    "secure publish stays byte-identical for level %s",
    async (level) => {
      const env = await startEnv(level);
      const result = await publish(env);
      const baseline = {
        requestId: result.requestId,
        command: "publish" as const,
        revision: result.revision,
        verdict: result.verdict,
      };
      expect(JSON.stringify(result)).toBe(JSON.stringify(baseline));
      expect(JSON.stringify(result)).not.toContain("insecure");
      expect(result.verdict?.insecure).toBeUndefined();
    },
  );
});
