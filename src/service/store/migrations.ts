import type { Database } from "bun:sqlite";

import { asStoreError, FacetStoreError } from "./database";
export { INITIAL_SCHEMA } from "./schema";
import {
  INITIAL_SCHEMA,
  V2_SCHEMA_FRAGMENT,
  V3_SCHEMA_FRAGMENT,
  V4_SCHEMA_FRAGMENT,
  V5_SCHEMA_FRAGMENT,
  V6_SCHEMA_FRAGMENT,
  V7_SCHEMA_FRAGMENT,
  V8_SCHEMA_FRAGMENT,
} from "./schema";

export interface MigrationOptions {
  readonly beforeRecordVersion?: (version: number) => void;
}

interface MigrationStep {
  readonly version: number;
  /** Idempotent body — safe to re-run against an already-migrated DB. */
  readonly apply: (db: Database) => void;
}

const MIGRATION_STEPS: readonly MigrationStep[] = [
  {
    version: 1,
    apply: (db) => {
      db.exec(INITIAL_SCHEMA);
    },
  },
  {
    version: 2,
    apply: (db) => {
      // Evidence retention: the `retained` column exempts a render_run
      // from the last-N cleanup policy. Default 0 (not retained) keeps
      // every existing row eligible for eviction.
      db.exec(V2_SCHEMA_FRAGMENT);
    },
  },
  {
    version: 3,
    apply: (db) => {
      db.exec(V3_SCHEMA_FRAGMENT);
    },
  },
  {
    version: 4,
    apply: (db) => {
      db.exec(V4_SCHEMA_FRAGMENT);
    },
  },
  {
    version: 5,
    apply: (db) => {
      db.exec(V5_SCHEMA_FRAGMENT);
    },
  },
  {
    version: 6,
    apply: (db) => {
      db.exec(V6_SCHEMA_FRAGMENT);
    },
  },
  {
    version: 7,
    apply: (db) => {
      // Backfill the observed_json columns on rows written before
      // `opaqueRegionCount` (opaque-content arc) and `externalImageCount`
      // (this arc) were added. The schema-level repair is the
      // companion to the runtime tolerant read; either one alone
      // would fix this specific break, but treating the instance
      // (`VerdictObservedSchema.optional()`) would leave the next
      // counter addition to recur. Treating the boundary makes it
      // durable.
      db.exec(V7_SCHEMA_FRAGMENT);
    },
  },
  {
    version: 8,
    apply: (db) => {
      // Widens `revisions.artifact_type` to include `tsx`, adds
      // `revisions.execution` (D2, backfilled to 'static'), and adds
      // `render_runs.compiled_path` (D7, nullable for non-tsx runs
      // and pre-arc rows). The v6 FK-safe rebuild pattern is reused
      // because SQLite cannot alter a CHECK in place. Every prior
      // column is copied explicitly so the schema shape stays
      // traceable from the SQL alone.
      db.exec(V8_SCHEMA_FRAGMENT);
    },
  },
];

export function runMigrations(db: Database, options: MigrationOptions = {}): void {
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = db
      .query("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const appliedSet = new Set(applied.map((row) => row.version));
    const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    // The v6 and v8 fragments use the create-copy-drop-rename
    // pattern to widen a CHECK column (SQLite cannot ALTER a CHECK
    // in place). The new table references the OLD table via its
    // self-FK on `parent_revision_id`; SQLite refuses that sequence
    // inside a transaction with FK enforcement on, because the
    // inherited FK would be left dangling across the DROP + ALTER
    // RENAME. Temporarily disabling FKs is the established pattern
    // and re-enables them after the migration transaction commits;
    // the row-level FK constraints the data depended on are
    // re-validated by `PRAGMA foreign_key_check` from every read
    // path. This is broader than the prior v6-only gate because v8
    // rebuilds the same table.
    const disableForeignKeys = foreignKeys.foreign_keys === 1;
    if (disableForeignKeys) db.exec("PRAGMA foreign_keys = OFF");
    const migrate = db.transaction(() => {
      for (const step of MIGRATION_STEPS) {
        if (appliedSet.has(step.version)) continue;
        step.apply(db);
        options.beforeRecordVersion?.(step.version);
        db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
          step.version,
          new Date().toISOString(),
        );
      }
    });
    try {
      migrate();
    } finally {
      if (disableForeignKeys) db.exec("PRAGMA foreign_keys = ON");
    }
  } catch (error) {
    const mapped = asStoreError(error);
    if (mapped.code === "database_corrupt" || mapped.code === "database_busy") throw mapped;
    throw new FacetStoreError("migration_failed", mapped.message, { cause: error });
  }
}
