/**
 * Integration tests for revision-bound read-back evidence + retention.
 *
 * Pins the contracts the dispatcher + repository MUST honor:
 *
 *   1. Revision binding — read-back returns the run bound to the EXACT
 *      (artifactId, revisionSha) the caller supplied. Two revisions
 *      published in quick succession MUST NOT cross-pollinate their
 *      verdicts; a stale sha MUST surface as `revision_not_found`.
 *   2. Screenshot mandate — partial results carry a screenshot path or a
 *      typed screenshot-unavailable marker; a result missing both is rejected
 *      at the parse boundary so it can never land in the DB or the wire.
 *   3. Evidence directory is mode 0700 on disk (the canonical Capper
 *      secret-bearing layout — same posture as the DB files).
 *   4. Last-N retention — `recordRenderRun` evicts the oldest runs
 *      beyond `EVIDENCE_LAST_N_PER_ARTIFACT` AND their on-disk files,
 *      in the same write path; `retained` rows are exempt.
 *   5. Cleanup-after-failure — when `recordRenderRun` itself fails,
 *      any evidence files written by the caller MUST be unlinked so
 *      no orphans accumulate.
 *   6. No content leak — the screenshot / page console summary bytes
 *      MUST NOT appear in log lines or wire responses; only
 *      capability-scoped paths and bounded summaries cross the
 *      boundary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FACET_SCHEMA_VERSION, FacetEnvelopeSchema } from "../../src/shared/contracts/envelope";
import { CommandResultSchema, type CommandResult } from "../../src/shared/contracts/commands";
import {
  Tier1ResultSchema,
  type Tier1Input,
  type Tier1Result,
  type Tier1Runner,
} from "../../src/shared/contracts/validation";
import { startFacetService, type RunningService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { openDatabase } from "../../src/service/store/database";
import { runMigrations } from "../../src/service/store/migrations";
import { ArtifactRepository } from "../../src/service/store/repository";
import { FacetClient, readBack } from "../../src/cli/client";

interface TestEnv {
  service: RunningService;
  baseUrl: string;
  installToken: string;
  evidenceDir: string;
  cleanup: () => Promise<void>;
}

const scratchRoot = join(tmpdir(), `facet-read-back-${crypto.randomUUID()}`);

beforeEach(() => {
  mkdirSync(scratchRoot, { recursive: true });
});

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

async function startEnv(opts: { tier1Runner?: Tier1Runner } = {}): Promise<TestEnv> {
  const envDir = join(scratchRoot, crypto.randomUUID());
  mkdirSync(envDir, { recursive: true });
  const evidenceDir = join(envDir, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  // The service resolves its own evidence root from env; we use a
  // dedicated FACET_HOME so paths inside it match the test's evidenceDir.
  const previousFacetHome = process.env.FACET_HOME;
  process.env.FACET_HOME = envDir;
  try {
    const service = await startFacetService({
      dbPath: join(envDir, "facet.sqlite"),
      installTokenPath: join(envDir, "install.token"),
      promoteTokenPath: join(envDir, "promote.token"),
      lockPath: join(envDir, "facet.lock"),
      idleTimeoutMs: 5_000,
      logger: createQuietLogger({ component: "read-back-test" }),
      tier0Runner: stubTier0Runner,
      ...(opts.tier1Runner !== undefined ? { tier1Runner: opts.tier1Runner } : {}),
    });
    return {
      service,
      baseUrl: service.url,
      installToken: service.installToken,
      evidenceDir: join(envDir, "evidence"),
      cleanup: async () => {
        await service.stop();
      },
    };
  } finally {
    if (previousFacetHome === undefined) {
      delete process.env.FACET_HOME;
    } else {
      process.env.FACET_HOME = previousFacetHome;
    }
  }
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
    ok: true as const,
    data: { requestId: innerRequestId, ...(body as Record<string, unknown>) },
  };
  return fetch(`${env.baseUrl}/api/v1/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify(wrapped),
  });
}

async function envelopeOk(env: TestEnv, body: unknown): Promise<CommandResult> {
  const res = await envelopeRequest(env, body);
  const text = await res.text();
  const envelope = FacetEnvelopeSchema.parse(JSON.parse(text));
  if (!envelope.ok) {
    throw new Error(`envelope error: ${JSON.stringify(envelope)}`);
  }
  return CommandResultSchema.parse(envelope.data);
}

async function createArtifact(env: TestEnv, slug: string): Promise<string> {
  const result = await envelopeOk(env, {
    command: "create",
    projectId: "p",
    slug,
    title: slug,
  });
  if (result.command !== "create") throw new Error("expected create");
  return result.artifact.id;
}

async function publishMarkdown(
  env: TestEnv,
  artifactId: string,
  body: string,
): Promise<{ revisionSha: string; revisionId: string; revisionNumber: number }> {
  const result = await envelopeOk(env, {
    command: "publish",
    artifactId,
    artifactType: "markdown",
    bytes: Buffer.from(body, "utf8").toString("base64"),
  });
  if (result.command !== "publish") throw new Error("expected publish");
  return {
    revisionSha: result.revision.sha256,
    revisionId: result.revision.id,
    revisionNumber: result.revision.revisionNumber,
  };
}

const SENTINEL_CONSOLE = "facet-sentinel-evidence-9b1c";

/**
 * Tier 1 runner that returns a verdict whose artifactId/revisionSha
 * we can prove the dispatcher overwrote with the real ones — the
 * bound identity. Lifted to module scope so it does not capture
 * anything from a parent closure.
 */
const placeholderIdentityTier1Runner: Tier1Runner = async (
  t1Input: Tier1Input,
): Promise<Tier1Result> => {
  return {
    tier: 1,
    status: "ok",
    artifactId: "worker-placeholder",
    revisionSha: "0".repeat(64),
    expected: t1Input.lexical,
    observed: {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      errorCount: 0,
    },
    screenshotPath: null,
    consolePath: null,
  };
};

/**
 * Stub Tier 1 runner that records a screenshot at <evidenceDir>/<runId>/screenshot.png
 * and a bounded console summary at <evidenceDir>/<runId>/console.txt (carrying
 * the SENTINEL_CONSOLE marker). The status can be flipped per-test; the contract
 * is that partial verdicts require screenshot evidence or an explicit marker.
 */
function buildStubTier1(input: {
  evidenceDir: string;
  status: Tier1Result["status"];
  sentinelInScreenshot?: boolean;
  withScreenshot?: boolean;
}): Tier1Runner {
  return async (t1Input: Tier1Input): Promise<Tier1Result> => {
    const runId = crypto.randomUUID();
    const runDir = join(input.evidenceDir, t1Input.artifactType, t1Input.revisionSha, runId);
    mkdirSync(runDir, { recursive: true });
    const screenshotPath = input.withScreenshot === false ? null : join(runDir, "screenshot.png");
    if (screenshotPath !== null) {
      const payload = input.sentinelInScreenshot === true ? SENTINEL_CONSOLE : "png-bytes";
      writeFileSyncCompat(screenshotPath, payload);
    }
    const consolePath = join(runDir, "console.txt");
    writeFileSyncCompat(consolePath, `console:${SENTINEL_CONSOLE}`);
    try {
      chmodSync(runDir, 0o700);
    } catch {
      // best-effort
    }
    return {
      tier: 1,
      status: input.status,
      artifactId: t1Input.artifactType,
      revisionSha: t1Input.revisionSha,
      expected: t1Input.lexical,
      observed: {
        rendererRootSvgCount: t1Input.lexical.rendererRootSvgCount,
        graphCount: 0,
        mermaidNodeCount: t1Input.lexical.mermaidNodeCount,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        errorCount: 0,
      },
      screenshotPath,
      consolePath,
    };
  };
}

function writeFileSyncCompat(path: string, content: string): void {
  // Bun.write keeps the path in the parent's file system view (the
  // service resolves its own FACET_HOME); the same call is used by
  // both the test stub and the production runner so byte semantics
  // match.
  Bun.write(path, content);
}

describe("read-back revision binding", () => {
  test("CLI read-back preserves discriminative errors from the observed verdict", async () => {
    const revisionSha = "a".repeat(64);
    const client = new FacetClient({
      baseUrl: "http://127.0.0.1:1234",
      installToken: "test-token",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            schemaVersion: FACET_SCHEMA_VERSION,
            requestId: "response-request",
            ok: true,
            data: {
              command: "readBack",
              requestId: "response-request",
              renderer: "svg",
              verdict: {
                status: "error",
                tier: 0,
                artifactId: "artifact-1",
                revisionSha,
                observed: {
                  rendererRootSvgCount: 0,
                  graphCount: 0,
                  mermaidNodeCount: 0,
                  visibleSvgCount: 0,
                  opaqueRegionCount: 0,
                  errorCount: 1,
                  discriminativeErrors: [{ code: "bad_markdown", message: "bad markdown" }],
                },
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });

    const result = await readBack(client, {
      artifactId: "artifact-1",
      revisionSha,
      tier: 0,
    });
    expect(result.observed.discriminativeErrors).toEqual([
      { code: "bad_markdown", message: "bad markdown" },
    ]);
  });

  test("two rapid revisions to the same artifact — each read-back returns only its own verdict", async () => {
    const env = await startEnv();
    try {
      const artifactId = await createArtifact(env, "binding");
      const first = await publishMarkdown(env, artifactId, "first body");
      const second = await publishMarkdown(env, artifactId, "second body");

      expect(first.revisionSha).not.toBe(second.revisionSha);

      const firstReadback = await envelopeOk(env, {
        command: "readBack",
        artifactId,
        revisionSha: first.revisionSha,
        tier: 0,
      });
      if (firstReadback.command !== "readBack") throw new Error("expected readBack");
      expect(firstReadback.verdict.revisionSha).toBe(first.revisionSha);
      expect(firstReadback.verdict.artifactId).toBe(artifactId);

      const secondReadback = await envelopeOk(env, {
        command: "readBack",
        artifactId,
        revisionSha: second.revisionSha,
        tier: 0,
      });
      if (secondReadback.command !== "readBack") throw new Error("expected readBack");
      expect(secondReadback.verdict.revisionSha).toBe(second.revisionSha);
      expect(secondReadback.verdict.artifactId).toBe(artifactId);
    } finally {
      await env.cleanup();
    }
  });

  test("a stale revision sha returns revision_not_found — never another revision's verdict", async () => {
    const env = await startEnv();
    try {
      const artifactId = await createArtifact(env, "stale");
      const first = await publishMarkdown(env, artifactId, "v1");
      // Publish a second revision so the artifact has 2; then query a sha
      // that belongs to NEITHER. The verdict for revision `first` MUST
      // not leak.
      await publishMarkdown(env, artifactId, "v2");
      const staleSha = "0".repeat(64);
      const res = await envelopeRequest(env, {
        command: "readBack",
        artifactId,
        revisionSha: staleSha,
        tier: 0,
      });
      const envelope = FacetEnvelopeSchema.parse(JSON.parse(await res.text()));
      if (envelope.ok) throw new Error("expected error envelope");
      expect(envelope.error.code).toBe("revision_not_found");
      // The wire envelope MUST NOT carry a verdict-shaped object — the
      // dispatcher must reject before binding to first's render_run.
      expect("verdict" in envelope.error).toBe(false);
      expect("revisionSha" in envelope.error).toBe(false);
      // Sanity: first's read-back still works.
      const firstReadback = await envelopeOk(env, {
        command: "readBack",
        artifactId,
        revisionSha: first.revisionSha,
        tier: 0,
      });
      if (firstReadback.command !== "readBack") throw new Error("expected readBack");
      expect(firstReadback.verdict.revisionSha).toBe(first.revisionSha);
    } finally {
      await env.cleanup();
    }
  });

  test("read-back binding for tier 1 — verdict is bound to the (artifactId, revisionSha) the parent committed", async () => {
    const env = await startEnv({ tier1Runner: placeholderIdentityTier1Runner });
    try {
      const artifactId = await createArtifact(env, "tier1-binding");
      const first = await publishMarkdown(env, artifactId, "alpha");
      const second = await publishMarkdown(env, artifactId, "beta");

      const firstT1 = await envelopeOk(env, {
        command: "readBack",
        artifactId,
        revisionSha: first.revisionSha,
        tier: 1,
      });
      if (firstT1.command !== "readBack") throw new Error("expected readBack");
      expect(firstT1.verdict.tier).toBe(1);
      expect(firstT1.verdict.artifactId).toBe(artifactId);
      expect(firstT1.verdict.revisionSha).toBe(first.revisionSha);

      const secondT1 = await envelopeOk(env, {
        command: "readBack",
        artifactId,
        revisionSha: second.revisionSha,
        tier: 1,
      });
      if (secondT1.command !== "readBack") throw new Error("expected readBack");
      expect(secondT1.verdict.tier).toBe(1);
      expect(secondT1.verdict.artifactId).toBe(artifactId);
      expect(secondT1.verdict.revisionSha).toBe(second.revisionSha);
    } finally {
      await env.cleanup();
    }
  });

  test("read-back exposes the revision renderer", async () => {
    const env = await startEnv();
    try {
      const artifactId = await createArtifact(env, "canvas-readback");
      const published = await envelopeOk(env, {
        command: "publish",
        artifactId,
        artifactType: "chart",
        renderer: "canvas",
        bytes: Buffer.from("{}", "utf8").toString("base64"),
      });
      if (published.command !== "publish") throw new Error("expected publish");
      const readback = await envelopeOk(env, {
        command: "readBack",
        artifactId,
        revisionSha: published.revision.sha256,
        tier: 0,
      });
      if (readback.command !== "readBack") throw new Error("expected readBack");
      expect(readback.renderer).toBe("canvas");
    } finally {
      await env.cleanup();
    }
  });
});

describe("screenshot mandate for partial verdicts", () => {
  for (const status of ["partial:layout_unverified", "partial:opaque_content"] as const) {
    test(`${status} WITHOUT screenshot path or marker is rejected at parse — publish fails`, async () => {
      const tier1Runner = buildStubTier1({
        evidenceDir: scratchRoot,
        status,
        withScreenshot: false,
      });
      const env = await startEnv({ tier1Runner });
      try {
        const artifactId = await createArtifact(env, "partial-no-shot");
        const res = await envelopeRequest(env, {
          command: "publish",
          artifactId,
          artifactType: "markdown",
          bytes: Buffer.from("hi", "utf8").toString("base64"),
        });
        const envelope = FacetEnvelopeSchema.parse(JSON.parse(await res.text()));
        if (envelope.ok) throw new Error("expected error envelope");
        // The Tier1Result refine throws ZodError which FacetError.from
        // maps to invalid_envelope on the wire.
        expect(envelope.error.code).toBe("invalid_envelope");
      } finally {
        await env.cleanup();
      }
    });

    test(`${status} WITH screenshot path is accepted; verdict reachable via read-back tier 1`, async () => {
      const tier1Runner = buildStubTier1({
        evidenceDir: scratchRoot,
        status,
        withScreenshot: true,
      });
      const env = await startEnv({ tier1Runner });
      try {
        const artifactId = await createArtifact(env, "partial-with-shot");
        const publishResult = await envelopeOk(env, {
          command: "publish",
          artifactId,
          artifactType: "markdown",
          bytes: Buffer.from("hi", "utf8").toString("base64"),
        });
        if (publishResult.command !== "publish") throw new Error("expected publish");
        expect(publishResult.tier1Verdict).not.toBeNull();
        if (publishResult.tier1Verdict === null || publishResult.tier1Verdict === undefined) return;
        expect(publishResult.tier1Verdict.status).toBe(status);
        expect(publishResult.tier1Verdict.screenshotPath).not.toBeNull();

        const readback = await envelopeOk(env, {
          command: "readBack",
          artifactId,
          revisionSha: publishResult.revision.sha256,
          tier: 1,
        });
        if (readback.command !== "readBack") throw new Error("expected readBack");
        expect(readback.verdict.status).toBe(status);
      } finally {
        await env.cleanup();
      }
    });
  }

  test("Tier1ResultSchema refine rejects partial-without-screenshot directly (parse-level guard)", () => {
    const lexical = {
      rendererRootSvgCount: 1,
      mermaidNodeCount: 1,
      visibleSvgCount: 1,
      opaqueRegionCount: 0,
    };
    const base = {
      tier: 1 as const,
      status: "partial:layout_unverified" as const,
      artifactId: "a",
      revisionSha: "0".repeat(64),
      expected: lexical,
      observed: {
        rendererRootSvgCount: 1,
        graphCount: 0,
        mermaidNodeCount: 1,
        visibleSvgCount: 0,
        opaqueRegionCount: 0,
        errorCount: 0,
      },
    };
    expect(() =>
      Tier1ResultSchema.parse({ ...base, screenshotPath: null, consolePath: null }),
    ).toThrow();
    expect(() =>
      Tier1ResultSchema.parse({
        ...base,
        screenshotPath: "/tmp/somewhere/screenshot.png",
        consolePath: null,
      }),
    ).not.toThrow();
  });
});

describe("evidence directory mode + retention", () => {
  test("the evidence directory is mode 0700", async () => {
    const env = await startEnv();
    try {
      // The service resolves the evidence root from FACET_HOME; the
      // helper computed the same path. The directory MUST be 0700
      // (or stronger — secret-bearing layout, matches the DB files).
      expect(existsSync(env.evidenceDir)).toBe(true);
      const mode = statSync(env.evidenceDir).mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      await env.cleanup();
    }
  });

  test("per-run evidence directory lands at exactly 0700 under a hostile umask", () => {
    // Regression: the runner creates the per-run evidence directory
    // with mkdirSync(mode: 0o700). A hostile umask that strips the
    // owner execute bit (e.g. 0o177) leaves the directory at 0o600 —
    // a worse failure than the 0o755 leak (no traversal by anyone,
    // not even the owner). The canonical helper must chmod the
    // directory back to 0o700 so the post-mkdir stat reads 0o700
    // regardless of the process umask.
    const { ensureOwnerOnlyDirectory } =
      require("../../src/shared/util/dir-permissions") as typeof import("../../src/shared/util/dir-permissions");
    const scratchDir = join(scratchRoot, `umask-hostile-${crypto.randomUUID()}`);
    const previousUmask = process.umask(0o177);
    try {
      const created = ensureOwnerOnlyDirectory(scratchDir);
      expect(created).toBe(scratchDir);
      expect(existsSync(scratchDir)).toBe(true);
      expect(statSync(scratchDir).mode & 0o777).toBe(0o700);
    } finally {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      process.umask(previousUmask);
    }
  });

  test("last-N retention: publishing beyond N evicts oldest runs AND their evidence files", async () => {
    // Stub runner writes a screenshot per run with a known sentinel
    // marker; cleanup-after-N must unlink those files.
    const tier1Runner: Tier1Runner = async (t1Input: Tier1Input): Promise<Tier1Result> => {
      const runId = crypto.randomUUID();
      const runDir = join(
        scratchRoot,
        "evidence",
        t1Input.artifactType,
        t1Input.revisionSha,
        runId,
      );
      mkdirSync(runDir, { recursive: true });
      const screenshotPath = join(runDir, "screenshot.png");
      const consolePath = join(runDir, "console.txt");
      Bun.write(screenshotPath, SENTINEL_CONSOLE);
      Bun.write(consolePath, SENTINEL_CONSOLE);
      try {
        chmodSync(runDir, 0o700);
      } catch {
        // best-effort
      }
      return {
        tier: 1,
        status: "ok",
        artifactId: t1Input.artifactType,
        revisionSha: t1Input.revisionSha,
        expected: t1Input.lexical,
        observed: {
          rendererRootSvgCount: 0,
          graphCount: 0,
          mermaidNodeCount: 0,
          visibleSvgCount: 0,
          opaqueRegionCount: 0,
          errorCount: 0,
        },
        screenshotPath,
        consolePath,
      };
    };
    const env = await startEnv({ tier1Runner });
    try {
      const artifactId = await createArtifact(env, "retention");
      // Publish N+5 revisions to one artifact; the last N wins, the
      // first 5 are evicted (file + row).
      const totalRuns = 12; // > N=10 from default
      const revisions: string[] = [];
      for (let i = 0; i < totalRuns; i += 1) {
        const result = await envelopeOk(env, {
          command: "publish",
          artifactId,
          artifactType: "markdown",
          bytes: Buffer.from(`body-${i}`, "utf8").toString("base64"),
        });
        if (result.command !== "publish") throw new Error("expected publish");
        revisions.push(result.revision.sha256);
      }
      // Find the run directory for the FIRST revision (must be gone).
      // The stub wrote under <scratchRoot>/evidence/<type>/<sha>/<runId>.
      const firstSha = revisions[0]!;
      const firstDir = join(scratchRoot, "evidence", "markdown", firstSha);
      // Some run-id directories may linger if a later publish reused
      // the same sha (impossible — sha is content-addressed) or if
      // eviction is per-artifact (last-N). The first sha's tree MUST
      // be empty because the run row was evicted and so were its
      // evidence files.
      const entries = (() => {
        try {
          return Array.from(new Bun.Glob("*").scanSync({ cwd: firstDir }));
        } catch {
          return [];
        }
      })();
      expect(entries.length).toBe(0);

      // The latest revision's evidence MUST still be on disk.
      const lastSha = revisions[revisions.length - 1]!;
      const lastDir = join(scratchRoot, "evidence", "markdown", lastSha);
      expect(existsSync(lastDir)).toBe(true);
    } finally {
      await env.cleanup();
    }
  }, 30_000);
});

describe("evidence content does not leak across the wire", () => {
  test("screenshot bytes and console sentinel never appear in the read-back envelope", async () => {
    const tier1Runner = buildStubTier1({
      evidenceDir: scratchRoot,
      status: "ok",
      sentinelInScreenshot: true,
    });
    const env = await startEnv({ tier1Runner });
    try {
      const artifactId = await createArtifact(env, "leak");
      const pubResult = await envelopeOk(env, {
        command: "publish",
        artifactId,
        artifactType: "markdown",
        bytes: Buffer.from("hi", "utf8").toString("base64"),
      });
      if (pubResult.command !== "publish") throw new Error("expected publish");
      const rbRes = await envelopeRequest(env, {
        command: "readBack",
        artifactId,
        revisionSha: pubResult.revision.sha256,
        tier: 1,
      });
      const rbText = await rbRes.text();
      // Capability-scoped paths are OK; the sentinel CONTENT must not
      // be in the body (it was written to the screenshot file by the
      // stub, not stored in the DB).
      expect(rbText.includes(SENTINEL_CONSOLE)).toBe(false);
    } finally {
      await env.cleanup();
    }
  });
});

describe("cleanup-after-failure leaves no orphan evidence files", () => {
  const storePaths: string[] = [];

  function openRepo(label: string): {
    db: ReturnType<typeof openDatabase>;
    evidenceDir: string;
    repository: ArtifactRepository;
  } {
    const databasePath = join(scratchRoot, `${label}-${crypto.randomUUID()}.sqlite`);
    const evidenceDir = join(scratchRoot, `${label}-ev-${crypto.randomUUID()}`);
    storePaths.push(databasePath, evidenceDir);
    mkdirSync(evidenceDir, { recursive: true });
    const db = openDatabase({ databasePath });
    runMigrations(db);
    const repository = new ArtifactRepository(db, { evidenceRoot: evidenceDir });
    return { db, evidenceDir, repository };
  }

  test("a foreign-key failure during recordRenderRun unlinks the caller's evidence files", () => {
    const { db, evidenceDir, repository } = openRepo("orphan");
    try {
      const project = repository.createProject({ projectRoot: `/tmp/${crypto.randomUUID()}` });
      const artifact = repository.createArtifact({
        projectId: project.id,
        slug: "orphan",
        title: "Orphan",
      });
      const fakeRevisionId = "0".repeat(36);
      const screenshotPath = join(evidenceDir, "fake-screenshot.png");
      const consolePath = join(evidenceDir, "fake-console.txt");
      Bun.write(screenshotPath, "should-be-removed");
      Bun.write(consolePath, "should-be-removed");
      expect(existsSync(screenshotPath)).toBe(true);
      expect(existsSync(consolePath)).toBe(true);
      let thrown: unknown = null;
      try {
        repository.recordRenderRun({
          revisionId: fakeRevisionId,
          tier: 1,
          status: "ok",
          expected: {
            rendererRootSvgCount: 0,
            mermaidNodeCount: 0,
            visibleSvgCount: 0,
            opaqueRegionCount: 0,
          },
          observed: {
            rendererRootSvgCount: 0,
            graphCount: 0,
            mermaidNodeCount: 0,
            visibleSvgCount: 0,
            opaqueRegionCount: 0,
            errorCount: 0,
          },
          screenshotPath,
          consolePath,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).not.toBeNull();
      expect(existsSync(screenshotPath)).toBe(false);
      expect(existsSync(consolePath)).toBe(false);
      void artifact;
    } finally {
      db.close();
    }
  });
});

describe("retained rows are exempt from retention eviction", () => {
  const storePaths: string[] = [];

  function openRepo(label: string): {
    db: ReturnType<typeof openDatabase>;
    evidenceDir: string;
    repository: ArtifactRepository;
  } {
    const databasePath = join(scratchRoot, `${label}-${crypto.randomUUID()}.sqlite`);
    const evidenceDir = join(scratchRoot, `${label}-ev-${crypto.randomUUID()}`);
    storePaths.push(databasePath, evidenceDir);
    mkdirSync(evidenceDir, { recursive: true });
    const db = openDatabase({ databasePath });
    runMigrations(db);
    const repository = new ArtifactRepository(db, { evidenceRoot: evidenceDir });
    return { db, evidenceDir, repository };
  }

  test("a retained row survives past the last-N cutoff; non-retained rows beyond N are evicted", () => {
    const { db, evidenceDir, repository } = openRepo("retained");
    try {
      const project = repository.createProject({ projectRoot: `/tmp/${crypto.randomUUID()}` });
      const artifact = repository.createArtifact({
        projectId: project.id,
        slug: "retained",
        title: "Retained",
      });
      const totalRuns = 15;
      const evidenceFiles: string[] = [];
      // Strictly-monotonic finishedAt so ORDER BY DESC is deterministic
      // even when many inserts share the same wall-clock millisecond.
      const baseTime = Date.now() - totalRuns;
      for (let i = 0; i < totalRuns; i += 1) {
        const revision = repository.publishRevision({
          artifactId: artifact.id,
          artifactType: "markdown",
          source: new Uint8Array([i + 1]),
        });
        const evidenceFile = join(evidenceDir, `rev-${i}.png`);
        Bun.write(evidenceFile, `sentinel-${i}`);
        evidenceFiles.push(evidenceFile);
        const ts = new Date(baseTime + i).toISOString();
        repository.recordRenderRun({
          revisionId: revision.id,
          tier: 0,
          status: "ok",
          expected: {
            rendererRootSvgCount: 0,
            mermaidNodeCount: 0,
            visibleSvgCount: 0,
            opaqueRegionCount: 0,
          },
          observed: {
            rendererRootSvgCount: 0,
            graphCount: 0,
            mermaidNodeCount: 0,
            visibleSvgCount: 0,
            opaqueRegionCount: 0,
            errorCount: 0,
          },
          screenshotPath: evidenceFile,
          consolePath: null,
          retained: i === 0,
          startedAt: ts,
          finishedAt: ts,
        });
      }
      // With limit=10 and totalRuns=15:
      //   - index 0 is retained — exempt from eviction
      //   - indices 1..4 are non-retained AND beyond the cutoff — evicted
      //   - indices 5..14 are within the cutoff — preserved
      expect(existsSync(evidenceFiles[0]!)).toBe(true);
      for (let i = 1; i <= 4; i += 1) {
        expect(existsSync(evidenceFiles[i]!)).toBe(false);
      }
      for (let i = 5; i < totalRuns; i += 1) {
        expect(existsSync(evidenceFiles[i]!)).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});
