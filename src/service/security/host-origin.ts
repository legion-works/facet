/**
 * Host + Origin + Sec-Fetch-Site guard.
 *
 * DNS-rebinding defense: a request whose `Host` header is anything other
 * than `127.0.0.1:<port>` is rejected — the loopback service must NOT
 * serve a request that was forged from an external DNS name pointing
 * at it.
 *
 * Cross-site forgery defense: a mutation that arrives with an `Origin`
 * header not equal to the service's own origin OR with `Sec-Fetch-Site`
 * set to anything other than `same-origin` / `none` is rejected. Reads
 * (GET) intentionally bypass these checks so a same-process client can
 * poll status without Origin noise.
 */

import { FacetError } from "../../shared/errors/facet-error";

import { isMutationMethod } from "./http-guards";

export interface HostOriginInput {
  readonly method: string;
  readonly host: string | null | undefined;
  readonly origin: string | null | undefined;
  readonly secFetchSite: string | null | undefined;
  readonly expectedHost: string;
  readonly ownOrigin: string;
}

export type HostOriginResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: FacetError };

const SAFE_SEC_FETCH_SITE = new Set(["same-origin", "none", ""]);

/**
 * Reject when `Host` !== `expectedHost` exactly. The check is byte-exact
 * — no canonicalization of `127.0.0.1.` with a trailing dot, no
 * case-folding — so a forged header cannot sneak through a quirk of
 * the URL parser. A null/empty `Host` is its own typed 400 (`reason:
 * "missing_host"`) so the caller can distinguish "no host at all"
 * from "host mismatch" — both fail-closed, neither is a 500.
 */
export const HOST_MISSING_REASON = "missing_host" as const;

export function checkHost(host: string | null | undefined, expectedHost: string): HostOriginResult {
  if (host === null || host === undefined || host.length === 0) {
    return {
      ok: false,
      error: new FacetError("invalid_request", "Missing Host header", {
        retryable: false,
        details: { reason: HOST_MISSING_REASON },
      }),
    };
  }
  if (host !== expectedHost) {
    return {
      ok: false,
      error: new FacetError("invalid_request", `Host header does not match service origin`, {
        retryable: false,
        details: { reason: "host_mismatch", expected: expectedHost, received: host },
      }),
    };
  }
  return { ok: true };
}

/**
 * Resolve a host configuration value: either a static string or a
 * function that returns the live value. Exported so router.ts and
 * stream.ts can use the same accessor (a duplicated copy in either
 * file would risk one of them forgetting to call the function form).
 */
export function resolveHost(value: string | (() => string)): string {
  return typeof value === "function" ? value() : value;
}

export const CROSS_SITE_REASON = "cross_site_mutation" as const;

/**
 * Combined check used by the route guard. Reads (`GET`) require only a
 * matching Host. Mutations additionally require:
 *   - Origin absent OR equal to ownOrigin
 *   - Sec-Fetch-Site absent OR in {same-origin, none}
 * Any other value is a typed rejection. Cross-site mutation failures
 * carry `details.reason === CROSS_SITE_REASON` so the caller can map
 * them to a 403 (CSRF) status instead of a 400 (malformed request).
 */
export function checkHostOrigin(input: HostOriginInput): HostOriginResult {
  const hostResult = checkHost(input.host, input.expectedHost);
  if (!hostResult.ok) return hostResult;

  if (!isMutationMethod(input.method)) return { ok: true };

  const secFetchSite = (input.secFetchSite ?? "").toLowerCase();
  if (secFetchSite.length > 0 && !SAFE_SEC_FETCH_SITE.has(secFetchSite)) {
    return {
      ok: false,
      error: new FacetError("invalid_request", `Cross-site mutation rejected`, {
        retryable: false,
        details: { reason: CROSS_SITE_REASON, secFetchSite },
      }),
    };
  }

  const origin = input.origin;
  if (origin !== null && origin !== undefined && origin.length > 0) {
    if (origin !== input.ownOrigin) {
      return {
        ok: false,
        error: new FacetError("invalid_request", `Origin does not match service origin`, {
          retryable: false,
          details: { reason: CROSS_SITE_REASON, received: origin, expected: input.ownOrigin },
        }),
      };
    }
  }

  return { ok: true };
}

export function isCrossSiteRejection(error: FacetError | undefined): boolean {
  return (
    error?.code === "invalid_request" &&
    (error.details as { reason?: string } | undefined)?.reason === CROSS_SITE_REASON
  );
}

/**
 * True when a host-check rejection is a missing-host case (vs a host
 * mismatch). Useful for the route guard to map both to 400 but log /
 * surface them differently.
 */
export function isMissingHostRejection(error: FacetError | undefined): boolean {
  return (
    error?.code === "invalid_request" &&
    (error.details as { reason?: string } | undefined)?.reason === HOST_MISSING_REASON
  );
}
