#!/usr/bin/env bun

import { existsSync, unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
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

const sourceIndex = process.argv.indexOf("--source");
const copyIndex = process.argv.indexOf("--copy");
const sourcePath = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined;
const copyPath = copyIndex >= 0 ? process.argv[copyIndex + 1] : undefined;

function tableCounts(db: Database) {
  return Object.fromEntries(
    ["revisions", "render_runs", "templates", "projects", "artifacts"].map((table) => [
      table,
      (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]),
  );
}

function verify(db: Database) {
  const before = tableCounts(db);
  const beforeFks = db.query("PRAGMA foreign_key_check").all();
  runMigrations(db);
  const after = tableCounts(db);
  const afterFks = db.query("PRAGMA foreign_key_check").all();
  const versions = db.query("SELECT version FROM schema_migrations ORDER BY version").all();
  const columns = db.query("PRAGMA table_info(render_runs)").all() as Array<{ name: string }>;
  const legacyRows = db.query("SELECT screenshot_format FROM render_runs").all() as Array<{
    screenshot_format: string | null;
  }>;
  const result = {
    beforeCounts: before,
    afterCounts: after,
    countsUnchanged: JSON.stringify(before) === JSON.stringify(after),
    beforeFksEmpty: beforeFks.length === 0,
    afterFksEmpty: afterFks.length === 0,
    versions,
    screenshotFormatColumnPresent: columns.some((row) => row.name === "screenshot_format"),
    legacyScreenshotFormatsNull: legacyRows.every((row) => row.screenshot_format === null),
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function refuse(message: string): never {
  process.stderr.write(
    JSON.stringify({ error: { code: "operator_migration_refused", message } }) + "\n",
  );
  process.exit(1);
}

if (sourcePath !== undefined || copyPath !== undefined) {
  if (sourcePath === undefined || copyPath === undefined)
    refuse("--source and --copy must be provided together");
  if (!existsSync(sourcePath)) refuse(`operator source is absent: ${sourcePath}`);
  const source = new Database(sourcePath, { readonly: true });
  try {
    const maxVersion = (
      source.query("SELECT MAX(version) AS version FROM schema_migrations").get() as {
        version: number | null;
      }
    ).version;
    if (maxVersion !== 8)
      refuse(`operator source must be at schema v8; found ${String(maxVersion)}`);
    if (existsSync(copyPath)) unlinkSync(copyPath);
    source.exec(`VACUUM INTO '${copyPath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  const copy = openDatabase({ databasePath: copyPath });
  try {
    verify(copy);
  } finally {
    copy.close();
  }
} else {
  const dbPath = process.argv[2] || "/tmp/facet-v9-synthetic.sqlite";
  const db = openDatabase({ databasePath: dbPath });
  try {
    db.exec(
      `${INITIAL_SCHEMA}${V2_SCHEMA_FRAGMENT}${V3_SCHEMA_FRAGMENT}${V4_SCHEMA_FRAGMENT}${V5_SCHEMA_FRAGMENT}${V6_SCHEMA_FRAGMENT}${V7_SCHEMA_FRAGMENT}`,
    );
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        version,
        "2026-08-10T00:00:00.000Z",
      );
    }
    const projectId = crypto.randomUUID();
    db.query("INSERT INTO projects(id, project_root, created_at) VALUES (?, ?, ?)").run(
      projectId,
      `/tmp/facet-v9-${crypto.randomUUID()}`,
      "2026-08-10T00:00:00.000Z",
    );
    const artifactId = crypto.randomUUID();
    db.query(
      "INSERT INTO artifacts(id, project_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      artifactId,
      projectId,
      "operator",
      "Operator",
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    );
    const revisionId = crypto.randomUUID();
    db.query(
      "INSERT INTO revisions(id, artifact_id, revision_number, artifact_type, source, sha256, pinned, created_at, renderer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      revisionId,
      artifactId,
      1,
      "markdown",
      new Uint8Array([1]),
      "0".repeat(64),
      0,
      "2026-08-10T00:00:00.000Z",
      "svg",
    );
    db.query(
      "INSERT INTO render_runs(id, revision_id, tier, status, expected_json, observed_json, screenshot_path, console_path, screenshot_error_json, insecure_json, retained, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      crypto.randomUUID(),
      revisionId,
      1,
      "ok",
      "{}",
      "{}",
      null,
      null,
      null,
      null,
      0,
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:00.000Z",
    );
    verify(db);
  } finally {
    db.close();
  }
}
