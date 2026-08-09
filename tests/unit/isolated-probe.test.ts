import { describe, expect, test } from "bun:test";

import {
  LexicalCountersSchema,
  type ProtocolObservation,
} from "../../src/shared/contracts/validation";
import type { VerifierCdpSession } from "../../src/validation/tier1/browser-process";
import { probeIsolatedCounts } from "../../src/validation/tier1/isolated-probe";
import { deriveVerdict, type PageShim } from "../../src/validation/tier1/verdict";

const protocol: ProtocolObservation = {
  rendererRootSvgCount: 1,
  graphCount: 1,
  mermaidNodeCount: 1,
  visibleSvgCount: 1,
  opaqueRegionCount: 0,
  viewBoxes: ["0 0 100 100"],
  errorCount: 0,
  discriminativeErrors: [],
};

const shim: PageShim = {
  rendererRootSvgCount: 1,
  graphCount: 1,
  mermaidNodeCount: 1,
  visibleSvgCount: 1,
  opaqueRegionCount: 0,
  errorCount: 0,
};

const session: VerifierCdpSession = {
  async send(): Promise<never> {
    return { result: { exceptionDetails: { text: "evaluation failed" } } } as never;
  },
  async detach(): Promise<void> {},
};

describe("isolated probe failure", () => {
  test("Runtime.evaluate exceptionDetails yields null and a shim_only verdict", async () => {
    const isolated = await probeIsolatedCounts(session, 7);

    let status: string | undefined;
    expect(() => {
      status = deriveVerdict(
        LexicalCountersSchema.parse({
          rendererRootSvgCount: 1,
          mermaidNodeCount: 1,
          visibleSvgCount: 1,
          opaqueRegionCount: 0,
        }),
        protocol,
        isolated,
        shim,
        { bootReady: true, renderComplete: true },
      );
    }).not.toThrow();
    expect(isolated).toBeNull();
    expect(status).toBe("shim_only");
  });
});
