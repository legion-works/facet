/**
 * Bearer token authentication + constant-time comparison.
 *
 * `constantTimeEqual` runs in time proportional to `a.length` so a
 * timing-attack adversary cannot recover `b` byte-by-byte. We normalize
 * the comparison length to `b.length` (NOT `max(a.length, b.length)`)
 * so a different-length `a` produces a deterministic mismatch without
 * leaking position info — the body of the loop still touches the same
 * number of slots as `b`.
 */

import { FacetError } from "../../shared/errors/facet-error";

/**
 * Constant-time equality check. Both strings are compared slot-by-slot;
 * the loop runs the full length of `b` regardless of where `a` first
 * differs, and uses `|=(unsigned or)` to accumulate the diff so the
 * timing depends only on `b.length`.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  const len = b.length;
  for (let i = 0; i < len; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Parse an HTTP Authorization header and return the Bearer token, or
 * null when the header is missing, malformed, or carries a different
 * scheme. The scheme match is case-insensitive per RFC 7235.
 */
export function parseBearer(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  const space = trimmed.indexOf(" ");
  if (space <= 0) return null;
  const scheme = trimmed.slice(0, space).toLowerCase();
  if (scheme !== "bearer") return null;
  const token = trimmed.slice(space + 1).trim();
  if (token.length === 0) return null;
  return token;
}

export type BearerAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: FacetError };

/**
 * Validate that a request carries a Bearer token equal to the expected
 * install token (constant-time compare). The caller supplies the request
 * header and the expected token; this function returns a typed 401
 * FacetError when the header is missing/malformed/wrong.
 */
export function requireBearer(
  header: string | null | undefined,
  expected: string,
): BearerAuthResult {
  if (typeof expected !== "string" || expected.length === 0) {
    return {
      ok: false,
      error: new FacetError("internal", "Server has no install token configured", {
        retryable: false,
      }),
    };
  }
  const token = parseBearer(header);
  if (token === null) {
    return {
      ok: false,
      error: new FacetError("invalid_envelope", "Missing or malformed Authorization header", {
        retryable: false,
        details: { reason: "missing_bearer" },
      }),
    };
  }
  if (!constantTimeEqual(token, expected)) {
    return {
      ok: false,
      error: new FacetError("invalid_envelope", "Invalid bearer token", {
        retryable: false,
        details: { reason: "token_mismatch" },
      }),
    };
  }
  return { ok: true };
}

export interface MutationHeaderCheck {
  readonly method: string;
  readonly contentType: string | null | undefined;
}

/**
 * Enforce `Content-Type: application/json` on every state-changing
 * request. Anything else (or no content type at all) is rejected with a
 * typed invalid_request error so a CSRF vector that submits form-encoded
 * bodies never reaches the dispatcher.
 */
export function checkMutationSecurityHeaders(check: MutationHeaderCheck): BearerAuthResult {
  if (!isMutationMethod(check.method)) return { ok: true };
  const ct = (check.contentType ?? "").trim().toLowerCase();
  if (ct === "application/json" || ct.startsWith("application/json;")) return { ok: true };
  return {
    ok: false,
    error: new FacetError("invalid_request", "Mutations require Content-Type: application/json", {
      retryable: false,
      details: { received: check.contentType ?? null },
    }),
  };
}

function isMutationMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "POST" || upper === "PUT" || upper === "DELETE" || upper === "PATCH";
}
