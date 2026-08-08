/**
 * Store-layer typed error.
 *
 * `FacetStoreError` extends `FacetError` so the store's wire-relevant
 * codes flow through `FacetError.from()` unchanged. The class lives
 * here (not in `service/store/`) so both `facet-error.ts` and the store
 * can reference it without an upward dependency from `shared/` to
 * `service/`. The bridge is the inheritance: `instanceof FacetError`
 * matches a `FacetStoreError`, the typed code + `retryable` + `details`
 * are preserved, and the router's `statusFor()` arms become live.
 */

import { FacetError, type FacetErrorCode, type FacetErrorOptions } from "./facet-error";

export type StoreErrorCode = Extract<
  FacetErrorCode,
  | "database_corrupt"
  | "database_busy"
  | "disk_full"
  | "duplicate_revision"
  | "foreign_key"
  | "immutable_revision"
  | "migration_failed"
  | "invalid_artifact_type"
  | "constraint"
>;

export class FacetStoreError extends FacetError {
  override readonly name = "FacetStoreError" as const;

  constructor(code: StoreErrorCode, message: string, options: FacetErrorOptions = {}) {
    super(code, message, options);
  }
}

/**
 * Coerce any thrown value into a typed store error. Recognizes a
 * pre-existing `FacetStoreError`; for a generic `Error` it string-matches
 * the common SQLite failure messages to a specific store code. Any
 * unrecognized error falls back to `constraint` (the generic catch-all
 * that surfaces as a 409 on the wire).
 */
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
