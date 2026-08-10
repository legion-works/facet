import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

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

const failureSession: VerifierCdpSession = {
  async send(): Promise<never> {
    return { result: { exceptionDetails: { text: "evaluation failed" } } } as never;
  },
  async detach(): Promise<void> {},
};

describe("isolated probe failure", () => {
  test("Runtime.evaluate exceptionDetails yields null and a shim_only verdict", async () => {
    const isolated = await probeIsolatedCounts(failureSession, 7);
    expect(
      deriveVerdict(
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
      ),
    ).toBe("shim_only");
    expect(isolated).toBeNull();
  });
});

describe("isolated probe — html marker scoping", () => {
  test("counts only descendants of the outermost owned wrapper", async () => {
    const { document } = parseHTML(`
      <h1>outside</h1>
      <div data-facet-renderer-root="true">
        <h1>inside</h1><table></table><ol><li>x</li></ol>
        <img src="https://example.test/x.png"><canvas></canvas>
        <div data-facet-renderer-root="true"><h2>nested</h2></div>
      </div>
    `);
    const session: VerifierCdpSession = {
      async send(_method: string, params?: Record<string, unknown>): Promise<never> {
        const expression = String(params?.expression ?? "");
        const value = Function("document", `return ${expression}`)(document);
        return { result: { value } } as never;
      },
      async detach(): Promise<void> {},
    };

    const observed = await probeIsolatedCounts(session, 7);
    expect(observed?.html).toEqual({
      rendererRootCount: 1,
      headingCount: 2,
      tableCount: 1,
      listCount: 1,
      imageCount: 1,
      canvasCount: 1,
      externalImageCount: 1,
    });
  });
});
