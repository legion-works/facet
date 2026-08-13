/**
 * Gallery lease tests.
 *
 * Leases are short-lived, bound to (artifactId, pid), and consumed by
 * the SSE stream guard. Expiry is enforced by a per-lease timer
 * (no global polling loop) — verified by inspecting the manager's
 * reported lease list and the expiry callback contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createLeaseManager, type GalleryLeaseManager } from "../../src/service/security/leases";
import { assertHeartbeatBeforeLeaseTtl } from "../../src/service/stream";

let manager: GalleryLeaseManager;
const callbacks: Array<{ leaseId: string; artifactId: string }> = [];

beforeEach(() => {
  manager = createLeaseManager({ leaseTtlMs: 1_000, onExpire: (entry) => callbacks.push(entry) });
});

afterEach(() => {
  manager.clear();
  callbacks.length = 0;
});

describe("GalleryLeaseManager", () => {
  test("requires the heartbeat interval to be shorter than the lease TTL", () => {
    expect(() => assertHeartbeatBeforeLeaseTtl(100, 300)).not.toThrow();
    expect(() => assertHeartbeatBeforeLeaseTtl(300, 300)).toThrow(
      "SSE heartbeat interval must be shorter than the lease TTL",
    );
  });

  test("issues a lease bound to (artifactId, pid)", () => {
    const lease = manager.issue({ artifactId: "a-1", pid: 42 });
    expect(lease.leaseId.length).toBeGreaterThan(0);
    expect(lease.artifactId).toBe("a-1");
    expect(lease.pid).toBe(42);
    expect(lease.expiresAt).toBeGreaterThan(Date.now());
  });

  test("issues distinct leaseIds", () => {
    const a = manager.issue({ artifactId: "a-1", pid: 1 });
    const b = manager.issue({ artifactId: "a-1", pid: 1 });
    expect(a.leaseId).not.toBe(b.leaseId);
  });

  test("validate() accepts a fresh lease for the right (artifactId, pid)", () => {
    const lease = manager.issue({ artifactId: "a-1", pid: 42 });
    expect(manager.validate(lease)).toBe(true);
  });

  test("validate() rejects when artifactId mismatches", () => {
    const lease = manager.issue({ artifactId: "a-1", pid: 42 });
    expect(manager.validate({ ...lease, artifactId: "a-2" })).toBe(false);
  });

  test("validate() rejects when pid mismatches", () => {
    const lease = manager.issue({ artifactId: "a-1", pid: 42 });
    expect(manager.validate({ ...lease, pid: 99 })).toBe(false);
  });

  test("validate() rejects unknown leaseIds", () => {
    expect(
      manager.validate({
        leaseId: "no-such",
        artifactId: "a-1",
        pid: 1,
        expiresAt: Date.now() + 1_000,
      }),
    ).toBe(false);
  });

  test("release() removes the lease from the active set", () => {
    const lease = manager.issue({ artifactId: "a-1", pid: 42 });
    manager.release(lease.leaseId);
    expect(manager.validate(lease)).toBe(false);
  });

  test("expiry callback fires once when the lease TTL elapses", async () => {
    const shortManager = createLeaseManager({
      leaseTtlMs: 30,
      onExpire: (entry) => callbacks.push(entry),
    });
    const lease = shortManager.issue({ artifactId: "a-1", pid: 42 });
    expect(shortManager.validate(lease)).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(shortManager.validate(lease)).toBe(false);
    const seen = callbacks.find((c) => c.leaseId === lease.leaseId);
    expect(seen).toBeDefined();
    shortManager.clear();
  });

  test("release() prevents the expiry callback from firing later", async () => {
    const shortManager = createLeaseManager({
      leaseTtlMs: 30,
      onExpire: (entry) => callbacks.push(entry),
    });
    const lease = shortManager.issue({ artifactId: "a-1", pid: 1 });
    shortManager.release(lease.leaseId);
    await new Promise((r) => setTimeout(r, 60));
    expect(callbacks.find((c) => c.leaseId === lease.leaseId)).toBeUndefined();
    shortManager.clear();
  });

  test("renew() extends a live lease past its original expiry", async () => {
    const shortManager = createLeaseManager({ leaseTtlMs: 80 });
    const lease = shortManager.issue({ artifactId: "a-1", pid: 42 });

    await Bun.sleep(50);
    expect(shortManager.renew(lease.leaseId)).toBe(true);

    const renewed = shortManager.list().find((entry) => entry.leaseId === lease.leaseId);
    expect(renewed?.expiresAt).toBeGreaterThan(lease.expiresAt);

    await Bun.sleep(50);
    expect(shortManager.validate(lease)).toBe(true);
    shortManager.clear();
  });

  test("renew() refuses an expired lease without resurrecting it", async () => {
    const shortManager = createLeaseManager({
      leaseTtlMs: 30,
      onExpire: (entry) => callbacks.push(entry),
    });
    const lease = shortManager.issue({ artifactId: "a-1", pid: 42 });

    await Bun.sleep(80);
    expect(shortManager.renew(lease.leaseId)).toBe(false);
    expect(shortManager.list()).toEqual([]);
    expect(callbacks.filter((entry) => entry.leaseId === lease.leaseId)).toHaveLength(1);

    await Bun.sleep(40);
    expect(callbacks.filter((entry) => entry.leaseId === lease.leaseId)).toHaveLength(1);
    shortManager.clear();
  });

  test("renew() refuses an unknown lease", () => {
    expect(manager.renew("no-such")).toBe(false);
  });

  test("list() reflects active leases only", () => {
    const a = manager.issue({ artifactId: "a-1", pid: 1 });
    manager.issue({ artifactId: "a-2", pid: 1 });
    manager.release(a.leaseId);
    expect(manager.list()).toHaveLength(1);
  });
});
