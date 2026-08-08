/**
 * Gallery lease manager.
 *
 * A lease is a short-lived token bound to (artifactId, pid) that
 * authorizes an SSE stream reconnection for that specific artifact from
 * a specific client process. The token is never embedded in a URL —
 * clients reconnect using rotated Bearer authorization, so the SSE
 * transport never carries a query-string token (EventSource has no way
 * to set headers).
 *
 * Expiry is implemented via per-lease timers — NOT a global polling
 * loop. This avoids the cost of a periodic wakeup and bounds the cost
 * of the manager to the number of currently active leases.
 */

export interface GalleryLease {
  readonly leaseId: string;
  readonly artifactId: string;
  readonly pid: number;
  readonly expiresAt: number;
}

export interface GalleryLeaseManagerOptions {
  readonly leaseTtlMs: number;
  readonly now?: () => number;
  readonly onExpire?: (entry: { leaseId: string; artifactId: string }) => void;
}

export interface GalleryLeaseManager {
  issue(input: { artifactId: string; pid: number }): GalleryLease;
  validate(lease: GalleryLease): boolean;
  release(leaseId: string): void;
  list(): readonly GalleryLease[];
  clear(): void;
}

interface ActiveLease {
  readonly leaseId: string;
  readonly artifactId: string;
  readonly pid: number;
  readonly expiresAt: number;
}

export function createLeaseManager(options: GalleryLeaseManagerOptions): GalleryLeaseManager {
  const now = options.now ?? Date.now;
  const active = new Map<string, ActiveLease>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function expire(leaseId: string): void {
    const removed = active.get(leaseId);
    if (!removed) return;
    active.delete(leaseId);
    timers.delete(leaseId);
    options.onExpire?.({ leaseId: removed.leaseId, artifactId: removed.artifactId });
  }

  function schedule(leaseId: string, ttl: number): void {
    const existing = timers.get(leaseId);
    if (existing !== undefined) clearTimeout(existing);
    const handle = setTimeout(() => expire(leaseId), ttl);
    // Don't keep the event loop alive solely for lease timers — the
    // service goes idle when the last reason clears, and a pending
    // timer should not block shutdown.
    if (typeof handle.unref === "function") handle.unref();
    timers.set(leaseId, handle);
  }

  return {
    issue(input) {
      const issuedAt = now();
      const leaseId = crypto.randomUUID();
      const lease: ActiveLease = {
        leaseId,
        artifactId: input.artifactId,
        pid: input.pid,
        expiresAt: issuedAt + options.leaseTtlMs,
      };
      active.set(leaseId, lease);
      schedule(leaseId, options.leaseTtlMs);
      return lease;
    },
    validate(lease) {
      const record = active.get(lease.leaseId);
      if (!record) return false;
      if (record.expiresAt <= now()) return false;
      if (record.artifactId !== lease.artifactId) return false;
      if (record.pid !== lease.pid) return false;
      return true;
    },
    release(leaseId) {
      const handle = timers.get(leaseId);
      if (handle !== undefined) {
        clearTimeout(handle);
        timers.delete(leaseId);
      }
      active.delete(leaseId);
    },
    list() {
      const cutoff = now();
      const out: GalleryLease[] = [];
      for (const entry of active.values()) {
        if (entry.expiresAt > cutoff) out.push({ ...entry });
      }
      return out;
    },
    clear() {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
      active.clear();
    },
  };
}
