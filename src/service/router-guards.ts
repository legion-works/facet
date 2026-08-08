/**
 * Command-route guard helpers.
 *
 * These support functions implement the per-request checks that sit
 * between `handleCommand`'s header read and its dispatch call:
 * request-metadata extraction, body-cap enforcement, JSON parsing,
 * and the `FacetError.code → HTTP status` mapping used by the
 * catch-all error path. The guard ORDER stays in `router.ts` so the
 * 7-step pipeline (host → auth → content-type → body-cap → parse →
 * command-validate → reserved-verb → promote → dispatch) is readable
 * at the call site; this file holds the pieces, not the orchestration.
 */

import { FacetError } from "../shared/errors/facet-error";

/**
 * Hard ceiling on the raw HTTP body. Distinct from `SOURCE_CAP_BYTES`
 * (which governs artifact payload bytes after decode). 16 MiB is well
 * above 5 MiB source × 4/3 base64 envelope slack, so a legitimate
 * client never hits it.
 */
export const RAW_BODY_CAP_BYTES = 16 * 1024 * 1024;

/**
 * Request metadata extracted from headers — read BEFORE the body.
 * Auth, mutation headers, and the raw size cap all branch on this
 * object; the body itself is read only after those checks pass. This
 * split keeps unauthenticated requests from touching the body at all.
 */
export interface RequestMeta {
  readonly url: string;
  readonly method: string;
  readonly host: string | null;
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  readonly contentType: string | null;
  readonly authorization: string | null;
  readonly contentLength: number | null;
  readonly headers: { get(name: string): string | null };
}

export function readRequestMeta(req: Request): RequestMeta {
  const url = new URL(req.url);
  const cl = req.headers.get("content-length");
  return {
    url: url.pathname + url.search,
    method: req.method,
    host: req.headers.get("host"),
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    contentType: req.headers.get("content-type"),
    authorization: req.headers.get("authorization"),
    contentLength: cl !== null ? Number(cl) : null,
    headers: req.headers,
  };
}

/**
 * Read the request body up to `RAW_BODY_CAP_BYTES`. The Content-Length
 * header is the cheap first check (no body read needed when it already
 * exceeds the cap); a second check after `req.text()` defends against a
 * missing or lying Content-Length. Both violations throw the same typed
 * `payload_too_large` error so the catch path returns a uniform 413.
 */
export async function readCappedBody(req: Request, contentLength: number | null): Promise<string> {
  if (contentLength !== null) {
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new FacetError("invalid_request", "Invalid Content-Length", { retryable: false });
    }
    if (contentLength > RAW_BODY_CAP_BYTES) {
      throw new FacetError("payload_too_large", "Request body exceeds raw cap", {
        retryable: false,
        details: { capBytes: RAW_BODY_CAP_BYTES, receivedBytes: contentLength },
      });
    }
  }
  const text = await req.text();
  if (text.length > RAW_BODY_CAP_BYTES) {
    throw new FacetError("payload_too_large", "Request body exceeds raw cap", {
      retryable: false,
      details: { capBytes: RAW_BODY_CAP_BYTES, receivedBytes: text.length },
    });
  }
  return text;
}

/**
 * Parse the body text as JSON. On failure, return a sentinel symbol
 * (`Symbol.for("invalid_json")`) rather than throwing — the caller
 * decides how to surface it as an envelope error, keeping this helper
 * free of envelope concerns.
 */
export function parseBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    return Symbol.for("invalid_json");
  }
}

export const INVALID_JSON = Symbol.for("invalid_json");

/**
 * Map a `FacetError.code` to its HTTP status. Store codes that share
 * a status with non-store codes (e.g. `constraint` and `duplicate_revision`
 * both 409) are grouped so the switch arms stay flat. The default 500
 * covers unrecognized codes; tier1_* failures are handled in runTier1Safe
 * before reaching this function, while other codes without an explicit arm
 * fall through to 500.
 */
export function statusFor(error: FacetError): number {
  switch (error.code) {
    case "artifact_not_found":
    case "revision_not_found":
    case "template_not_found":
      return 404;
    case "payload_too_large":
      return 413;
    case "reserved_not_implemented":
    case "unsupported_reserved_type":
    case "invalid_envelope":
    case "invalid_request":
    case "unknown_schema_version":
      return 400;
    case "tier0_unavailable":
      return 503;
    case "duplicate_revision":
    case "constraint":
    case "foreign_key":
    case "immutable_revision":
    case "invalid_artifact_type":
    case "revision_capacity_pinned":
      return 409;
    case "tier0_timeout":
    case "tier0_protocol_error":
    case "tier0_worker_died":
    case "tier0_output_cap":
      return 422;
    default:
      return 500;
  }
}
