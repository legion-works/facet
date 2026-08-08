/**
 * HTTP utilities shared by the router and the SSE stream.
 *
 * `envelopeResponse` and `generateRequestId` were duplicated between
 * router.ts and stream.ts; both files now import from here. The
 * `cache-control: no-store` header is universal — no Facet response is
 * cacheable, and a divergent cache header between routes would let a
 * proxy pin a stale error envelope for a future caller.
 */

import { randomUUID } from "node:crypto";

import { type FacetEnvelope } from "../shared/contracts/envelope";

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

export function generateRequestId(): string {
  return `req-${randomUUID()}`;
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
