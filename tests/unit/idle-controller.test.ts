/**
 * Idle controller tests.
 *
 * Single state machine: count active reasons; when count transitions to
 * 0 start a timer; if it stays 0 at expiry, run the idle handler (which
 * is the service's graceful stop). Re-acquiring a reason during the
 * timer window cancels it. Reasons are tracked by tag so multiple
 * subscribers can pin/unpin independently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createIdleController,
  type IdleController,
} from "../../src/service/lifecycle/idle-controller";

let idle: IdleController;
let stopCalls: number;

beforeEach(() => {
  stopCalls = 0;
  idle = createIdleController({
    idleTimeoutMs: 50,
    onIdle: () => {
      stopCalls += 1;
    },
  });
});

afterEach(() => {
  idle.stop();
});

describe("IdleController", () => {
  test("count starts at zero and onIdle has not fired", () => {
    expect(idle.count()).toBe(0);
    expect(stopCalls).toBe(0);
  });

  test("acquiring a reason increments the count and suppresses idle", async () => {
    idle.acquire("request-1");
    expect(idle.count()).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(stopCalls).toBe(0);
    idle.release("request-1");
  });

  test("releasing the last reason starts the timer; idle fires at expiry", async () => {
    idle.acquire("lease-1");
    idle.release("lease-1");
    expect(stopCalls).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(stopCalls).toBe(1);
  });

  test("re-acquiring during the idle timer cancels it", async () => {
    idle.acquire("r");
    idle.release("r");
    await new Promise((r) => setTimeout(r, 20));
    idle.acquire("r");
    await new Promise((r) => setTimeout(r, 60));
    expect(stopCalls).toBe(0);
    idle.release("r");
    await new Promise((r) => setTimeout(r, 80));
    expect(stopCalls).toBe(1);
  });

  test("multiple reasons must all be released before idle fires", async () => {
    idle.acquire("a");
    idle.acquire("b");
    idle.acquire("c");
    idle.release("a");
    idle.release("b");
    await new Promise((r) => setTimeout(r, 80));
    expect(stopCalls).toBe(0);
    idle.release("c");
    await new Promise((r) => setTimeout(r, 80));
    expect(stopCalls).toBe(1);
  });

  test("releasing a reason never held is a no-op (no negative counts)", () => {
    idle.release("never-acquired");
    expect(idle.count()).toBe(0);
  });

  test("stop() fires onIdle exactly once even if invoked while the timer was pending", async () => {
    idle.acquire("a");
    idle.release("a");
    idle.stop();
    expect(stopCalls).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(stopCalls).toBe(1);
  });

  test("waitUntilIdle resolves when the handler fires", async () => {
    idle.acquire("x");
    idle.release("x");
    await idle.waitUntilIdle();
    expect(stopCalls).toBe(1);
  });

  test("waitUntilIdle resolves immediately after stop()", async () => {
    idle.stop();
    await idle.waitUntilIdle();
    expect(stopCalls).toBe(1);
  });
});
