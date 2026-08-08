/**
 * Idle controller — the service's single reason-counted state machine.
 *
 * Three reason kinds exist today (in-flight HTTP request, active SSE
 * gallery lease, running validation job) and the rule is the same for
 * all three: count > 0 keeps the service alive, count == 0 starts a
 * short timer, count still 0 at expiry triggers graceful shutdown.
 *
 * No DB polling, no filesystem watcher, no periodic sweep — the timer
 * is scheduled only when the count transitions to 0. This keeps the
 * dormant cost literally zero: a service that never receives a request
 * never wakes up to check.
 *
 * Lease expiry is handled in the lease manager itself (per-lease
 * unrefed timer) and notifies the controller via its own acquire/release
 * API — there is no separate lease-expiry polling loop here.
 */

export interface IdleControllerOptions {
  readonly idleTimeoutMs: number;
  readonly onIdle?: () => void | Promise<void>;
  readonly now?: () => number;
  readonly setTimer?: (handler: () => void, ms: number) => () => void;
}

export interface IdleController {
  acquire(tag: string): void;
  release(tag: string): void;
  count(): number;
  waitUntilIdle(): Promise<void>;
  stop(): void;
}

function defaultClear(handle: ReturnType<typeof setTimeout>): void {
  clearTimeout(handle);
}

export function createIdleController(options: IdleControllerOptions): IdleController {
  const counts = new Map<string, number>();
  const setTimer =
    options.setTimer ??
    ((handler: () => void, ms: number) => {
      const handle = setTimeout(handler, ms);
      if (typeof handle.unref === "function") handle.unref();
      return () => defaultClear(handle);
    });
  let timer: (() => void) | null = null;
  let fired = false;
  let idlePromise: Promise<void> | null = null;

  function ensureIdlePromise(): Promise<void> {
    if (idlePromise === null) {
      idlePromise = new Promise<void>((resolve) => {
        if (fired) {
          resolve();
        } else {
          // Stash the resolver on a private field via closure.
          idleResolvers.push(resolve);
        }
      });
    }
    return idlePromise;
  }

  const idleResolvers: Array<() => void> = [];

  function fire(): void {
    if (fired) return;
    fired = true;
    try {
      options.onIdle?.();
    } catch {
      // The handler is allowed to throw; we deliberately swallow so
      // the idle path always reaches its terminal state.
    }
    for (const resolve of idleResolvers.splice(0)) resolve();
  }

  function cancelTimer(): void {
    if (timer !== null) {
      timer();
      timer = null;
    }
  }

  function scheduleIdle(): void {
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      // Only fire if we are STILL idle when the timer expires.
      if (counts.size === 0) fire();
    }, options.idleTimeoutMs);
  }

  return {
    acquire(tag) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
      if (counts.size === 1) cancelTimer();
    },
    release(tag) {
      const current = counts.get(tag);
      if (current === undefined) return;
      if (current <= 1) counts.delete(tag);
      else counts.set(tag, current - 1);
      if (counts.size === 0 && !fired) scheduleIdle();
    },
    count() {
      let total = 0;
      for (const v of counts.values()) total += v;
      return total;
    },
    waitUntilIdle() {
      if (fired) return Promise.resolve();
      // If count is currently 0 and no timer is scheduled, schedule one
      // now so waitUntilIdle() actually fires — the count-starting-at-zero
      // case has no release() to schedule the timer on.
      if (counts.size === 0 && timer === null) scheduleIdle();
      return ensureIdlePromise();
    },
    stop() {
      cancelTimer();
      fire();
    },
  };
}
