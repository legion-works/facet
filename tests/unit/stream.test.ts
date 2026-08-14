/**
 * SSE stream teardown tests.
 *
 * The stream handler binds stream lifetime to lease lifetime. Three
 * teardown paths exist — client `cancel()`, lease-gone notification
 * (expiry OR explicit release), and renew-failure — and all of them
 * must converge on ONE idempotent cleanup that clears the heartbeat
 * interval, drops the broadcaster registration, and releases the
 * stream's idle reason. Without this, a stream leaks a 15s interval
 * firing no-ops forever and pins the idle controller, so the service
 * never goes dormant.
 */

import { describe, expect, test } from "bun:test";

import {
  createIdleController,
  type IdleController,
} from "../../src/service/lifecycle/idle-controller";
import { createLeaseManager, type GalleryLeaseManager } from "../../src/service/security/leases";
import {
  createRevisionBroadcaster,
  handleStream,
  type RevisionBroadcaster,
} from "../../src/service/stream";
import { createQuietLogger } from "../../src/shared/logging/logger";

interface StreamTestDeps {
  readonly leases: GalleryLeaseManager;
  readonly leaseId: string;
  readonly artifactId: string;
  readonly idle: IdleController;
  readonly broadcaster: RevisionBroadcaster;
  readonly renewCalls: () => number;
}

function buildDeps(): StreamTestDeps {
  const base = createLeaseManager({ leaseTtlMs: 60_000 });
  const lease = base.issue({ artifactId: "a-1", pid: process.pid });
  let renewCount = 0;
  // Spy on renew so the interval-cleared assertion can count heartbeat
  // callbacks after teardown without depending on enqueue side effects.
  const leases: GalleryLeaseManager = {
    ...base,
    renew(leaseId) {
      renewCount += 1;
      return base.renew(leaseId);
    },
  };
  return {
    leases,
    leaseId: lease.leaseId,
    artifactId: "a-1",
    idle: createIdleController({ idleTimeoutMs: 1_000 }),
    broadcaster: createRevisionBroadcaster(),
    renewCalls: () => renewCount,
  };
}

function openStream(deps: StreamTestDeps, heartbeatIntervalMs: number): Response {
  return handleStream(
    {
      installToken: "install-token",
      leases: deps.leases,
      idle: deps.idle,
      logger: createQuietLogger({ component: "stream-test" }),
      expectedHost: "127.0.0.1:1",
      ownOrigin: "http://127.0.0.1:1",
      broadcaster: deps.broadcaster,
      heartbeatIntervalMs,
    },
    {
      url: "/api/v1/stream",
      method: "GET",
      host: "127.0.0.1:1",
      origin: null,
      secFetchSite: null,
      authorization: "Bearer install-token",
      headers: {
        get(name: string) {
          if (name === "x-gallery-lease") return deps.leaseId;
          if (name === "x-gallery-artifact") return deps.artifactId;
          return null;
        },
      },
    },
  );
}

describe("handleStream teardown", () => {
  test("cancel() releases the idle reason and the broadcaster registration", async () => {
    const deps = buildDeps();
    const res = openStream(deps, 5);
    expect(res.status).toBe(200);
    expect(deps.idle.count()).toBe(1);
    expect(deps.broadcaster.size).toBe(1);

    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    expect(deps.idle.count()).toBe(0);
    expect(deps.broadcaster.size).toBe(0);
  });

  test("cancel() clears the heartbeat interval — no callback fires after teardown", async () => {
    const deps = buildDeps();
    const res = openStream(deps, 5);
    const reader = res.body!.getReader();
    await reader.read();

    // Let the heartbeat fire a few times so the interval is provably live.
    await Bun.sleep(25);
    const before = deps.renewCalls();
    expect(before).toBeGreaterThan(0);

    await reader.cancel();
    const atCancel = deps.renewCalls();

    // After teardown the interval is cleared: no further renew calls even
    // well past several heartbeat periods.
    await Bun.sleep(40);
    expect(deps.renewCalls()).toBe(atCancel);
    expect(deps.idle.count()).toBe(0);
  });

  test("explicit release() tears down the stream's idle reason and broadcaster", async () => {
    const deps = buildDeps();
    const res = openStream(deps, 5);
    const reader = res.body!.getReader();
    await reader.read();

    expect(deps.idle.count()).toBe(1);
    expect(deps.broadcaster.size).toBe(1);

    // Router-initiated release: the lease manager fires the stream's
    // expire listener, which converges on the shared cleanup.
    deps.leases.release(deps.leaseId);

    expect(deps.idle.count()).toBe(0);
    expect(deps.broadcaster.size).toBe(0);
    expect(deps.leases.list()).toEqual([]);
  });

  test("double teardown is a no-op (no throw, no double release)", async () => {
    const deps = buildDeps();
    const res = openStream(deps, 5);
    const reader = res.body!.getReader();
    await reader.read();

    await reader.cancel();
    // A second teardown path — the lease goes away after the stream was
    // already cancelled — must not throw and must not double-release.
    expect(() => deps.leases.release(deps.leaseId)).not.toThrow();
    expect(deps.idle.count()).toBe(0);
    expect(deps.broadcaster.size).toBe(0);
    expect(deps.leases.list()).toEqual([]);
  });

  test("lease expiry still tears down the stream (idle reason released)", async () => {
    const base = createLeaseManager({ leaseTtlMs: 30 });
    const lease = base.issue({ artifactId: "a-1", pid: process.pid });
    const idle = createIdleController({ idleTimeoutMs: 1_000 });
    const broadcaster = createRevisionBroadcaster();
    const res = handleStream(
      {
        installToken: "install-token",
        leases: base,
        idle,
        logger: createQuietLogger({ component: "stream-test" }),
        expectedHost: "127.0.0.1:1",
        ownOrigin: "http://127.0.0.1:1",
        broadcaster,
        // Long enough that the heartbeat never renews the lease before
        // the 30ms TTL elapses — a live heartbeat would otherwise keep
        // the lease alive forever and mask the expiry path.
        heartbeatIntervalMs: 10_000,
      },
      {
        url: "/api/v1/stream",
        method: "GET",
        host: "127.0.0.1:1",
        origin: null,
        secFetchSite: null,
        authorization: "Bearer install-token",
        headers: {
          get(name: string) {
            if (name === "x-gallery-lease") return lease.leaseId;
            if (name === "x-gallery-artifact") return "a-1";
            return null;
          },
        },
      },
    );
    const reader = res.body!.getReader();
    await reader.read();

    expect(idle.count()).toBe(1);
    // The per-lease timer fires, which closes the stream + releases the
    // idle reason and the broadcaster slot.
    await Bun.sleep(80);
    expect(idle.count()).toBe(0);
    expect(broadcaster.size).toBe(0);
  });
});
