import type { Database } from "bun:sqlite";

import { asStoreError, FacetStoreError } from "./database";
import { INITIAL_SCHEMA } from "./schema";

export interface MigrationOptions {
  readonly beforeRecordVersion?: (version: number) => void;
}

export function runMigrations(db: Database, options: MigrationOptions = {}): void {
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = db
      .query("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    if (applied.some((row) => row.version === 1)) return;
    const migrate = db.transaction(() => {
      db.exec(INITIAL_SCHEMA);
      options.beforeRecordVersion?.(1);
      db.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(
        1,
        new Date().toISOString(),
      );
    });
    migrate();
  } catch (error) {
    const mapped = asStoreError(error);
    if (mapped.code === "database_corrupt" || mapped.code === "database_busy") throw mapped;
    throw new FacetStoreError("migration_failed", mapped.message, { cause: error });
  }
}
