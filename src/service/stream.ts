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

import type { z } from "zod";

import { errEnvelope } from "../shared/contracts/envelope";
import type { RevisionCommittedEventSchema } from "../shared/contracts/events";

import { requireBearer } from "./security/auth";
import { checkHostOrigin, resolveHost } from "./security/host-origin";
import type { GalleryLease, GalleryLeaseManager } from "./security/leases";
import type { FacetLogger } from "../shared/logging/logger";
import type { IdleController } from "./lifecycle/idle-controller";
import { envelopeResponse, generateRequestId } from "./http-utils";

const NO_STORE = "no-store";
export const STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

export function assertHeartbeatBeforeLeaseTtl(
  heartbeatIntervalMs: number,
  leaseTtlMs: number,
): void {
  if (heartbeatIntervalMs >= leaseTtlMs) {
    throw new RangeError("SSE heartbeat interval must be shorter than the lease TTL");
  }
}

export type RevisionCommittedEvent = z.infer<typeof RevisionCommittedEventSchema>;

/**
 * Per-artifact fan-out for `revision:committed`. The write path
 * (dispatcher, after commit + verdict runs) calls `emit`; every live
 * SSE stream registered for that artifact receives the event. Sinks
 * are isolated — one dead stream cannot wedge the others.
 */
export interface RevisionBroadcaster {
  register(artifactId: string, send: (event: RevisionCommittedEvent) => void): () => void;
  emit(event: RevisionCommittedEvent): void;
  readonly size: number;
}

export function createRevisionBroadcaster(): RevisionBroadcaster {
  const sinks = new Map<string, Set<(event: RevisionCommittedEvent) => void>>();
  let size = 0;
  return {
    register(artifactId, send) {
      let set = sinks.get(artifactId);
      if (set === undefined) {
        set = new Set();
        sinks.set(artifactId, set);
      }
      set.add(send);
      size += 1;
      return () => {
        const current = sinks.get(artifactId);
        if (current === undefined) return;
        if (current.delete(send)) size -= 1;
        if (current.size === 0) sinks.delete(artifactId);
      };
    },
    emit(event) {
      const set = sinks.get(event.artifactId);
      if (set === undefined) return;
      // Spread snapshots the sinks so a callback that unregisters
      // itself mid-fan-out does not skip the remaining peers.
      // oxlint-disable-next-line unicorn/no-useless-spread
      for (const send of [...set]) {
        try {
          send(event);
        } catch {
          // one dead stream must not wedge the fan-out
        }
      }
    },
    get size() {
      return size;
    },
  };
}

export interface StreamHandlerDeps {
  readonly installToken: string;
  readonly leases: GalleryLeaseManager;
  readonly idle: IdleController;
  readonly logger: FacetLogger;
  readonly expectedHost: string | (() => string);
  readonly ownOrigin: string | (() => string);
  readonly broadcaster: RevisionBroadcaster;
  readonly heartbeatIntervalMs?: number;
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

  // Lease capability travels in the `X-Gallery-Lease` header, never in
  // a URL query parameter. URL tokens leak via server logs, the
  // `Referer` header on outbound navigations, and the browser history
  // — any of those would expose the lease id to processes the bearer
  // holder did not authorise. A query-string `?lease=` is REJECTED (not
  // silently accepted) so a misconfigured client sees a typed 401
  // instead of an unguarded stream.
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

  // Per-stream teardown. Every teardown path (cancel, lease-gone,
  // renew-failure) funnels through `releaseStreamOnly`; calling any of
  // them twice is a no-op (the inner `closed` guard short-circuits).
  let closed = false;
  let unregister: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  // Shared stream-only teardown: clear the heartbeat interval, drop the
  // broadcaster registration, and release the stream's idle reason. The
  // lease is deliberately NOT touched here — the cancel path keeps the
  // lease alive for the F5 refresh (the lease has its own TTL on the
  // manager and is the credential the shell persists).
  const releaseStreamOnly = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== null) clearInterval(heartbeat);
    unregister?.();
    deps.idle.release(`stream:${streamId}`);
  };

  // Full teardown: shared stream cleanup plus lease release. Runs when
  // the lease is gone (expired or explicitly released).
  const releaseLease = (): void => {
    if (closed) return;
    releaseStreamOnly();
    deps.leases.release(leaseId);
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

      // Write-path fan-out: committed revisions for THIS artifact land
      // on this stream. Unregistered on lease expiry / disconnect.
      unregister = deps.broadcaster.register(artifactId, (event) => send(event));

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

      heartbeat = setInterval(() => {
        // Re-check liveness — if the lease was removed by the expiry
        // hook or an explicit release in the meantime, the controller
        // is closed and the teardown already ran, so `closed` is set
        // and we return without re-enqueueing.
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          if (!deps.leases.renew(leaseId)) {
            // Lease is gone (released or expired). The notification path
            // normally fires first, but converge on the shared cleanup so
            // the interval and idle reason are always released.
            releaseStreamOnly();
            return;
          }
          send({ type: "stream:heartbeat", streamId, at: new Date().toISOString() });
        } catch {
          // stream torn down between check and send
          releaseStreamOnly();
        }
      }, deps.heartbeatIntervalMs ?? STREAM_HEARTBEAT_INTERVAL_MS);
      if (typeof heartbeat.unref === "function") heartbeat.unref();
    },
    cancel() {
      // Client-initiated disconnect: tear down the stream and the
      // idle reason, but leave the lease alone. The lease has its own
      // per-lease TTL on the lease manager and is the authoritative
      // credential the shell persists to sessionStorage. Releasing it
      // here would defeat the F5 refresh path: the cancel fires when
      // the navigation tears down the SSE stream, the new shell would
      // retry the lease it just released, and the typed "session
      // expired" state would mask a perfectly valid credential.
      // `stream:${streamId}` is the per-stream idle reason; the lease
      // remains governed by GalleryLeaseManager.schedule.
      releaseStreamOnly();
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
