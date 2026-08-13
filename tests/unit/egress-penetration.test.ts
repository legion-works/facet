import { describe, expect, test } from "bun:test";
import dgram from "node:dgram";

import {
  buildArtifact,
  buildTsxRuntimeEgressFixture,
  EGRESS_CHANNELS,
  hostAddress,
  startEgressSinkForTests,
} from "../../scripts/egress-penetration";

describe("egress penetration artifact", () => {
  test("contains every closed egress attempt in the generated browser artifact", () => {
    const html = buildArtifact("192.0.2.10", 4321);
    expect(html).toContain("http://192.0.2.10:4321");
    expect(html).toContain("ws://192.0.2.10:4321");
    for (const channel of EGRESS_CHANNELS) expect(html).toContain(`'${channel}'`);
    expect(html).toContain("document.title = attempted.join(',')");
  });

  test("injects the external sink only through the named TSX fixture placeholders", () => {
    const source = buildTsxRuntimeEgressFixture("192.0.2.10", 4321);

    expect(source).toContain('const target = "http://192.0.2.10:4321";');
    expect(source).toContain('const socket = "ws://192.0.2.10:4321";');
    expect(source).not.toContain("__FACET_EGRESS_ORIGIN__");
    expect(source).not.toContain("__FACET_EGRESS_SOCKET__");
  });

  test("records positive-control HTTP, WebSocket, and UDP egress", async () => {
    const sink = await startEgressSinkForTests();
    const udp = dgram.createSocket("udp4");
    try {
      await fetch(`http://127.0.0.1:${sink.port}/positive-control`);
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${sink.port}/ws`);
        socket.addEventListener("open", () => {
          socket.close();
          resolve();
        });
        socket.addEventListener("error", () =>
          reject(new Error("positive-control WebSocket failed")),
        );
      });
      await new Promise<void>((resolve, reject) => {
        udp.send("positive-control", sink.port, "127.0.0.1", (error) =>
          error === null ? resolve() : reject(error),
        );
      });
      await sink.udpPacketObserved;

      expect(sink.hits).toEqual(expect.arrayContaining(["GET /positive-control", "WS /ws"]));
      expect(sink.udpPackets()).toBeGreaterThanOrEqual(1);
    } finally {
      udp.close();
      await sink.close();
    }
  });

  test("uses a concrete host address for the external sink", () => {
    expect(hostAddress()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
