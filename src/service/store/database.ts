import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

import { FacetStoreError } from "../../shared/errors/store-error";
import { ensureOwnerOnlyDirectory } from "../../shared/util/dir-permissions";

// `FacetStoreError` + `asStoreError` + `StoreErrorCode` live in
// `shared/errors/store-error.ts` so they can extend `FacetError`
// without an upward import from `shared/` to `service/`. Re-exported
// here so existing `import { ... } from "./database"` call sites keep
// working unchanged.
export {
  FacetStoreError,
  asStoreError,
  type StoreErrorCode,
} from "../../shared/errors/store-error";

export interface DatabasePaths {
  readonly databasePath?: string;
  readonly dbPath?: string;
  readonly path?: string;
  readonly busyTimeoutMs?: number;
}

export type FacetDatabase = Database;

export function openDatabase(paths: DatabasePaths | string): FacetDatabase {
  const config = typeof paths === "string" ? { databasePath: paths } : paths;
  const databasePath = config.databasePath ?? config.dbPath ?? config.path;
  if (!databasePath) throw new FacetStoreError("constraint", "A database path is required");
  if (databasePath !== ":memory:") ensureOwnerOnlyDirectory(dirname(databasePath));
  let db: Database;
  try {
    db = new Database(databasePath, { create: true, strict: true });
    db.exec(
      `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${Math.max(1, config.busyTimeoutMs ?? 1_000)}; PRAGMA foreign_keys = ON;`,
    );
    db.query("PRAGMA quick_check").get();
    hardenDatabaseFiles(databasePath);
  } catch (error) {
    throw new FacetStoreError(
      "database_corrupt",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  return db;
}

/** SQLite can recreate WAL sidecars with the process umask; chmod is repeated after writes where paths exist. */
export function hardenDatabaseFiles(databasePath: string): void {
  if (databasePath === ":memory:") return;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      chmodSync(`${databasePath}${suffix}`, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
