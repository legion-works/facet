import type { FacetErrorBody } from "../contracts/envelope";

/**
 * Closed set of error codes the service can return on the wire. The store
 * layer mirrors the same names for parity (database_corrupt, etc.); the
 * protocol layer adds reserved/implemented-style codes that exist purely
 * in the envelope path.
 */
export const FacetErrorCodes = {
  // Store-derived codes (mirrored from src/service/store/database.ts).
  database_corrupt: true,
  database_busy: true,
  disk_full: true,
  duplicate_revision: true,
  foreign_key: true,
  immutable_revision: true,
  migration_failed: true,
  invalid_artifact_type: true,
  constraint: true,
  // Protocol-derived codes.
  reserved_not_implemented: true,
  unsupported_reserved_type: true,
  unknown_schema_version: true,
  payload_too_large: true,
  invalid_envelope: true,
  invalid_request: true,
  artifact_not_found: true,
  revision_not_found: true,
  template_not_found: true,
  // Generic catch-alls.
  internal: true,
} as const;

export type FacetErrorCode = keyof typeof FacetErrorCodes;

export type FacetErrorDetails = Record<string, string | number | boolean | null>;

export interface FacetErrorOptions {
  readonly retryable?: boolean;
  readonly details?: FacetErrorDetails;
  readonly cause?: unknown;
}

/**
 * Typed error class for everything that flows out through the protocol
 * envelope. Carries the wire-friendly `code`, the `retryable` flag, and
 * primitive-only `details` so a `FacetErrorBody` derived from this object
 * is always JSON-round-trippable.
 */
export class FacetError extends Error {
  override readonly name = "FacetError";

  constructor(
    readonly code: FacetErrorCode,
    message: string,
    readonly options: FacetErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  get details(): FacetErrorDetails | undefined {
    return this.options.details;
  }

  toBody(): FacetErrorBody {
    const body: FacetErrorBody = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.options.details !== undefined) {
      return { ...body, details: this.options.details };
    }
    return body;
  }

  /**
   * Coerce any thrown value into a FacetError. Pre-existing FacetErrors pass
   * through; everything else is wrapped as `invalid_envelope` (the safest
   * generic code for an untyped boundary failure).
   */
  static from(error: unknown): FacetError {
    if (error instanceof FacetError) return error;
    if (error instanceof Error) {
      return new FacetError("invalid_envelope", error.message, { cause: error });
    }
    return new FacetError("invalid_envelope", String(error));
  }
}
