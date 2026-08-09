import { describe, expect, test } from "bun:test";

import {
  probeProtocolGetDocument,
  probeProtocolSnapshot,
} from "../../src/validation/tier1/protocol-probe";
import type { VerifierCdpSession } from "../../src/validation/tier1/browser-process";

const strings = [
  "child-frame",
  "#document",
  "svg",
  "data-facet-renderer-root",
  "true",
  "data-facet-renderer-graph",
  "viewBox",
  "0 0 100 100",
  "g",
  "class",
  "node",
  "canvas",
  "facet-error",
  "data-facet-error",
];

const snapshot = {
  documents: [
    {
      frameId: 0,
      nodes: {
        nodeName: [1, 2, 2, 8, 8, 11, 12],
        parentIndex: [-1, 0, 1, 1, 1, 1, 1],
        attributes: [[], [3, 4, 5, 4, 6, 7], [3, 4, 5, 4, 6, 7], [9, 10], [9, 10], [], [13, 4]],
      },
    },
  ],
  strings,
};

const document = {
  root: {
    nodeName: "#document",
    frameId: "parent-frame",
    children: [
      { nodeName: "CANVAS" },
      {
        nodeName: "IFRAME",
        backendNodeId: 41,
        contentDocument: {
          nodeName: "#document",
          children: [
            {
              nodeName: "SVG",
              attributes: [
                "data-facet-renderer-root",
                "true",
                "data-facet-renderer-graph",
                "true",
                "viewBox",
                "0 0 100 100",
              ],
              children: [
                {
                  nodeName: "SVG",
                  attributes: [
                    "data-facet-renderer-root",
                    "true",
                    "data-facet-renderer-graph",
                    "true",
                    "viewBox",
                    "0 0 100 100",
                  ],
                },
                { nodeName: "g", attributes: ["class", "node"] },
                { nodeName: "g", attributes: ["class", "node"] },
                { nodeName: "CANVAS" },
                { nodeName: "facet-error", attributes: ["data-facet-error", "true"] },
              ],
            },
          ],
        },
      },
    ],
  },
};

const childFrame = {
  frameId: "child-frame",
  url: "about:srcdoc",
} as const;

function session(): VerifierCdpSession {
  return {
    async send(method: string): Promise<never> {
      if (method === "DOMSnapshot.captureSnapshot") return snapshot as never;
      if (method === "DOM.getFrameOwner") return { backendNodeId: 41 } as never;
      if (method === "DOM.getDocument") return document as never;
      throw new Error(`unexpected CDP method: ${method}`);
    },
    async detach(): Promise<void> {},
  };
}

describe("protocol probes — renderer-owned observables", () => {
  test("DOMSnapshot primary and DOM.getDocument corroboration scope the canvas census to the child frame", async () => {
    const cdp = session();
    const fromSnapshot = await probeProtocolSnapshot(cdp, childFrame);
    const fromDocument = await probeProtocolGetDocument(cdp, childFrame);

    for (const observation of [fromSnapshot, fromDocument]) {
      expect(observation.rendererRootSvgCount).toBe(1);
      expect(observation.graphCount).toBe(1);
      expect(observation.mermaidNodeCount).toBe(2);
      expect(observation.visibleSvgCount).toBe(1);
      expect(observation.opaqueRegionCount).toBe(1);
      expect(observation.errorCount).toBe(1);
    }
  });
});
