import { afterEach, describe, expect, test } from "bun:test";

import { FacetClient } from "../../src/cli/client";
import { errEnvelope } from "../../src/shared/contracts/envelope";
import { FacetError } from "../../src/shared/errors/facet-error";
import { generateRequestId } from "../../src/shared/util/time";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("FacetClient transport", () => {
  test("command POSTs use distinct loopback connections", async () => {
    const remotePorts: number[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, bunServer) {
        remotePorts.push(bunServer.requestIP(request)?.port ?? -1);
        const envelope = (await request.json()) as { requestId: string };
        return Response.json(
          errEnvelope(envelope.requestId, {
            code: "internal",
            message: "transport probe",
            retryable: false,
          }),
        );
      },
    });
    servers.push(server);
    const client = new FacetClient({
      baseUrl: `http://${server.hostname}:${server.port}`,
      installToken: "x".repeat(32),
    });

    await client.sendCommand({
      command: "list",
      requestId: generateRequestId(),
      projectId: "/facet",
    });
    await client.sendCommand({
      command: "list",
      requestId: generateRequestId(),
      projectId: "/facet",
    });

    expect(remotePorts).toHaveLength(2);
    expect(remotePorts[0]).not.toBe(-1);
    expect(remotePorts[1]).not.toBe(remotePorts[0]);
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
