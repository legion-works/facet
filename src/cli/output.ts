/**
 * Output adapter.
 *
 * stdout is reserved for the versioned JSON envelope. diagnostics,
 * help text, and kill-switch silence go to stderr. The CLI never
 * writes a human-readable body to stdout unless the caller passed
 * `--format text`, which only applies to `--help` and `--version`.
 *
 * Exit codes are adapter-safe: 0 ok, 64 usage error (EX_USAGE),
 * 65 data error (EX_DATAERR) for envelope failures, 70 internal
 * (EX_SOFTWARE) for protocol/spawn/contract failures, 75 temporary
 * (EX_TEMPFAIL) for retryable conditions. The reserved/not-implemented
 * path still exits 0 because the envelope carries the typed
 * `accepted: false` shape — adapters branch on the envelope, not the
 * exit code, for that case.
 */

import { errEnvelope, okEnvelope, type FacetEnvelope } from "../shared/contracts/envelope";
import { generateRequestId } from "../shared/util/time";

/**
 * Exit code table — single source of truth. Every CLI caller reads
 * its exit code from this map so the `--help` text and the runtime
 * dispatch can never disagree.
 */
export const EXIT_CODES = {
  /** Operation succeeded (envelope is well-formed; may still be a typed error envelope). */
  OK: 0,
  /** Usage error — unknown verb, bad flag, missing required argument. Adapter-safe. */
  USAGE: 64,
  /** The envelope was not produced (data error). Adapter-safe. */
  DATA: 65,
  /** Internal protocol/spawn/contract failure. */
  INTERNAL: 70,
  /** Retryable failure (network, transient lock contention). */
  TEMPFAIL: 75,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface CliWriter {
  write(chunk: string | Uint8Array): boolean;
}

/**
 * Pretty-print the exit-code table for `--help`. Stable string used
 * by both the help text and the test that asserts it appears.
 */
export const EXIT_CODE_TABLE: readonly { code: number; meaning: string }[] = [
  { code: EXIT_CODES.OK, meaning: "ok" },
  { code: EXIT_CODES.USAGE, meaning: "usage error (unknown verb, bad flag)" },
  { code: EXIT_CODES.DATA, meaning: "data error (envelope shape invalid)" },
  { code: EXIT_CODES.INTERNAL, meaning: "internal (spawn / contract-version mismatch)" },
  { code: EXIT_CODES.TEMPFAIL, meaning: "retryable (transient lock / connection)" },
];

/**
 * Print the envelope to stdout as a single JSON line. Newline
 * appended so shell pipelines see a complete record per call.
 */
export function printEnvelope(writer: CliWriter, envelope: FacetEnvelope<unknown>): void {
  writer.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Build an OK envelope carrying a version + contractVersion. Used by
 * `--version` (text mode) and `--version --json` (envelope mode).
 */
export function buildVersionEnvelope(
  version: string,
  contractVersion: string,
): FacetEnvelope<{
  version: string;
  contractVersion: string;
}> {
  return okEnvelope(generateRequestId(), { version, contractVersion });
}

/**
 * Build a typed error envelope for a CLI-side failure (no service
 * round-trip needed). Used by the kill switch, unknown verb, and
 * pre-spawn argument validation.
 */
export function buildUsageError(
  message: string,
  details?: Record<string, string | number | boolean | null>,
): FacetEnvelope<never> {
  return errEnvelope(generateRequestId(), {
    code: "invalid_request",
    message,
    retryable: false,
    ...(details !== undefined ? { details } : {}),
  });
}
