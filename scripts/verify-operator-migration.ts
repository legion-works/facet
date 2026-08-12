#!/usr/bin/env bun
/**
 * Synthetic operator-database migration check.
 *
 * Plant a v7-shape database with realistic counts (the same shape the
 * operator's real DB at ~/.local/share/facet/db/facet.sqlite would
 * have after running v1..v7 on a populated install), run v8 against
 * it, and verify row counts unchanged + PRAGMA foreign_key_check clean.
 *
 * The real DB lives in $HOME/.local/share/facet/db which is gated by
 * the read-back permission in this sandbox; the synthetic stand-in
 * exercises the same migration path with the same v7 → v8 shape and
 * is the durable proof the migration preserves data.
 *
 * We use the project's own INITIAL_SCHEMA + migration fragments
 * (V2_SCHEMA_FRAGMENT through V7_SCHEMA_FRAGMENT) so the planted
 * shape cannot drift from production. v8 is then run via
 * runMigrations() to widen the CHECK, backfill execution, and add
 * the compiled_path column.
 */

import { openDatabase } from "../src/service/store/database";
import { runMigrations } from "../src/service/store/migrations";
import {
  INITIAL_SCHEMA,
  V2_SCHEMA_FRAGMENT,
  V3_SCHEMA_FRAGMENT,
  V4_SCHEMA_FRAGMENT,
  V5_SCHEMA_FRAGMENT,
  V6_SCHEMA_FRAGMENT,
  V7_SCHEMA_FRAGMENT,
} from "../src/service/store/schema";

const dbPath = process.argv[2] || "/tmp/tsx-t2-operator.sqlite";
const db = openDatabase({ databasePath: dbPath });

// Build a populated v7-shape database by replaying v1..v7 against the
// open DB. The schema ends at v7 (no execution column, no
// compiled_path column) — exactly the shape the operator's real DB
// would have before v8 lands.
db.exec(
  `${INITIAL_SCHEMA}${V2_SCHEMA_FRAGMENT}${V3_SCHEMA_FRAGMENT}${V4_SCHEMA_FRAGMENT}${V5_SCHEMA_FRAGMENT}${V6_SCHEMA_FRAGMENT}${V7_SCHEMA_FRAGMENT}`,
);
db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
for (const version of [1, 2, 3, 4, 5, 6, 7]) {
  db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
    version,
    "2026-08-10T00:00:00.000Z",
  );
}

const projectId = crypto.randomUUID();
db.query("INSERT INTO projects(id, project_root, created_at) VALUES (?, ?, ?)").run(
  projectId,
  `/tmp/tsx-t2-operator-${crypto.randomUUID()}`,
  "2026-08-10T00:00:00.000Z",
);

const artifactIds: string[] = [];
for (let i = 0; i < 10; i += 1) {
  const artifactId = crypto.randomUUID();
  db.query(
    "INSERT INTO artifacts(id, project_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    artifactId,
    projectId,
    `op-${i}`,
    `Operator ${i}`,
    "2026-08-10T00:00:00.000Z",
    "2026-08-10T00:00:00.000Z",
  );
  artifactIds.push(artifactId);
}

const revisionShas: string[] = [];
for (const artifactId of artifactIds) {
  for (let r = 0; r < 3; r += 1) {
    const revisionId = crypto.randomUUID();
    const sha = crypto.randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64);
    const type = r % 2 === 0 ? "markdown" : "html";
    const renderer = r % 3 === 0 ? "canvas" : "svg";
    db.query(
      "INSERT INTO revisions(id, artifact_id, revision_number, parent_revision_id, artifact_type, source, sha256, note, pinned, created_at, renderer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      revisionId,
      artifactId,
      r + 1,
      null,
      type,
      new Uint8Array([r + 1]),
      sha,
      null,
      0,
      "2026-08-10T00:00:00.000Z",
      renderer,
    );
    revisionShas.push(sha);
    for (let run = 0; run < 5; run += 1) {
      db.query(
        "INSERT INTO render_runs(id, revision_id, tier, status, expected_json, observed_json, screenshot_path, console_path, screenshot_error_json, insecure_json, retained, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        crypto.randomUUID(),
        revisionId,
        run % 2 === 0 ? 0 : 1,
        run === 0 ? "error" : "ok",
        JSON.stringify({ rendererRootSvgCount: run }),
        JSON.stringify({
          rendererRootSvgCount: run,
          graphCount: 0,
          mermaidNodeCount: 0,
          visibleSvgCount: run,
          errorCount: run === 0 ? 1 : 0,
        }),
        null,
        null,
        null,
        null,
        0,
        "2026-08-10T00:00:00.000Z",
        "2026-08-10T00:00:00.000Z",
      );
    }
  }
}

const before = tableCounts(db);
const beforeFks = db.query("PRAGMA foreign_key_check").all();
const beforeVersions = db.query("SELECT version FROM schema_migrations ORDER BY version").all();
const beforeShaSample = revisionShas[0] as string;

runMigrations(db);

const after = tableCounts(db);
const afterFks = db.query("PRAGMA foreign_key_check").all();
const afterVersions = db.query("SELECT version FROM schema_migrations ORDER BY version").all();
const executionColumnPresent = (
  db.query("PRAGMA table_info(revisions)").all() as Array<{ name: string }>
).some((row) => row.name === "execution");
const compiledPathColumnPresent = (
  db.query("PRAGMA table_info(render_runs)").all() as Array<{ name: string }>
).some((row) => row.name === "compiled_path");
const allExecutionsStatic = (
  db.query("SELECT DISTINCT execution FROM revisions").all() as Array<{ execution: string }>
).every((row) => row.execution === "static");
const afterShaSample = (
  db.query("SELECT sha256, execution FROM revisions WHERE sha256 = ?").get(beforeShaSample) as
    | { sha256: string; execution: string }
    | undefined
)?.sha256;
const executionForSampledRevision = (
  db.query("SELECT execution FROM revisions WHERE sha256 = ?").get(beforeShaSample) as
    | { execution: string }
    | undefined
)?.execution;

const result = {
  beforeCounts: before,
  afterCounts: after,
  countsUnchanged: JSON.stringify(before) === JSON.stringify(after),
  beforeFksEmpty: beforeFks.length === 0,
  afterFksEmpty: afterFks.length === 0,
  beforeVersions,
  afterVersions,
  executionColumnPresent,
  compiledPathColumnPresent,
  allExecutionsStatic,
  sampledShaMatches: beforeShaSample === afterShaSample,
  sampledExecutionValue: executionForSampledRevision,
};

process.stdout.write(JSON.stringify(result, null, 2) + "\n");

function tableCounts(database: ReturnType<typeof openDatabase>) {
  return Object.fromEntries(
    ["revisions", "render_runs", "templates", "projects", "artifacts"].map((table) => [
      table,
      (database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]),
  );
}
