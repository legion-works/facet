/**
 * SSE stream handler.
 *
 * The /api/v1/stream route emits revision-committed events to clients
 * that hold a valid gallery lease. Auth happens BEFORE the lease check
 * (a request without Bearer never reaches the lease logic), and the
 * lease capability is carried via the authed fetch header — the
 * `leaseId` is never embedded in a URL query parameter.
 *
 * Stream lifetime is bound to the lease: when the lease expires, the
 * per-lease timer fires the manager's expiry-listener, which closes
 * the controller and releases the stream's idle reason. Without this
 * binding, the SSE connection would outlast its lease and the
 * stream:<id> idle reason would pin the service alive forever.
 */

import { randomUUID } from "node:crypto";

import { errEnvelope, type FacetEnvelope } from "../shared/contracts/envelope";

import { requireBearer } from "./security/auth";
import { checkHostOrigin } from "./security/host-origin";
import type { GalleryLease, GalleryLeaseManager } from "./security/leases";
import type { FacetLogger } from "../shared/logging/logger";
import type { IdleController } from "./lifecycle/idle-controller";

const NO_STORE = "no-store";

export interface StreamHandlerDeps {
  readonly installToken: string;
  readonly leases: GalleryLeaseManager;
  readonly idle: IdleController;
  readonly logger: FacetLogger;
  readonly expectedHost: string | (() => string);
  readonly ownOrigin: string | (() => string);
}

function resolveHost(value: string | (() => string)): string {
  return typeof value === "function" ? value() : value;
}

interface StreamParsedRequest {
  readonly url: string;
  readonly method: string;
  readonly host: string | null;
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  readonly authorization: string | null;
  readonly headers: { get(name: string): string | null };
}

function envelopeResponse(envelope: FacetEnvelope<unknown>, status: number): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": NO_STORE,
    },
  });
}

function generateRequestId(): string {
  return `req-${randomUUID()}`;
}

export function handleStream(deps: StreamHandlerDeps, req: StreamParsedRequest): Response {
  const requestId = generateRequestId();

  const hostCheck = checkHostOrigin({
    method: req.method,
    host: req.host,
    origin: req.origin,
    secFetchSite: req.secFetchSite,
    expectedHost: resolveHost(deps.expectedHost),
    ownOrigin: resolveHost(deps.ownOrigin),
  });
  if (!hostCheck.ok) {
    let status = 400;
    if (hostCheck.error.code === "invalid_request") {
      const reason = (hostCheck.error.details as { reason?: string } | undefined)?.reason;
      if (reason === "cross_site_mutation") status = 403;
      else if (reason === "missing_host") status = 421;
    }
    return envelopeResponse(errEnvelope(requestId, hostCheck.error.toBody()), status);
  }

  const authResult = requireBearer(req.authorization, deps.installToken);
  if (!authResult.ok) {
    return envelopeResponse(errEnvelope(requestId, authResult.error.toBody()), 401);
  }

  // Lease capability is carried via the authed header, not the URL.
  // The previous contract exposed `?lease=<id>&artifactId=<id>` in the
  // query string; EventSource cannot set headers, so the SSE path was
  // historically routed through a query-token URL. That design leaked
  // the lease id to any process that read the URL (logs, referrers,
  // browser history). Authed fetch + ReadableStream lets the bearer
  // carry the lease id without putting it in any URL — a caller that
  // holds the lease asks for it out-of-band and supplies it as an
  // `X-Gallery-Lease` header. A query-string `?lease=` is REJECTED
  // (not silently accepted) so a misconfigured client sees a typed
  // 401/403 instead of an unguarded stream.
  const leaseId = req.headers.get("x-gallery-lease");
  const artifactId = req.headers.get("x-gallery-artifact");
  if (leaseId === null || artifactId === null) {
    return envelopeResponse(
      errEnvelope(requestId, {
        code: "invalid_envelope",
        message:
          "SSE requires X-Gallery-Lease + X-Gallery-Artifact headers (no query-string fallback)",
        retryable: false,
        details: { reason: "lease_header_missing" },
      }),
      401,
    );
  }

  const lease: GalleryLease = {
    leaseId,
    artifactId,
    pid: process.pid,
    expiresAt: Date.now() + 1_000,
  };
  if (!deps.leases.validate(lease)) {
    return envelopeResponse(
      errEnvelope(requestId, {
        code: "invalid_envelope",
        message: "Lease is invalid or expired",
        retryable: false,
        details: { reason: "lease_invalid" },
      }),
      401,
    );
  }

  const streamId = randomUUID();
  deps.idle.acquire(`stream:${streamId}`);
  const encoder = new TextEncoder();

  // Per-stream close handle. The lease-expiry callback AND the
  // ReadableStream cancel handler both call this — calling it twice is
  // safe (the inner guards short-circuit).
  let closed = false;
  const releaseLease = (): void => {
    if (closed) return;
    closed = true;
    deps.leases.release(leaseId);
    deps.idle.release(`stream:${streamId}`);
  };

  const readable = new ReadableStream({
    start(controller) {
      const send = (event: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // controller already closed (lease expired mid-send)
        }
      };
      send({ type: "stream:open", streamId, artifactId, at: new Date().toISOString() });

      // Bind stream lifetime to lease lifetime. When the per-lease
      // timer fires, we close the stream + release the idle reason.
      deps.leases.onExpireNotify(leaseId, () => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "stream:close",
                streamId,
                at: new Date().toISOString(),
                reason: "lease_expired",
              })}\n\n`,
            ),
          );
        } catch {
          // already closed
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
        releaseLease();
      });

      const heartbeat = setInterval(() => {
        // Re-check liveness — if the lease was released by the expiry
        // hook in the meantime, the controller is closed and these
        // enqueues throw, which the surrounding try/catch swallows.
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          send({ type: "stream:heartbeat", streamId, at: new Date().toISOString() });
        } catch {
          // stream torn down between check and send
          clearInterval(heartbeat);
          releaseLease();
        }
      }, 15_000);
      if (typeof heartbeat.unref === "function") heartbeat.unref();

      const stop = (): void => {
        clearInterval(heartbeat);
        releaseLease();
      };

      (controller as unknown as { facetStop?: () => void }).facetStop = stop;
    },
    cancel() {
      // Client-initiated disconnect: tear down without sending close.
      releaseLease();
    },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": NO_STORE,
      "x-accel-buffering": "no",
    },
  });
}
