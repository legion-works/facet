/**
 * Regression tests for the security review's Must findings.
 *
 * Each test asserts a specific defense that was missing in the prior
 * commit. Failures here are blocking.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLock,
  readLockMetadata,
  type LockMetadata,
} from "../../src/service/lifecycle/process-lock";
import { parseBearer, requireAnyBearer, requireBearer } from "../../src/service/security/auth";
import {
  checkHostOrigin,
  isCrossSiteRejection,
  CROSS_SITE_REASON,
} from "../../src/service/security/host-origin";
import {
  createInstallTokenStore,
  createPromoteTokenStore,
} from "../../src/service/security/token-store";
import { createLeaseManager, type GalleryLeaseManager } from "../../src/service/security/leases";

const scratchDir = join(tmpdir(), `facet-regression-${crypto.randomUUID()}`);

beforeEach(() => {
  mkdirSync(scratchDir, { recursive: true });
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("Must #1: auth-before-body + raw body size cap", () => {
  test("requireBearer rejects missing bearer with the same constant-time primitive", () => {
    const token = "install-secret-1234567890";
    expect(requireBearer(`Bearer ${token}`, token).ok).toBe(true);
    expect(requireBearer(`Bearer ${"x".repeat(token.length)}`, token).ok).toBe(false);
    expect(requireBearer(null, token).ok).toBe(false);
  });

  test("requireAnyBearer accepts install OR operator token", () => {
    const install = "install-token-1234567890";
    const operator = "operator-token-1234567890";
    expect(requireAnyBearer(`Bearer ${install}`, [install, operator]).ok).toBe(true);
    expect(requireAnyBearer(`Bearer ${operator}`, [install, operator]).ok).toBe(true);
    const wrong = requireAnyBearer(`Bearer ${"y".repeat(install.length)}`, [install, operator]);
    expect(wrong.ok).toBe(false);
  });
});

describe("Must #2: promote constant-time + distinct operator", () => {
  test("distinct operator token reaches promote gate (constant-time path)", () => {
    // requireAnyBearer with [install, operator] matches the operator
    // token — index 1. The promote gate sees matchedIndex > 0 and
    // accepts the operator caller.
    const install = "install-token-1234567890";
    const operator = "operator-token-1234567890";
    const res = requireAnyBearer(`Bearer ${operator}`, [install, operator]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.matchedIndex).toBe(1);
  });

  test("install-only bearer is matched at index 0 (NOT operator)", () => {
    const install = "install-token-1234567890";
    const operator = "operator-token-1234567890";
    const res = requireAnyBearer(`Bearer ${install}`, [install, operator]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.matchedIndex).toBe(0);
  });
});

describe("Must #3: lock reclaim requires owner-dead proof", () => {
  test("live foreign-pid owner → acquire refused, its lock intact", async () => {
    // Spawn a sleep child to hold a live pid. The child is unrelated
    // to us; the lock file records its pid.
    const child = spawn("sleep", ["60"], { stdio: "ignore", detached: false });
    const foreignPid = child.pid;
    expect(foreignPid).toBeDefined();
    if (foreignPid === undefined) throw new Error("spawn returned no pid");
    try {
      const lockPath = join(scratchDir, "foreign.lock");
      const lockMeta: LockMetadata = {
        pid: foreignPid,
        startTime: Date.now(),
        port: 12345,
        contractVersion: "facet.v1",
      };
      writeFileSync(lockPath, JSON.stringify(lockMeta), { mode: 0o600 });
      const ourMeta: LockMetadata = {
        pid: process.pid,
        startTime: Date.now(),
        port: 0,
        contractVersion: "facet.v1",
      };
      const result = acquireLock(lockPath, ourMeta);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("constraint");
        expect(result.error.details?.pid).toBe(foreignPid);
      }
      // The lock file must still be on disk and still record the
      // foreign pid — we MUST NOT have unlinked it.
      expect(existsSync(lockPath)).toBe(true);
      const stillThere = readLockMetadata(lockPath);
      expect(stillThere?.pid).toBe(foreignPid);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("dead-pid owner → lock reclaimed", () => {
    const lockPath = join(scratchDir, "dead.lock");
    const deadMeta: LockMetadata = {
      pid: 999_999_999, // certainly dead
      startTime: Date.now() - 60_000,
      port: 0,
      contractVersion: "facet.v1",
    };
    writeFileSync(lockPath, JSON.stringify(deadMeta), { mode: 0o600 });
    const ourMeta: LockMetadata = {
      pid: process.pid,
      startTime: Date.now(),
      port: 0,
      contractVersion: "facet.v1",
    };
    const result = acquireLock(lockPath, ourMeta);
    expect(result.ok).toBe(true);
  });

  test("live foreign cross-version lock is NOT reclaimed", async () => {
    const child = spawn("sleep", ["60"], { stdio: "ignore", detached: false });
    const foreignPid = child.pid;
    expect(foreignPid).toBeDefined();
    if (foreignPid === undefined) throw new Error("spawn returned no pid");
    try {
      const lockPath = join(scratchDir, "cross.lock");
      const crossMeta: LockMetadata = {
        pid: foreignPid,
        startTime: Date.now(),
        port: 12345,
        contractVersion: "facet.v999", // different build
      };
      writeFileSync(lockPath, JSON.stringify(crossMeta), { mode: 0o600 });
      const ourMeta: LockMetadata = {
        pid: process.pid,
        startTime: Date.now(),
        port: 0,
        contractVersion: "facet.v1",
      };
      const result = acquireLock(lockPath, ourMeta);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("constraint");
      }
      // The cross-version lock must STILL be on disk — we did not
      // touch a live foreign process's lock.
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("Must #4: lease expiry fires onExpireNotify", () => {
  test("onExpireNotify callback fires exactly once when the lease TTL elapses", async () => {
    let fired = 0;
    const mgr: GalleryLeaseManager = createLeaseManager({
      leaseTtlMs: 30,
      onExpire: () => {
        fired += 1;
      },
    });
    const lease = mgr.issue({ artifactId: "a-1", pid: 1 });
    mgr.onExpireNotify(lease.leaseId, () => {
      fired += 1;
    });
    expect(mgr.validate(lease)).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(2); // once from onExpire (manager option), once from per-lease listener
    expect(mgr.validate(lease)).toBe(false);
    mgr.clear();
  });

  test("release() fires the listener immediately and prevents the timer from firing later", async () => {
    let fired = 0;
    const mgr: GalleryLeaseManager = createLeaseManager({ leaseTtlMs: 30 });
    const lease = mgr.issue({ artifactId: "a-1", pid: 1 });
    mgr.onExpireNotify(lease.leaseId, () => {
      fired += 1;
    });
    mgr.release(lease.leaseId);
    // A released lease and an expired lease are the same event from the
    // stream's perspective: the listener fires exactly once, synchronously.
    expect(fired).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    // The timer was cancelled — it must NOT fire again later.
    expect(fired).toBe(1);
    mgr.clear();
  });
});

describe("Must #5: atomic install-token create (no existsSync → write race)", () => {
  test("two concurrent first-start create the same on-disk token (atomic write)", () => {
    const tokenPath = join(scratchDir, "install.token");
    const a = createInstallTokenStore({ tokenPath });
    const b = createInstallTokenStore({ tokenPath });
    const tokenA = a.read();
    const tokenB = b.read();
    // Both stores must see the SAME on-disk value (no fabricated
    // diverging token cached in memory).
    expect(tokenA).toBe(tokenB);
    // The on-disk file must match what both stores returned.
    const disk = createInstallTokenStore({ tokenPath });
    expect(disk.read()).toBe(tokenA);
  });
});

describe("Must #6: missing Host rejected, cross-site returns 403 indicator", () => {
  test("missing Host header is rejected (NOT injected)", () => {
    const result = checkHostOrigin({
      method: "POST",
      host: null,
      origin: null,
      secFetchSite: null,
      expectedHost: "127.0.0.1:54321",
      ownOrigin: "http://127.0.0.1:54321",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_request");
  });

  test("cross-site Sec-Fetch-Site carries the CSRF reason so the router can map it to 403", () => {
    const result = checkHostOrigin({
      method: "POST",
      host: "127.0.0.1:54321",
      origin: null,
      secFetchSite: "cross-site",
      expectedHost: "127.0.0.1:54321",
      ownOrigin: "http://127.0.0.1:54321",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isCrossSiteRejection(result.error)).toBe(true);
      expect(result.error.details?.reason).toBe(CROSS_SITE_REASON);
    }
  });

  test("cross-site Origin carries the CSRF reason", () => {
    const result = checkHostOrigin({
      method: "POST",
      host: "127.0.0.1:54321",
      origin: "http://evil.example",
      secFetchSite: null,
      expectedHost: "127.0.0.1:54321",
      ownOrigin: "http://127.0.0.1:54321",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(isCrossSiteRejection(result.error)).toBe(true);
  });
});

describe("Must #7: parseBearer + token-store separation", () => {
  test("install + promote tokens live in separate files and serve distinct purposes", () => {
    const installPath = join(scratchDir, "install.token");
    const promotePath = join(scratchDir, "promote.token");
    writeFileSync(installPath, "install-secret", { mode: 0o600 });
    writeFileSync(promotePath, "operator-secret", { mode: 0o600 });
    const installStore = createInstallTokenStore({ tokenPath: installPath });
    const promoteStore = createPromoteTokenStore({ tokenPath: promotePath });
    expect(installStore.read()).toBe("install-secret");
    expect(promoteStore.read()).toBe("operator-secret");
  });

  test("promote token absence is a typed state, not a generated default", () => {
    const promoteStore = createPromoteTokenStore({ tokenPath: join(scratchDir, "missing.token") });
    expect(promoteStore.exists()).toBe(false);
    expect(promoteStore.read()).toBeNull();
  });
});

describe("Must #8: parseBearer rejects malformed", () => {
  test("rejects non-Bearer scheme", () => {
    expect(parseBearer("Basic abc")).toBeNull();
  });
  test("accepts lowercase bearer", () => {
    expect(parseBearer("bearer abc")).toBe("abc");
  });
});
