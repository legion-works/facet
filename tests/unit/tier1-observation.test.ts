import { expect, test } from "bun:test";

import type { ProtocolObservation } from "../../src/shared/contracts/validation";
import type { VerifierCdpSession } from "../../src/validation/tier1/browser-process";
import {
  RuntimeExceptionCollector,
  observationsDiverge,
  type ArtifactObservation,
} from "../../src/validation/tier1/runner";
import { deriveVerdict } from "../../src/validation/tier1/verdict";

const observation = (overrides: Partial<ProtocolObservation> = {}): ProtocolObservation => ({
  rendererRootSvgCount: 0,
  graphCount: 0,
  mermaidNodeCount: 0,
  visibleSvgCount: 0,
  viewBoxes: [],
  errorCount: 0,
  opaqueRegionCount: 0,
  externalImageCount: 0,
  discriminativeErrors: [],
  ...overrides,
});

test.each([
  [
    "protocol",
    observation({
      discriminativeErrors: [{ code: "protocol_divergence", message: "first observation lied" }],
    }),
    observation(),
  ],
  ["isolated", observation(), observation({ rendererRootSvgCount: 1 })],
] as const)(
  "first interactive %s divergence remains tampered after the second observation settles",
  (_, firstProtocol, firstIsolated) => {
    const settled = observation();
    const first: ArtifactObservation = { protocol: firstProtocol, isolated: firstIsolated };
    const second: ArtifactObservation = { protocol: settled, isolated: settled };
    const firstDiverged = observationsDiverge(first, second);

    expect(firstDiverged).toBe(true);
    expect(
      deriveVerdict(
        {
          rendererRootSvgCount: 0,
          mermaidNodeCount: 0,
          visibleSvgCount: 0,
          opaqueRegionCount: 0,
          externalImageCount: 0,
        },
        settled,
        settled,
        null,
        {
          bootReady: true,
          renderComplete: true,
          interactive: true,
          channelDivergence: firstDiverged,
          structureChanged: true,
        },
      ),
    ).toBe("tampered");
  },
);

test("runtime exceptions are scoped to the nested artifact frame", () => {
  const listeners = new Map<string, (params: unknown) => void>();
  const session: VerifierCdpSession = {
    async send(): Promise<never> {
      throw new Error("unused");
    },
    on(event, listener): void {
      listeners.set(event, listener);
    },
    off(event): void {
      listeners.delete(event);
    },
    async detach(): Promise<void> {},
  };
  const collector = new RuntimeExceptionCollector(session);
  listeners.get("Runtime.executionContextCreated")?.({
    context: { id: 1, auxData: { frameId: "outer" } },
  });
  listeners.get("Runtime.executionContextCreated")?.({
    context: { id: 2, auxData: { frameId: "nested-artifact" } },
  });
  listeners.get("Runtime.exceptionThrown")?.({
    exceptionDetails: { executionContextId: 1, text: "Uncaught Error: outer frame failure" },
  });
  listeners.get("Runtime.exceptionThrown")?.({
    exceptionDetails: { executionContextId: 2, text: "Uncaught Error: nested failure" },
  });

  expect(collector.errorsForFrame("outer")).toEqual([
    { code: "runtime_exception", message: "Uncaught Error: outer frame failure" },
  ]);
  expect(collector.errorsForFrame("nested-artifact")).toEqual([
    { code: "runtime_exception", message: "Uncaught Error: nested failure" },
  ]);
  collector.close();
  expect(listeners).toEqual(new Map());
});
