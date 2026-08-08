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
 * the URL parser.
 */
export function checkHost(host: string | null | undefined, expectedHost: string): HostOriginResult {
  if (host === null || host === undefined || host.length === 0) {
    return {
      ok: false,
      error: new FacetError("invalid_request", "Missing Host header", { retryable: false }),
    };
  }
  if (host !== expectedHost) {
    return {
      ok: false,
      error: new FacetError("invalid_request", `Host header does not match service origin`, {
        retryable: false,
        details: { expected: expectedHost, received: host },
      }),
    };
  }
  return { ok: true };
}

function isMutationMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "POST" || upper === "PUT" || upper === "DELETE" || upper === "PATCH";
}

/**
 * Combined check used by the route guard. Reads (`GET`) require only a
 * matching Host. Mutations additionally require:
 *   - Origin absent OR equal to ownOrigin
 *   - Sec-Fetch-Site absent OR in {same-origin, none}
 * Any other value is a typed rejection.
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
        details: { secFetchSite },
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
          details: { received: origin, expected: input.ownOrigin },
        }),
      };
    }
  }

  return { ok: true };
}
