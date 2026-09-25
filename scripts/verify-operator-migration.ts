#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { openDatabase } from "../src/service/store/database";
import { runMigrations } from "../src/service/store/migrations";
import { ArtifactRepository } from "../src/service/store/repository";
import { dispatch } from "../src/service/dispatcher";
import { CURRENT_STORAGE_VERSION } from "../src/shared/storage-version";
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

const postconditions: Record<
  number,
  (db: Database, sourceVersion: number) => { passed: boolean; details: Record<string, boolean> }
> = {
  9: (db, sourceVersion) => {
    const present = (
      db.query("PRAGMA table_info(render_runs)").all() as Array<{ name: string }>
    ).some((row) => row.name === "screenshot_format");
    const legacyNull =
      sourceVersion >= 9 ||
      (
        db.query("SELECT screenshot_format FROM render_runs").all() as Array<{
          screenshot_format: string | null;
        }>
      ).every((row) => row.screenshot_format === null);
    return {
      passed: present && legacyNull,
      details: { screenshotFormatColumnPresent: present, legacyScreenshotFormatsNull: legacyNull },
    };
  },
  10: (db) => {
    const present = (
      db.query("PRAGMA table_info(templates)").all() as Array<{ name: string }>
    ).some((row) => row.name === "promotion_override");
    const legacyNull =
      present &&
      (
        db.query("SELECT promotion_override FROM templates").all() as Array<{
          promotion_override: string | null;
        }>
      ).every((row) => row.promotion_override === null);
    return {
      passed: present && legacyNull,
      details: {
        promotionOverrideColumnPresent: present,
        legacyPromotionOverridesNull: legacyNull,
      },
    };
  },
};

async function verify(db: Database, sourceVersion: number) {
  let syntheticTemplateSeeded = false;
  let template = db
    .query("SELECT name, revision_id FROM templates ORDER BY promoted_at DESC LIMIT 1")
    .get() as { name: string; revision_id: string } | null;
  if (template === null) {
    const revision = db.query("SELECT id, artifact_id FROM revisions LIMIT 1").get() as {
      id: string;
      artifact_id: string;
    } | null;
    if (revision === null) refuse("source has no revision to seed a legacy template on the copy");
    template = { name: `migration-probe-${crypto.randomUUID()}`, revision_id: revision.id };
    db.query(
      "INSERT INTO templates(id, artifact_id, revision_id, name, description, promoted_by, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      crypto.randomUUID(),
      revision.artifact_id,
      revision.id,
      template.name,
      null,
      "migration-probe",
      new Date().toISOString(),
    );
    syntheticTemplateSeeded = true;
  }
  const before = tableCounts(db);
  const beforeFks = db.query("PRAGMA foreign_key_check").all();
  runMigrations(db);
  const after = tableCounts(db);
  const afterFks = db.query("PRAGMA foreign_key_check").all();
  const versions = db.query("SELECT version FROM schema_migrations ORDER BY version").all();
  const checked = Object.fromEntries(
    Object.entries(postconditions)
      .filter(
        ([version]) =>
          Number(version) >= sourceVersion && Number(version) <= CURRENT_STORAGE_VERSION,
      )
      .map(([version, assert]) => [version, assert(db, sourceVersion)]),
  );
  const sourceRevision = new ArtifactRepository(db).getRevisionById(template.revision_id);
  if (sourceRevision === null) refuse(`template source revision missing: ${template.revision_id}`);
  const instantiated = (await dispatch(
    { repository: new ArtifactRepository(db) } as never,
    {
      command: "instantiate",
      requestId: "migration-verification",
      name: template.name,
      newSlug: `migration-probe-${crypto.randomUUID()}`,
    },
    "migration-verification",
  )) as { artifact: { id: string } };
  const copiedRevision = new ArtifactRepository(db).getRevisionBySha(
    instantiated.artifact.id,
    sourceRevision.sha256,
  );
  const existingTemplateInstantiates =
    copiedRevision?.sha256 === sourceRevision.sha256 &&
    copiedRevision.artifactType === sourceRevision.artifactType;
  const result = {
    sourceVersion,
    targetVersion: CURRENT_STORAGE_VERSION,
    syntheticTemplateSeeded,
    beforeCounts: before,
    afterCounts: after,
    countsUnchanged: JSON.stringify(before) === JSON.stringify(after),
    beforeFksEmpty: beforeFks.length === 0,
    afterFksEmpty: afterFks.length === 0,
    versions,
    postconditions: checked,
    existingTemplateInstantiates,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (
    !result.countsUnchanged ||
    !result.beforeFksEmpty ||
    !result.afterFksEmpty ||
    !existingTemplateInstantiates ||
    !Object.values(checked).every((item) => item.passed) ||
    (versions.at(-1) as { version: number } | undefined)?.version !== CURRENT_STORAGE_VERSION
  )
    process.exitCode = 1;
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
  const source = new Database(sourcePath, { readonly: true, strict: true });
  let maxVersion: number;
  try {
    const foundVersion = (
      source.query("SELECT MAX(version) AS version FROM schema_migrations").get() as {
        version: number | null;
      }
    ).version;
    if (foundVersion === null || foundVersion < 1 || foundVersion >= CURRENT_STORAGE_VERSION)
      refuse(
        `operator source must be schema v1..v${CURRENT_STORAGE_VERSION - 1}; found ${String(foundVersion)}`,
      );
    maxVersion = foundVersion;
    if (existsSync(copyPath)) refuse(`copy already exists: ${copyPath}`);
    source.exec(`VACUUM INTO '${copyPath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  const copy = openDatabase({ databasePath: copyPath });
  try {
    await verify(copy, maxVersion);
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
    await verify(db, 7);
  } finally {
    db.close();
  }
}
