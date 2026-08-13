import { describe, expect, test } from "bun:test";

import { BUN_SOCKET_IDLE_TIMEOUT_S } from "../../src/service/server";
import { STREAM_HEARTBEAT_INTERVAL_MS } from "../../src/service/stream";

describe("Bun SSE socket idle timeout", () => {
  test("leaves at least two heartbeat intervals before Bun reaps a quiet socket", () => {
    const socketIdleTimeoutMs = BUN_SOCKET_IDLE_TIMEOUT_S * 1_000;

    expect(STREAM_HEARTBEAT_INTERVAL_MS).toBeLessThan(socketIdleTimeoutMs);
    expect(socketIdleTimeoutMs).toBeGreaterThanOrEqual(STREAM_HEARTBEAT_INTERVAL_MS * 2);
  });
});
