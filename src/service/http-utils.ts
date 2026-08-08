/**
 * HTTP utilities shared by the router and the SSE stream.
 *
 * `envelopeResponse` is the single Response builder for every Facet
 * route. The `cache-control: no-store` header is universal — no Facet
 * response is cacheable, and a divergent cache header between routes
 * would let a proxy pin a stale error envelope for a future caller.
 *
 * `generateRequestId` lives in `src/shared/util/time.ts` and is
 * re-exported here so the existing import sites (router.ts, stream.ts)
 * keep working without churn.
 */

import { type FacetEnvelope } from "../shared/contracts/envelope";
import { generateRequestId } from "../shared/util/time";

export { generateRequestId };

const NO_STORE = "no-store";

export function envelopeResponse(envelope: FacetEnvelope<unknown>, status: number): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": NO_STORE,
    },
  });
}

/**
 * Prefer a caller-supplied request id (when present and non-empty),
 * otherwise mint one. The router uses the `null` form to always mint;
 * a future caller can forward an upstream correlation id unchanged.
 */
export function pickRequestId(header: string | null | undefined): string {
  if (header === null || header === undefined) return generateRequestId();
  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : generateRequestId();
}
