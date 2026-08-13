import { expect, test } from "bun:test";

import type { ProtocolObservation } from "../../src/shared/contracts/validation";
import { observationsDiverge, type ArtifactObservation } from "../../src/validation/tier1/runner";
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
