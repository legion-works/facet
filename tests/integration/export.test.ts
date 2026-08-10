import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFacetService } from "../../src/service/server";
import { openDatabase } from "../../src/service/store/database";
import { CommandResultSchema } from "../../src/shared/contracts/commands";
import { FACET_SCHEMA_VERSION } from "../../src/shared/contracts/envelope";
import type {
  Tier0Input,
  Tier0Result,
  Tier0Runner,
  Tier1Input,
  Tier1Result,
  Tier1Runner,
} from "../../src/shared/contracts/validation";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";

type Running = Awaited<ReturnType<typeof startFacetService>>;
type TestEnv = {
  service: Running;
  envDir: string;
  dbPath: string;
  installTokenPath: string;
  promoteTokenPath: string;
  lockPath: string;
};

const scratchRoot = mkdtempSync(join(tmpdir(), "facet-export-test-"));
const SOURCE_ONE = new Uint8Array([0, 1, 2, 255, 10, 13]);
const SOURCE_TWO = new Uint8Array([9, 8, 7, 6]);
const OBSERVED = {
  rendererRootSvgCount: 1,
  graphCount: 0,
  mermaidNodeCount: 0,
  visibleSvgCount: 1,
  opaqueRegionCount: 0,
  errorCount: 0,
};

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

async function startEnv(
  opts: {
    envDir?: string;
    insecureLevel?: 0 | 1 | 2 | 3;
    tier0Runner?: Tier0Runner;
    tier1Runner?: Tier1Runner;
  } = {},
): Promise<TestEnv> {
  const envDir = opts.envDir ?? join(scratchRoot, crypto.randomUUID());
  mkdirSync(join(envDir, "evidence"), { recursive: true });
  const dbPath = join(envDir, "facet.sqlite");
  const installTokenPath = join(envDir, "install.token");
  const promoteTokenPath = join(envDir, "promote.token");
  const lockPath = join(envDir, "facet.lock");
  const previousFacetHome = process.env.FACET_HOME;
  process.env.FACET_HOME = envDir;
  try {
    const service = await startFacetService({
      dbPath,
      installTokenPath,
      promoteTokenPath,
      lockPath,
      idleTimeoutMs: 5_000,
      logger: createQuietLogger({ component: "export-test" }),
      tier0Runner: opts.tier0Runner ?? stubTier0Runner,
      ...(opts.insecureLevel !== undefined ? { insecureLevel: opts.insecureLevel } : {}),
      ...(opts.tier1Runner !== undefined ? { tier1Runner: opts.tier1Runner } : {}),
    });
    return { service, envDir, dbPath, installTokenPath, promoteTokenPath, lockPath };
  } finally {
    if (previousFacetHome === undefined) delete process.env.FACET_HOME;
    else process.env.FACET_HOME = previousFacetHome;
  }
}

async function request(env: TestEnv, command: Record<string, unknown>): Promise<Response> {
  const requestId = `req-${crypto.randomUUID()}`;
  return fetch(`${env.service.url}/api/v1/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.service.installToken}`,
      "content-type": "application/json",
      host: new URL(env.service.url).host,
    },
    body: JSON.stringify({
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId,
      ok: true,
      data: { requestId, ...command },
    }),
  });
}

async function result(
  env: TestEnv,
  command: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await request(env, command);
  const body = (await response.json()) as { ok: boolean; data?: unknown; error?: unknown };
  if (!body.ok) throw new Error(`request failed: ${JSON.stringify(body.error)}`);
  return CommandResultSchema.parse(body.data) as Record<string, any>;
}

async function createArtifact(env: TestEnv, slug: string): Promise<string> {
  const created = await result(env, {
    command: "create",
    projectId: "project-1",
    slug,
    title: slug,
  });
  return created.artifact.id as string;
}

async function publish(
  env: TestEnv,
  artifactId: string,
  source: Uint8Array,
): Promise<{ revisionSha: string; revisionNumber: number }> {
  const published = await result(env, {
    command: "publish",
    artifactId,
    artifactType: "markdown",
    bytes: Buffer.from(source).toString("base64"),
  });
  return {
    revisionSha: published.revision.sha256 as string,
    revisionNumber: published.revision.revisionNumber as number,
  };
}

function tier1(status: Tier1Result["status"]): Tier1Runner {
  return async (input: Tier1Input): Promise<Tier1Result> => ({
    tier: 1,
    status,
    artifactId: input.artifactType,
    revisionSha: input.revisionSha,
    expected: input.lexical,
    observed: OBSERVED,
    screenshotPath: null,
    consolePath: null,
  });
}

function evidenceTier1(input: {
  evidenceDir: string;
  screenshot: Uint8Array | null;
  calls: { value: number };
  paths: string[];
}): Tier1Runner {
  return async (t1Input: Tier1Input): Promise<Tier1Result> => {
    input.calls.value += 1;
    const screenshot = input.screenshot;
    const runDir = join(input.evidenceDir, "stub", t1Input.revisionSha, crypto.randomUUID());
    mkdirSync(runDir, { recursive: true });
    const screenshotPath = screenshot === null ? null : join(runDir, "screenshot.png");
    if (screenshotPath !== null) {
      if (screenshot === null) throw new Error("missing screenshot bytes");
      writeFileSync(screenshotPath, screenshot);
      input.paths.push(screenshotPath);
    }
    return {
      tier: 1,
      status: "ok",
      artifactId: t1Input.artifactType,
      revisionSha: t1Input.revisionSha,
      expected: t1Input.lexical,
      observed: OBSERVED,
      screenshotPath,
      consolePath: null,
    };
  };
}

function tier0(status: Tier0Result["status"]): Tier0Runner {
  return async (input: Tier0Input): Promise<Tier0Result> => ({
    tier: 0,
    status,
    artifactId: "",
    revisionSha: input.revisionSha,
    expected: input.lexical,
    observed: OBSERVED,
  });
}

describe("source export", () => {
  test("exports the original bytes, selects revisions, and proves hash identity", async () => {
    const env = await startEnv();
    try {
      const artifactId = await createArtifact(env, "source-bytes");
      const first = await publish(env, artifactId, SOURCE_ONE);
      const second = await publish(env, artifactId, SOURCE_TWO);

      const latest = await result(env, { command: "export", artifactId });
      const explicit = await result(env, {
        command: "export",
        artifactId,
        revisionSha: first.revisionSha,
        format: "source",
      });
      for (const [exported, source, sha] of [
        [latest, SOURCE_TWO, second.revisionSha],
        [explicit, SOURCE_ONE, first.revisionSha],
      ] as const) {
        const bytes = Buffer.from(exported.bytes as string, "base64");
        expect(new Uint8Array(bytes)).toEqual(source);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
        expect(exported.sidecar.revisionSha).toBe(sha);
      }
      expect(latest.sidecar.format).toBe("source");
    } finally {
      await env.service.stop();
    }
  });

  test("reports typed errors for unknown artifacts and revisions", async () => {
    const env = await startEnv();
    try {
      const missingArtifact = await request(env, { command: "export", artifactId: "missing" });
      expect(missingArtifact.status).toBe(404);
      expect((await missingArtifact.json()).error.code).toBe("artifact_not_found");

      const artifactId = await createArtifact(env, "no-revision");
      const noRevision = await request(env, { command: "export", artifactId });
      expect(noRevision.status).toBe(404);
      expect((await noRevision.json()).error.code).toBe("revision_not_found");

      const published = await publish(env, artifactId, SOURCE_ONE);
      const unknownSha = await request(env, {
        command: "export",
        artifactId,
        revisionSha: "b".repeat(64),
      });
      expect(unknownSha.status).toBe(404);
      expect((await unknownSha.json()).error.code).toBe("revision_not_found");
      expect(published.revisionSha).not.toBe("b".repeat(64));
    } finally {
      await env.service.stop();
    }
  });

  test("preserves stored insecure markers across tier 1 and secure restart", async () => {
    const envDir = join(scratchRoot, "restart");
    const insecure = await startEnv({ envDir, insecureLevel: 1, tier1Runner: tier1("ok") });
    let artifactId: string;
    let revisionSha: string;
    try {
      artifactId = await createArtifact(insecure, "insecure-source");
      revisionSha = (await publish(insecure, artifactId, SOURCE_ONE)).revisionSha;
      const exported = await result(insecure, { command: "export", artifactId, revisionSha });
      expect(exported.sidecar.verdict.insecure).toEqual({
        level: 1,
        reason: "manual insecure level 1",
      });
    } finally {
      await insecure.service.stop();
    }

    const secure = await startEnv({ envDir, insecureLevel: 0, tier1Runner: tier1("ok") });
    try {
      const exported = await result(secure, {
        command: "export",
        artifactId: artifactId!,
        revisionSha: revisionSha!,
      });
      expect(exported.sidecar.verdict.insecure).toEqual({
        level: 1,
        reason: "manual insecure level 1",
      });
    } finally {
      await secure.service.stop();
    }
  });

  test("L1 and L2 exports preserve the stored insecure marker", async () => {
    for (const level of [1, 2] as const) {
      const env = await startEnv({ insecureLevel: level });
      try {
        const artifactId = await createArtifact(env, `level-${level}`);
        const revisionSha = (await publish(env, artifactId, SOURCE_ONE)).revisionSha;
        const exported = await result(env, { command: "export", artifactId, revisionSha });
        expect(exported.sidecar.verdict.insecure).toEqual({
          level,
          reason: `manual insecure level ${level}`,
        });
      } finally {
        await env.service.stop();
      }
    }
  });

  test("exports insecure:unvalidated, error, and tampered stored verdicts", async () => {
    const levelThree = await startEnv({ insecureLevel: 3 });
    try {
      const artifactId = await createArtifact(levelThree, "unvalidated");
      const revisionSha = (await publish(levelThree, artifactId, SOURCE_ONE)).revisionSha;
      const exported = await result(levelThree, { command: "export", artifactId, revisionSha });
      expect(exported.sidecar.verdict.status).toBe("insecure:unvalidated");
      expect(exported.sidecar.verdict.insecure).toEqual({
        level: 3,
        reason: "manual insecure level 3",
      });
    } finally {
      await levelThree.service.stop();
    }

    for (const status of ["error", "tampered"] as const) {
      const env = await startEnv({ insecureLevel: 1, tier0Runner: tier0(status) });
      try {
        const artifactId = await createArtifact(env, status);
        const revisionSha = (await publish(env, artifactId, SOURCE_ONE)).revisionSha;
        const exported = await result(env, { command: "export", artifactId, revisionSha });
        expect(exported.sidecar.verdict.status).toBe(status);
        expect(exported.sidecar.verdict.insecure).toEqual({
          level: 1,
          reason: "manual insecure level 1",
        });
      } finally {
        await env.service.stop();
      }
    }
  });
});

describe("render export", () => {
  test("render export returns the stored screenshot bytes without rerendering", async () => {
    const envDir = join(scratchRoot, "render-success");
    const screenshot = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]);
    const calls = { value: 0 };
    const paths: string[] = [];
    const env = await startEnv({
      envDir,
      tier1Runner: evidenceTier1({
        evidenceDir: join(envDir, "evidence"),
        screenshot,
        calls,
        paths,
      }),
    });
    try {
      const artifactId = await createArtifact(env, "render-success");
      const published = await publish(env, artifactId, SOURCE_ONE);
      expect(calls.value).toBe(1);
      const source = await result(env, {
        command: "export",
        artifactId,
        revisionSha: published.revisionSha,
        format: "source",
      });
      const rendered = await result(env, {
        command: "export",
        artifactId,
        revisionSha: published.revisionSha,
        format: "render",
      });
      expect(Buffer.from(rendered.bytes as string, "base64")).toEqual(Buffer.from(screenshot));
      expect(rendered.sidecar.format).toBe("render");
      expect(rendered.sidecar.verdict.tier).toBe(1);
      expect(rendered.sidecar.verdict.revisionSha).toBe(published.revisionSha);
      expect(rendered.sidecar.verdict.status).toBe("ok");
      expect(source.sidecar.format).toBe("source");

      const screenshotPath = paths[0];
      if (screenshotPath === undefined) throw new Error("missing stub screenshot path");
      rmSync(screenshotPath);
      const missing = await request(env, {
        command: "export",
        artifactId,
        revisionSha: published.revisionSha,
        format: "render",
      });
      expect(missing.status).toBe(404);
      expect((await missing.json()).error.code).toBe("evidence_unavailable");
      expect(calls.value).toBe(1);
    } finally {
      await env.service.stop();
    }
  });

  test("a Tier 1 run without screenshot evidence returns typed evidence_unavailable", async () => {
    const envDir = join(scratchRoot, "render-null");
    const env = await startEnv({
      envDir,
      tier1Runner: evidenceTier1({
        evidenceDir: join(envDir, "evidence"),
        screenshot: null,
        calls: { value: 0 },
        paths: [],
      }),
    });
    try {
      const artifactId = await createArtifact(env, "render-null");
      const revisionSha = (await publish(env, artifactId, SOURCE_ONE)).revisionSha;
      const response = await request(env, {
        command: "export",
        artifactId,
        revisionSha,
        format: "render",
      });
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("evidence_unavailable");
    } finally {
      await env.service.stop();
    }
  });

  test("no Tier 1 run, including L3 publish, returns typed evidence_unavailable", async () => {
    for (const options of [{}, { insecureLevel: 3 as const }]) {
      const env = await startEnv(options);
      try {
        const artifactId = await createArtifact(
          env,
          `render-no-tier1-${options.insecureLevel ?? 0}`,
        );
        const revisionSha = (await publish(env, artifactId, SOURCE_ONE)).revisionSha;
        const response = await request(env, {
          command: "export",
          artifactId,
          revisionSha,
          format: "render",
        });
        expect(response.status).toBe(404);
        expect((await response.json()).error.code).toBe("evidence_unavailable");
      } finally {
        await env.service.stop();
      }
    }
  });

  test("a retained Tier 1 row with a deleted screenshot still returns typed evidence_unavailable", async () => {
    const envDir = join(scratchRoot, "render-retained");
    const paths: string[] = [];
    const env = await startEnv({
      envDir,
      tier1Runner: evidenceTier1({
        evidenceDir: join(envDir, "evidence"),
        screenshot: new Uint8Array([1, 2, 3]),
        calls: { value: 0 },
        paths,
      }),
    });
    let active = env;
    try {
      const artifactId = await createArtifact(active, "render-retained");
      const revisionSha = (await publish(active, artifactId, SOURCE_ONE)).revisionSha;
      const screenshotPath = paths[0];
      if (screenshotPath === undefined) throw new Error("missing stub screenshot path");
      await active.service.stop();
      rmSync(screenshotPath);
      const db = openDatabase(active.dbPath);
      const revision = db
        .query("SELECT id FROM revisions WHERE artifact_id = ? AND sha256 = ?")
        .get(artifactId, revisionSha) as { id: string } | null;
      if (revision === null) throw new Error("missing seeded revision");
      db.query("UPDATE render_runs SET retained = 1 WHERE revision_id = ? AND tier = 1").run(
        revision.id,
      );
      db.close();
      active = await startEnv({ envDir });
      const response = await request(active, {
        command: "export",
        artifactId,
        revisionSha,
        format: "render",
      });
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("evidence_unavailable");
    } finally {
      await active.service.stop();
    }
  });

  test("an evicted Tier 1 screenshot returns typed evidence_unavailable", async () => {
    const envDir = join(scratchRoot, "render-evicted");
    const env = await startEnv({
      envDir,
      tier1Runner: evidenceTier1({
        evidenceDir: join(envDir, "evidence"),
        screenshot: new Uint8Array([4, 5, 6]),
        calls: { value: 0 },
        paths: [],
      }),
    });
    try {
      const artifactId = await createArtifact(env, "render-evicted");
      let evictedRevisionSha = "";
      for (let index = 0; index < 11; index += 1) {
        const revision = await publish(env, artifactId, new Uint8Array([index, 42]));
        if (index === 0) evictedRevisionSha = revision.revisionSha;
      }
      const response = await request(env, {
        command: "export",
        artifactId,
        revisionSha: evictedRevisionSha,
        format: "render",
      });
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("evidence_unavailable");
    } finally {
      await env.service.stop();
    }
  });
});
