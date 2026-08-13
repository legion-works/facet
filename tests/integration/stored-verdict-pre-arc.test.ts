/**
 * Tolerant read of pre-arc stored verdicts.
 *
 * Every prior release of Facet predates both `externalImageCount`
 * (added by this arc) and `opaqueRegionCount` (added by the prior
 * opaque-content arc). A strict `VerdictObservedSchema.parse` on a
 * stored row written by those releases would 400 the read-back /
 * export / gallery-source routes on every pre-arc artifact.
 *
 * This test constructs stored rows in the PRE-ARC SHAPE (missing
 * both counters) and asserts every read path survives. The shape
 * fixture is constructed manually because no fixture in today's
 * shape can drive this code path — the migration backfills on disk
 * to today's shape, so a current-shape row hides the regression.
 *
 * The companion backfill migration (`src/service/store/schema.ts`
 * V7_SCHEMA_FRAGMENT) is exercised by the migration test below:
 * it builds a row in pre-arc shape, runs the migration, and asserts
 * the on-disk JSON now carries the missing counters.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

import { startFacetService, type RunningService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "../helpers/stub-tier0-runner";
import { runMigrations } from "../../src/service/store/migrations";
import { V7_SCHEMA_FRAGMENT } from "../../src/service/store/schema";
import { CommandResultSchema, type CommandResult } from "../../src/shared/contracts/commands";
import { FACET_SCHEMA_VERSION, FacetEnvelopeSchema } from "../../src/shared/contracts/envelope";

const scratchRoot = mkdtempSync(join(tmpdir(), "facet-prearc-stored-"));

afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

interface PreArcEnv {
  service: RunningService;
  dbPath: string;
}

/**
 * Build a database in the pre-arc shape: every schema migration is
 * applied, BUT one render_run row carries an observed_json string
 * that omits `opaqueRegionCount` and `externalImageCount` — the
 * exact shape the v1.4.0 release would never produce because this
 * arc adds those fields.
 */
async function startPreArcEnv(): Promise<PreArcEnv> {
  const envDir = join(scratchRoot, crypto.randomUUID());
  const dbPath = join(envDir, "facet.sqlite");
  const installTokenPath = join(envDir, "install.token");
  const promoteTokenPath = join(envDir, "promote.token");
  const lockPath = join(envDir, "facet.lock");
  mkdirSync(envDir, { recursive: true });

  // Apply every schema migration EXCEPT v7 (the backfill). The
  // shape we want to test is "row written by a release that did
  // not know about the v7 backfill". Mark v7 as already applied
  // BEFORE the migration loop reads the ledger so its apply() is
  // skipped.
  const db = new Database(dbPath);
  db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  ).run();
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
    7,
    new Date().toISOString(),
  );
  runMigrations(db);

  // Plant a single artifact / revision / render_run row in the
  // pre-arc shape. The observed_json intentionally omits both
  // counters the v7 migration adds; the schema is current (v6),
  // but the row's JSON payload is pre-arc.
  const artifactId = "00000000-0000-0000-0000-000000000001";
  const revisionId = "00000000-0000-0000-0000-000000000002";
  const projectId = "00000000-0000-0000-0000-000000000003";
  const sha256 = "a".repeat(64);
  db.exec(`INSERT INTO projects(id, project_root, created_at) VALUES (?, ?, ?)`, [
    projectId,
    "/facet",
    "2026-08-10T00:00:00.000Z",
  ]);
  db.exec(
    `INSERT INTO artifacts(id, project_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      artifactId,
      projectId,
      "pre-arc-shape",
      "Pre-arc shape",
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    ],
  );
  db.exec(
    `INSERT INTO revisions(id, artifact_id, revision_number, parent_revision_id, artifact_type, source, sha256, note, pinned, created_at, renderer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      revisionId,
      artifactId,
      1,
      null,
      "markdown",
      new Uint8Array([1, 2, 3]),
      sha256,
      null,
      0,
      "2026-08-10T00:00:00.000Z",
      "svg",
    ],
  );
  // Pre-arc shape: missing both `opaqueRegionCount` and
  // `externalImageCount` (this arc's two new counters).
  db.exec(
    `INSERT INTO render_runs(id, revision_id, tier, status, expected_json, observed_json, screenshot_path, console_path, screenshot_error_json, insecure_json, retained, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "00000000-0000-0000-0000-000000000004",
      revisionId,
      0,
      "ok",
      JSON.stringify({
        rendererRootSvgCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
      }),
      JSON.stringify({
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 0,
      }),
      null,
      null,
      null,
      null,
      0,
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    ],
  );
  db.close();

  const service = await startFacetService({
    dbPath,
    installTokenPath,
    promoteTokenPath,
    lockPath,
    idleTimeoutMs: 5_000,
    logger: createQuietLogger({ component: "prearc-stored-test" }),
    tier0Runner: stubTier0Runner,
  });
  return { service, dbPath };
}

function mkdirSync(path: string, options: { recursive?: boolean }): void {
  const { mkdirSync: ms } = require("node:fs");
  ms(path, options);
}

async function request(
  service: RunningService,
  command: Record<string, unknown>,
): Promise<CommandResult> {
  const requestId = `req-${crypto.randomUUID()}`;
  const response = await fetch(`${service.url}/api/v1/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.installToken}`,
      "content-type": "application/json",
      host: new URL(service.url).host,
    },
    body: JSON.stringify({
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId,
      ok: true,
      data: { requestId, ...command },
    }),
  });
  const body = (await response.json()) as {
    ok: boolean;
    data?: CommandResult;
    error?: unknown;
  };
  if (!body.ok || body.data === undefined) {
    throw new Error(`request failed: ${JSON.stringify(body.error ?? body)}`);
  }
  return CommandResultSchema.parse(body.data);
}

describe("pre-arc stored verdicts survive read-back / export / gallery-source", () => {
  test("read-back succeeds and reports the missing counters as zero", async () => {
    const { service } = await startPreArcEnv();
    try {
      const result = await request(service, {
        command: "readBack",
        artifactId: "00000000-0000-0000-0000-000000000001",
        revisionSha: "a".repeat(64),
        tier: 0,
      });
      if (result.command !== "readBack") throw new Error("expected readBack");
      expect(result.verdict.status).toBe("ok");
      expect(result.verdict.observed.opaqueRegionCount).toBe(0);
      expect(result.verdict.observed.externalImageCount).toBe(0);
    } finally {
      await service.stop();
    }
  });

  test("read-back of a non-tsx pre-arc row does NOT emit an execution field", async () => {
    // Optional verdict fields must not alter legacy read-back shapes. A
    // markdown row without execution metadata reads back without the field;
    // the wire must not contain "execution" anywhere in the response body.
    const { service } = await startPreArcEnv();
    try {
      const res = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${service.installToken}`,
          "content-type": "application/json",
          host: new URL(service.url).host,
        },
        body: JSON.stringify({
          schemaVersion: FACET_SCHEMA_VERSION,
          requestId: `req-${crypto.randomUUID()}`,
          ok: true,
          data: {
            requestId: `req-${crypto.randomUUID()}`,
            command: "readBack",
            artifactId: "00000000-0000-0000-0000-000000000001",
            revisionSha: "a".repeat(64),
            tier: 0,
          },
        }),
      });
      const wire = await res.text();
      const envelope = FacetEnvelopeSchema.parse(JSON.parse(wire));
      if (!envelope.ok) throw new Error(`read-back failed: ${JSON.stringify(envelope)}`);
      const verdict = (envelope.data as { verdict: Record<string, unknown> }).verdict;
      expect(verdict).not.toHaveProperty("execution");
      expect(wire).not.toContain('"execution"');
    } finally {
      await service.stop();
    }
  });

  test("export of the stored source succeeds", async () => {
    const { service } = await startPreArcEnv();
    try {
      const result = await request(service, {
        command: "export",
        artifactId: "00000000-0000-0000-0000-000000000001",
        revisionSha: "a".repeat(64),
        format: "source",
      });
      if (result.command !== "export") throw new Error("expected export");
      expect(result.sidecar.revisionSha).toBe("a".repeat(64));
      expect(result.bytes.length).toBeGreaterThan(0);
    } finally {
      await service.stop();
    }
  });

  test("export of a non-tsx pre-arc row does NOT emit an execution field", async () => {
    // Same wire-form contract on the export sidecar: non-TSX
    // verdicts must NOT carry the execution marker, so the
    // pre-arc shape stays byte-identical. The export sidecar
    // includes the verdict on the wire; assert the field is
    // absent there too, not just on read-back.
    const { service } = await startPreArcEnv();
    try {
      const res = await fetch(`${service.url}/api/v1/commands`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${service.installToken}`,
          "content-type": "application/json",
          host: new URL(service.url).host,
        },
        body: JSON.stringify({
          schemaVersion: FACET_SCHEMA_VERSION,
          requestId: `req-${crypto.randomUUID()}`,
          ok: true,
          data: {
            requestId: `req-${crypto.randomUUID()}`,
            command: "export",
            artifactId: "00000000-0000-0000-0000-000000000001",
            revisionSha: "a".repeat(64),
            format: "source",
          },
        }),
      });
      const wire = await res.text();
      const envelope = FacetEnvelopeSchema.parse(JSON.parse(wire));
      if (!envelope.ok) throw new Error(`export failed: ${JSON.stringify(envelope)}`);
      const sidecar = (envelope.data as { sidecar: { verdict: Record<string, unknown> } }).sidecar;
      expect(sidecar.verdict).not.toHaveProperty("execution");
      expect(wire).not.toContain('"execution"');
    } finally {
      await service.stop();
    }
  });

  test("v7 migration backfills the missing counters in observed_json", () => {
    const envDir = join(scratchRoot, crypto.randomUUID());
    mkdirSync(envDir, { recursive: true });
    const dbPath = join(envDir, "facet.sqlite");
    const db = new Database(dbPath);
    try {
      // Plant a render_run row in pre-arc shape. Run every
      // migration EXCEPT v7 (the backfill) so the schema is current
      // at v6 but the JSON payload is pre-arc. v7 is pre-marked as
      // already applied so the migration ledger skips its apply().
      // Create the migrations ledger BEFORE runMigrations so the
      // v7 marker is in place when the migration loop reads it.
      db.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      ).run();
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        7,
        new Date().toISOString(),
      );
      runMigrations(db);
      const projectId = "00000000-0000-0000-0000-000000000010";
      const artifactId = "00000000-0000-0000-0000-000000000011";
      const revisionId = "00000000-0000-0000-0000-000000000012";
      db.exec(`INSERT INTO projects(id, project_root, created_at) VALUES (?, ?, ?)`, [
        projectId,
        "/facet",
        "2026-08-10T00:00:00.000Z",
      ]);
      db.exec(
        `INSERT INTO artifacts(id, project_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          artifactId,
          projectId,
          "pre-arc-backfill",
          "Backfill",
          "2026-08-10T00:00:00.000Z",
          "2026-08-10T00:00:00.000Z",
        ],
      );
      db.exec(
        `INSERT INTO revisions(id, artifact_id, revision_number, parent_revision_id, artifact_type, source, sha256, note, pinned, created_at, renderer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          revisionId,
          artifactId,
          1,
          null,
          "markdown",
          new Uint8Array([1, 2, 3]),
          "b".repeat(64),
          null,
          0,
          "2026-08-10T00:00:00.000Z",
          "svg",
        ],
      );
      db.exec(
        `INSERT INTO render_runs(id, revision_id, tier, status, expected_json, observed_json, screenshot_path, console_path, screenshot_error_json, insecure_json, retained, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "00000000-0000-0000-0000-000000000013",
          revisionId,
          0,
          "ok",
          JSON.stringify({ rendererRootSvgCount: 0, mermaidNodeCount: 0, visibleSvgCount: 0 }),
          JSON.stringify({
            rendererRootSvgCount: 0,
            graphCount: 0,
            mermaidNodeCount: 0,
            visibleSvgCount: 0,
            errorCount: 0,
          }),
          null,
          null,
          null,
          null,
          0,
          "2026-08-10T00:00:00.000Z",
          "2026-08-10T00:00:00.000Z",
        ],
      );

      const before = db.query("SELECT observed_json FROM render_runs LIMIT 1").get() as {
        observed_json: string;
      };
      expect(before.observed_json).not.toContain("opaqueRegionCount");
      expect(before.observed_json).not.toContain("externalImageCount");

      db.exec(V7_SCHEMA_FRAGMENT);

      const after = db.query("SELECT observed_json FROM render_runs LIMIT 1").get() as {
        observed_json: string;
      };
      expect(after.observed_json).toContain('"opaqueRegionCount":0');
      expect(after.observed_json).toContain('"externalImageCount":0');
    } finally {
      db.close();
    }
  });
});
