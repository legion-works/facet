import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type StoreErrorCode =
  | "database_corrupt"
  | "database_busy"
  | "disk_full"
  | "duplicate_revision"
  | "foreign_key"
  | "immutable_revision"
  | "migration_failed"
  | "invalid_artifact_type"
  | "constraint";

export class FacetStoreError extends Error {
  override readonly name = "FacetStoreError";

  constructor(
    readonly code: StoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function asStoreError(error: unknown): FacetStoreError {
  if (error instanceof FacetStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("not a database") ||
    lower.includes("malformed") ||
    lower.includes("corrupt")
  ) {
    return new FacetStoreError("database_corrupt", message, { cause: error });
  }
  if (lower.includes("busy") || lower.includes("locked")) {
    return new FacetStoreError("database_busy", message, { cause: error });
  }
  if (lower.includes("no space") || lower.includes("enospc") || lower.includes("disk full")) {
    return new FacetStoreError("disk_full", message, { cause: error });
  }
  if (lower.includes("foreign key")) {
    return new FacetStoreError("foreign_key", message, { cause: error });
  }
  if (lower.includes("unique constraint")) {
    return new FacetStoreError("duplicate_revision", message, { cause: error });
  }
  return new FacetStoreError("constraint", message, { cause: error });
}

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
  const existed = databasePath !== ":memory:" && existsSync(databasePath);
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  let db: Database;
  try {
    db = new Database(databasePath, { create: true, strict: true });
    db.exec(
      `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${Math.max(1, config.busyTimeoutMs ?? 1_000)}; PRAGMA foreign_keys = ON;`,
    );
    db.query("PRAGMA quick_check").get();
  } catch (error) {
    throw new FacetStoreError(
      "database_corrupt",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (!existed && databasePath !== ":memory:") chmodSync(databasePath, 0o600);
  return db;
}
