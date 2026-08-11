/**
 * The canonical DDL applied to a fresh database. Every column the
 * schema holds today lives here; the v1 migration runs this block
 * verbatim. Subsequent migrations extend this table set via additive
 * ALTER TABLE statements (never a destructive rewrite — the schema
 * migrations ledger records each version).
 */
export const INITIAL_SCHEMA = `
CREATE TABLE projects(
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE artifacts(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, slug)
);
CREATE TABLE revisions(
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  revision_number INTEGER NOT NULL,
  parent_revision_id TEXT REFERENCES revisions(id),
  artifact_type TEXT NOT NULL CHECK(artifact_type IN ('markdown','mermaid','svg','chart','html')),
  source BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  note TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id, revision_number),
  UNIQUE(artifact_id, sha256)
);
CREATE TABLE render_runs(
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  tier INTEGER NOT NULL CHECK(tier IN (0,1)),
  status TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  screenshot_path TEXT,
  console_path TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE TABLE templates(
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  revision_id TEXT NOT NULL REFERENCES revisions(id),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  promoted_by TEXT NOT NULL,
  promoted_at TEXT NOT NULL
);
`;

/**
 * The v2 DDL fragment — appended after `INITIAL_SCHEMA` for fresh
 * databases that land on v2 directly. Existing v1 databases pick up
 * the v2 column via the migration step in `migrations.ts`. Keeping
 * the fragment here (and not duplicated in the migration) means the
 * canonical DDL and the migration body cannot drift apart.
 */
export const V2_SCHEMA_FRAGMENT = `
ALTER TABLE render_runs ADD COLUMN retained INTEGER NOT NULL DEFAULT 0;
`;

/** The v3 DDL fragment adds renderer persistence; its literal CHECK mirrors RENDERERS deliberately and is parity-tested. */
export const V3_SCHEMA_FRAGMENT = `
ALTER TABLE revisions ADD COLUMN renderer TEXT NOT NULL DEFAULT 'svg' CHECK(renderer IN ('svg','canvas'));
`;

/** The v4 fragment preserves typed screenshot-capture failures across read-back. */
export const V4_SCHEMA_FRAGMENT = `
ALTER TABLE render_runs ADD COLUMN screenshot_error_json TEXT;
`;

/** The v5 fragment persists the insecure execution marker with each run. */
export const V5_SCHEMA_FRAGMENT = `
ALTER TABLE render_runs ADD COLUMN insecure_json TEXT;
`;

/**
 * The v6 rebuild widens revisions.artifact_type. SQLite cannot alter a CHECK
 * in place, so the official create-copy-drop-rename procedure preserves child
 * foreign-key clauses by never renaming the original table.
 */
export const V6_SCHEMA_FRAGMENT = `
CREATE TABLE revisions_v6(
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  revision_number INTEGER NOT NULL,
  parent_revision_id TEXT REFERENCES revisions(id),
  artifact_type TEXT NOT NULL CHECK(artifact_type IN ('markdown','mermaid','svg','chart','html')),
  source BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  note TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  renderer TEXT NOT NULL DEFAULT 'svg' CHECK(renderer IN ('svg','canvas')),
  UNIQUE(artifact_id, revision_number),
  UNIQUE(artifact_id, sha256)
);
INSERT INTO revisions_v6(
  id, artifact_id, revision_number, parent_revision_id, artifact_type, source, sha256,
  note, pinned, created_at, renderer
)
SELECT
  id, artifact_id, revision_number, parent_revision_id, artifact_type, source, sha256,
  note, pinned, created_at, renderer
FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_v6 RENAME TO revisions;
`;

/**
 * The v7 backfill repairs render_runs.observed_json rows written by
 * prior releases that did NOT include the `opaqueRegionCount` and
 * `externalImageCount` counters. A strict `VerdictObservedSchema.parse`
 * would 400 read-back / export / gallery-source on every pre-arc
 * artifact; the schema-level repair writes a 0 for every missing
 * counter so future reads don't have to.
 *
 * The migration is idempotent: `json_extract(observed_json, '$.x')` is
 * null when the field is absent, and `COALESCE` replaces that null with
 * 0. Re-running the migration against an already-migrated row is a
 * no-op because `COALESCE(null, 0)` and `COALESCE(0, 0)` both yield 0
 * and the rebuilt JSON is identical to the existing one.
 *
 * This is the schema-side companion to the runtime tolerant read in
 * `src/service/stored-verdict.ts` `withTolerantObserved`. The tolerant
 * read defends the boundary against a row that was written before
 * this migration ran; the migration moves the on-disk JSON to the
 * current shape so future readers can be strict again if they want.
 */
export const V7_SCHEMA_FRAGMENT = `
UPDATE render_runs
SET observed_json = json_set(
  json_set(
    observed_json,
    '$.opaqueRegionCount',
    COALESCE(json_extract(observed_json, '$.opaqueRegionCount'), 0)
  ),
  '$.externalImageCount',
  COALESCE(json_extract(observed_json, '$.externalImageCount'), 0)
)
WHERE
  json_type(observed_json, '$.opaqueRegionCount') IS NULL
  OR json_type(observed_json, '$.externalImageCount') IS NULL
`;
