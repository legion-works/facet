/**
 * SSE stream handler.
 *
 * The /api/v1/stream route emits revision-committed events to clients
 * that hold a valid gallery lease. Auth happens BEFORE the lease check
 * (a request without Bearer never reaches the lease logic), and the
 * lease check is bound to (artifactId, pid, leaseId) so a stolen lease
 * alone is not sufficient to subscribe.
 *
 * The transport is authed fetch + ReadableStream — NOT EventSource —
 * so headers (and therefore the Bearer token) can be carried without
 * a query-string token.
 */

import { randomUUID } from "node:crypto";

import { errEnvelope, type FacetEnvelope } from "../shared/contracts/envelope";
import { FacetError } from "../shared/errors/facet-error";

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
  readonly contentType: string | null;
  readonly authorization: string | null;
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
    return envelopeResponse(errEnvelope(requestId, hostCheck.error.toBody()), 400);
  }

  const authResult = requireBearer(req.authorization, deps.installToken);
  if (!authResult.ok) {
    return envelopeResponse(errEnvelope(requestId, authResult.error.toBody()), 401);
  }

  const url = new URL(req.url, `http://${resolveHost(deps.expectedHost)}`);
  const leaseId = url.searchParams.get("lease");
  const artifactId = url.searchParams.get("artifactId");
  if (leaseId === null || artifactId === null) {
    const err = new FacetError("invalid_request", "SSE requires lease and artifactId", {
      retryable: false,
    });
    return envelopeResponse(errEnvelope(requestId, err.toBody()), 400);
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
  const readable = new ReadableStream({
    start(controller) {
      const send = (event: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      send({ type: "stream:open", streamId, artifactId, at: new Date().toISOString() });
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        send({ type: "stream:heartbeat", streamId, at: new Date().toISOString() });
      }, 15_000);
      if (typeof heartbeat.unref === "function") heartbeat.unref();

      const stop = (): void => {
        clearInterval(heartbeat);
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "stream:close",
                streamId,
                at: new Date().toISOString(),
                reason: "client_disconnected",
              })}\n\n`,
            ),
          );
        } catch {
          // controller may already be closed
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
        deps.leases.release(leaseId);
        deps.idle.release(`stream:${streamId}`);
      };

      (controller as unknown as { facetStop?: () => void }).facetStop = stop;
    },
    cancel() {
      deps.leases.release(leaseId);
      deps.idle.release(`stream:${streamId}`);
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
