import { describe, expect, test } from "bun:test";

import { FacetClient } from "../../src/cli/client";
import { FacetError } from "../../src/shared/errors/facet-error";
import { generateRequestId } from "../../src/shared/util/time";

describe("FacetClient transport", () => {
  test("promote requests use the configured operator bearer", async () => {
    let authorization: string | null = null;
    const client = new FacetClient({
      baseUrl: "http://127.0.0.1:1",
      installToken: "install-token",
      promoteToken: "operator-token",
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get("authorization");
        throw new Error("stop after request capture");
      }) as unknown as typeof fetch,
    });

    await expect(
      client.sendCommand({
        command: "promote",
        requestId: generateRequestId(),
        revisionId: "revision",
        name: "stable",
        promotedBy: "operator",
      }),
    ).rejects.toBeInstanceOf(FacetError);
    expect(authorization as string | null).toBe("Bearer operator-token");
  });

  test("command timeout surfaces a typed retryable transport error", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const client = new FacetClient({
      baseUrl: "http://127.0.0.1:1",
      installToken: "x".repeat(32),
      commandTimeoutMs: 10,
      fetchImpl,
    });

    try {
      await client.sendCommand({
        command: "list",
        requestId: generateRequestId(),
        projectId: "/facet",
      });
      throw new Error("expected sendCommand to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(FacetError);
      const facetError = error as FacetError;
      expect(facetError.code).toBe("invalid_envelope");
      expect(facetError.retryable).toBe(true);
      expect(facetError.details).toEqual({
        reason: "connection_timeout",
        host: "http://127.0.0.1:1",
        timeoutMs: 10,
      });
    }
  });
});
