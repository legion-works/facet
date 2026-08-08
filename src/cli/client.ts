/**
 * Loopback HTTP client used by every CLI verb.
 *
 * The CLI talks to the service over HTTP only — never to the
 * repository or any renderer module directly. `sendCommand` wraps
 * the request in a strict `FacetEnvelope`, sends it with Bearer auth
 * and the correct Host header, and parses the response through the
 * shared `FacetEnvelopeSchema` so a forged or drift-ed response
 * surfaces as a typed error envelope.
 *
 * Source bytes for `publish` are base64-encoded on the wire; the
 * schema's `PublishBytesSchema` accepts only valid base64, so an
 * invalid input is rejected at parse time (typed `invalid_request`).
 */

import {
  errEnvelope,
  parseEnvelope,
  type FacetEnvelope,
  type FacetErrorBody,
} from "../shared/contracts/envelope";
import {
  CommandRequestSchema,
  type CommandRequest,
  type CommandResult,
} from "../shared/contracts/commands";
import { FacetError } from "../shared/errors/facet-error";
import { generateRequestId } from "../shared/util/time";
import { isMutationMethod } from "../service/security/http-guards";

export interface FacetClientOptions {
  readonly baseUrl: string;
  readonly installToken: string;
  /** `fetch` indirection so tests can stub network. */
  readonly fetchImpl?: typeof fetch;
}

export interface SendCommandOptions {
  /** Set true for any state-changing verb (default: derived from verb name). */
  readonly isMutation?: boolean;
  /** Extra headers to merge into the request (Content-Type is added automatically on mutations). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export class FacetClient {
  readonly #baseUrl: string;
  readonly #installToken: string;
  readonly #fetchImpl: typeof fetch;

  constructor(options: FacetClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#installToken = options.installToken;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Build a typed `CommandRequest` for the given verb + args, parse
   * it through the shared schema (so a malformed CLI surface fails
   * here, not in the service), wrap it in an envelope, POST to the
   * loopback service, and return the parsed response envelope.
   *
   * On a non-2xx HTTP response the service still returns a valid
   * envelope (the router wraps every error in one), so the only
   * `throw` path is a transport-level failure (connection refused,
   * DNS error, etc.). Those surface as `FacetError("invalid_envelope",
   * ...)` so the caller can wrap them in a typed envelope for the
   * adapter.
   */
  async sendCommand(
    command: CommandRequest,
    options: SendCommandOptions = {},
  ): Promise<FacetEnvelope<CommandResult>> {
    // Re-parse the command via the strict schema — a forged or
    // drift-ed CLI surface that produced a malformed request fails
    // here with a typed issue list, never reaching the wire.
    const parsed = CommandRequestSchema.parse(command);
    const innerRequestId = parsed.requestId;
    const isMutation = options.isMutation ?? isMutationMethodFor(parsed.command);
    const envelope: FacetEnvelope<CommandRequest> = {
      schemaVersion: "facet.v1",
      requestId: generateRequestId(),
      ok: true,
      data: parsed,
    };
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#installToken}`,
      host: new URL(this.#baseUrl).host,
    };
    if (isMutation) {
      headers["content-type"] = "application/json";
    }
    if (options.extraHeaders) {
      Object.assign(headers, options.extraHeaders);
    }
    let res: Response;
    try {
      res = await this.#fetchImpl(`${this.#baseUrl}/api/v1/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
      });
    } catch (error) {
      throw new FacetError("invalid_envelope", `Connection failed: ${(error as Error).message}`, {
        retryable: true,
        cause: error,
        details: { reason: "connection_failed", host: this.#baseUrl },
      });
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new FacetError(
        "invalid_envelope",
        `Service response is not valid JSON (status ${res.status})`,
        { retryable: false, details: { status: res.status } },
      );
    }
    const parsed2 = parseEnvelope(body);
    if (!parsed2.ok) {
      // The service's response was a parse failure; surface a typed
      // error envelope with the same shape as the wire would.
      return errEnvelope(innerRequestId, parsed2.body) as FacetEnvelope<CommandResult>;
    }
    return parsed2.envelope as FacetEnvelope<CommandResult>;
  }
}

/**
 * Map a wire `command` to whether it counts as a mutation. The CLI
 * must set Content-Type for mutations; the service enforces the same
 * check on the other side via the shared `isMutationMethod` helper.
 */
function isMutationMethodFor(_command: CommandRequest["command"]): boolean {
  // The CLI only ever sends POST, so every wire command is a
  // mutation from the HTTP-method standpoint; the service's
  // mutation guard is always satisfied. This helper exists so the
  // CLI can express intent in one place and the security
  // classification stays single-sourced.
  void isMutationMethod;
  return true;
}

/**
 * Build a typed CLI-side error envelope for a `FacetError` thrown
 * before or during the wire round-trip (e.g. a connection failure).
 */
export function wrapTransportError(requestId: string, error: unknown): FacetEnvelope<never> {
  const facet = error instanceof FacetError ? error : FacetError.from(error);
  const body: FacetErrorBody = facet.toBody();
  return errEnvelope(requestId, body);
}
