/**
 * Regression: `FacetStoreError` → `FacetError.from()` → wire bridge.
 *
 * Regression guard: every `FacetStoreError` thrown by the
 * store layer was collapsing to `invalid_envelope` on the wire because
 * `FacetError.from()` only recognised `instanceof FacetError`. The fix
 * makes `FacetStoreError` extend `FacetError`, so the bridge now
 * preserves the typed `code` + `message` + `retryable` + `details` —
 * the `statusFor()` arms in the router become live.
 *
 * These tests assert the bridge at three layers:
 *   1. `asStoreError` maps every known SQLite failure shape to the
 *      expected store code.
 *   2. `FacetError.from(facetStoreError)` returns a FacetError that
 *      preserves code/message/retryable/details.
 *   3. `statusFor()` maps every store code that has an arm to the
 *      correct HTTP status, so a router that catches via the bridge
 *      gets the right wire status.
 */

import { describe, expect, test } from "bun:test";

import {
  asStoreError,
  FacetStoreError,
  type StoreErrorCode,
} from "../../src/shared/errors/store-error";
import { FacetError, type FacetErrorCode } from "../../src/shared/errors/facet-error";
import { INVALID_JSON, statusFor } from "../../src/service/router-guards";

const STORE_CODES_WITH_STATUS_ARM: Array<{ code: StoreErrorCode; status: number }> = [
  { code: "duplicate_revision", status: 409 },
  { code: "constraint", status: 409 },
  { code: "foreign_key", status: 409 },
  { code: "immutable_revision", status: 409 },
  { code: "invalid_artifact_type", status: 409 },
];

describe("asStoreError — known SQLite failure shapes", () => {
  test("maps 'not a database' / 'malformed' / 'corrupt' → database_corrupt", () => {
    expect(asStoreError(new Error("file is not a database")).code).toBe("database_corrupt");
    expect(asStoreError(new Error("database disk image is malformed")).code).toBe(
      "database_corrupt",
    );
    expect(asStoreError(new Error("corrupt sqlite header")).code).toBe("database_corrupt");
  });

  test("maps 'busy' / 'locked' → database_busy", () => {
    expect(asStoreError(new Error("database is locked")).code).toBe("database_busy");
    expect(asStoreError(new Error("SQLITE_BUSY")).code).toBe("database_busy");
  });

  test("maps 'no space' / 'enospc' / 'disk full' → disk_full", () => {
    expect(asStoreError(new Error("ENOSPC: no space left on device")).code).toBe("disk_full");
    expect(asStoreError(new Error("disk full")).code).toBe("disk_full");
  });

  test("maps 'foreign key' → foreign_key", () => {
    expect(asStoreError(new Error("FOREIGN KEY constraint failed")).code).toBe("foreign_key");
  });

  test("maps 'unique constraint' → duplicate_revision", () => {
    expect(asStoreError(new Error("UNIQUE constraint failed: revisions.sha256")).code).toBe(
      "duplicate_revision",
    );
  });

  test("falls back to constraint for unrecognized errors", () => {
    expect(asStoreError(new Error("some other failure")).code).toBe("constraint");
  });

  test("passes through a pre-existing FacetStoreError unchanged", () => {
    const original = new FacetStoreError("disk_full", "ENOSPC", { retryable: true });
    expect(asStoreError(original)).toBe(original);
  });
});

describe("FacetStoreError → FacetError bridge", () => {
  test("FacetStoreError extends FacetError so instanceof matches", () => {
    const error = new FacetStoreError("duplicate_revision", "already exists");
    expect(error).toBeInstanceOf(FacetError);
    expect(error).toBeInstanceOf(FacetStoreError);
    expect(error).toBeInstanceOf(Error);
  });

  test("FacetError.from preserves the typed code instead of collapsing to invalid_envelope", () => {
    const storeError = new FacetStoreError("duplicate_revision", "UNIQUE constraint failed", {
      cause: new Error("raw sqlite"),
    });
    const wrapped = FacetError.from(storeError);
    expect(wrapped).toBe(storeError);
    expect(wrapped.code).toBe("duplicate_revision");
    expect(wrapped.message).toBe("UNIQUE constraint failed");
    expect(wrapped.name).toBe("FacetStoreError");
  });

  test("FacetError.from preserves retryable and details", () => {
    const storeError = new FacetStoreError("disk_full", "ENOSPC", {
      retryable: true,
      details: { sizeBytes: 0, capBytes: 1024 },
    });
    const wrapped = FacetError.from(storeError);
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.details).toEqual({ sizeBytes: 0, capBytes: 1024 });
    expect(wrapped.toBody()).toEqual({
      code: "disk_full",
      message: "ENOSPC",
      retryable: true,
      details: { sizeBytes: 0, capBytes: 1024 },
    });
  });

  test("every store code passes through FacetError.from unchanged", () => {
    const codes: StoreErrorCode[] = [
      "database_corrupt",
      "database_busy",
      "disk_full",
      "duplicate_revision",
      "foreign_key",
      "immutable_revision",
      "migration_failed",
      "invalid_artifact_type",
      "constraint",
    ];
    for (const code of codes) {
      const storeError = new FacetStoreError(code, `simulated ${code}`);
      const wrapped = FacetError.from(storeError);
      expect(wrapped.code).toBe<FacetErrorCode>(code);
      expect(wrapped.message).toBe(`simulated ${code}`);
    }
  });

  test("an asStoreError output flows through FacetError.from unchanged", () => {
    // The path the store layer actually takes: sqlite throws a raw
    // Error → asStoreError maps it → the throw bubbles up to the
    // dispatcher catch → FacetError.from is called. Every step must
    // preserve the typed code.
    const mapped = asStoreError(new Error("ENOSPC: no space left on device"));
    const wrapped = FacetError.from(mapped);
    expect(wrapped.code).toBe("disk_full");
    expect(wrapped.message).toContain("ENOSPC");
  });
});

describe("statusFor — store codes map to the right HTTP status", () => {
  test.each(STORE_CODES_WITH_STATUS_ARM)(
    "$code → $status",
    (entry: { code: StoreErrorCode; status: number }) => {
      const error = new FacetStoreError(entry.code, `simulated ${entry.code}`);
      expect(statusFor(error)).toBe(entry.status);
    },
  );

  test("default 500 covers an unrecognised store code", () => {
    // database_corrupt, database_busy, disk_full, and migration_failed
    // have no dedicated statusFor arm — they fall through to the
    // generic 500 (server-side fault, not a client mistake).
    const codesWithoutArm: StoreErrorCode[] = [
      "database_corrupt",
      "database_busy",
      "disk_full",
      "migration_failed",
    ];
    for (const code of codesWithoutArm) {
      expect(statusFor(new FacetStoreError(code, "x"))).toBe(500);
    }
  });

  test("evidence_unavailable maps to 404", () => {
    expect(
      statusFor(new FacetError("evidence_unavailable", "Screenshot evidence unavailable")),
    ).toBe(404);
  });
});

describe("INVALID_JSON sentinel — body-parse failure marker", () => {
  test("is a unique symbol so router-side checks cannot be spoofed by a JSON literal", () => {
    expect(typeof INVALID_JSON).toBe("symbol");
    // Distinct from every other symbol in the runtime.
    expect(INVALID_JSON).not.toBe(Symbol.for("anything_else"));
  });
});
