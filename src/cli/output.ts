/**
 * Output adapter.
 *
 * I/O surface:
 *   - stdout: `--help` text (default format), `--version` text, and
 *     every envelope (success OR typed error). The envelope is the
 *     product contract — adapters parse stdout as JSON and branch on
 *     the typed `ok` + `error.code` shape.
 *   - stderr: service-side structured JSON logs + any CLI-side
 *     diagnostic the caller might want to capture (the current
 *     `runCli` path is silent on stderr; future surface-level
 *     warnings go here).
 *
 * Exit-code policy:
 *   The envelope is the contract. Any CLI path that can produce a
 *   well-formed `FacetEnvelope` exits 0 — adapters branch on the
 *   envelope, not the exit code. Nonzero codes are reserved for
 *   paths that cannot produce a typed envelope:
 *
 *     - pre-parse usage error (unknown verb, bad flag, missing arg)
 *       → USAGE (64)
 *     - unhandled non-FacetError throw (a real bug) → INTERNAL (70)
 *
 *   Rule of thumb: malformed invocation the CLI can't turn into a
 *   typed envelope → nonzero; any well-formed envelope (incl.
 *   `ok: false` with a typed `error.code`) → exit 0.
 *
 *   The reserved `export` verb exits 0 with a typed
 *   `accepted: false` envelope — adapters see "not implemented"
 *   via the envelope, not via the exit code.
 *
 * DATA / TEMPFAIL codes from earlier drafts were removed: with the
 * envelope-first policy they are unreachable. Every `FacetError`
 * thrown by the spawn path or a per-verb builder is wrapped in a
 * typed envelope and exits 0.
 */

import { errEnvelope, okEnvelope, type FacetEnvelope } from "../shared/contracts/envelope";
import { generateRequestId } from "../shared/util/time";

/**
 * Exit code table — single source of truth. Every CLI caller reads
 * its exit code from this map so the `--help` text and the runtime
 * dispatch can never disagree.
 */
export const EXIT_CODES = {
  /** Well-formed envelope on stdout (success OR typed error). */
  OK: 0,
  /**
   * Pre-parse usage error — unknown verb, bad flag, missing
   * required argument, or a malformed invocation the CLI cannot
   * turn into a typed envelope. Distinct from typed error
   * envelopes (which also exit 0).
   */
  USAGE: 64,
  /**
   * Unhandled non-FacetError throw (a real bug). The CLI
   * surfaced an internal envelope on stdout; the nonzero exit
   * signals "shell pipeline should treat this as a crash".
   */
  INTERNAL: 70,
} as const;

export interface CliWriter {
  write(chunk: string | Uint8Array): boolean;
}

/**
 * Print the envelope to stdout as a single JSON line. Newline
 * appended so shell pipelines see a complete record per call.
 */
export function printEnvelope(writer: CliWriter, envelope: FacetEnvelope<unknown>): void {
  writer.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * Build an OK envelope carrying a version + contractVersion. Used by
 * `--version --json`; the text form of `--version` writes a plain
 * string to stdout instead.
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
 * Build a typed error envelope for a pre-parse CLI-side failure.
 * Used by the parser when it cannot turn the invocation into a
 * typed envelope (unknown verb, bad flag, missing required value).
 * The CLI still exits USAGE (64) here because the user-supplied
 * argv is what triggered the error, not the service.
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
