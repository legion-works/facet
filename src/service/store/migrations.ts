import type { Database } from "bun:sqlite";

import { asStoreError, FacetStoreError } from "./database";
import { INITIAL_SCHEMA, V2_SCHEMA_FRAGMENT } from "./schema";

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
    migrate();
  } catch (error) {
    const mapped = asStoreError(error);
    if (mapped.code === "database_corrupt" || mapped.code === "database_busy") throw mapped;
    throw new FacetStoreError("migration_failed", mapped.message, { cause: error });
  }
}
