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
  revision_capacity_pinned: true,
  // Tier 0 worker-level failures. These surface when the parent cannot
  // even obtain a Tier0Result (worker died, bad stdout, wall-clock cap,
  // output cap, unshare/unshare wrapper unavailable). Parser-level
  // failures (mermaid syntax error, hostile svg, etc.) are recorded as
  // a Tier0Result with status="error" and do NOT throw.
  tier0_timeout: true,
  tier0_protocol_error: true,
  tier0_worker_died: true,
  tier0_output_cap: true,
  tier0_unavailable: true,
  // Tier 1 verifier-level failures. Mirrors the Tier 0 worker set:
  // the parent cannot obtain a Tier1Result at all (the netns wrapper
  // is missing, the pinned shell binary is missing, the CDP pipe
  // died, the probe timed out, or the verifier could not parse the
  // browser protocol payload). Verdict-level divergences — page-shim
  // lying, missing frame, missing render-complete — surface as
  // `tampered` / `shim_only` / `timeout` / `probe_only` inside a
  // Tier1Result, NOT as a throw.
  tier1_unavailable: true,
  tier1_browser_died: true,
  tier1_protocol_error: true,
  tier1_timeout: true,
  tier1_launcher_missing: true,
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
 *
 * `FacetStoreError` extends this class — see `./store-error.ts`. The
 * `from()` bridge relies on that inheritance so a thrown store fault
 * surfaces on the wire with its typed code instead of collapsing to
 * `invalid_envelope`.
 */
export class FacetError extends Error {
  override readonly name: string = "FacetError";

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
