import { describe, expect, test } from "bun:test";

import {
  probeProtocolGetDocument,
  probeProtocolSnapshot,
} from "../../src/validation/tier1/protocol-probe";
import type { VerifierCdpSession } from "../../src/validation/tier1/browser-process";

const strings = [
  "child-frame",
  "#document",
  "div",
  "data-facet-renderer-root",
  "true",
  "h1",
  "table",
  "ul",
  "img",
  "src",
  "https://example.test/a.png",
  "canvas",
];

const snapshot = {
  documents: [
    {
      frameId: 0,
      nodes: {
        nodeName: [1, 2, 5, 6, 7, 8, 11, 2, 5, 5],
        parentIndex: [-1, 0, 1, 1, 1, 1, 1, 1, 7, 0],
        attributes: [[], [3, 4], [], [], [], [9, 10], [], [3, 4], [], []],
      },
    },
  ],
  strings,
};

const document = {
  root: {
    nodeName: "#document",
    children: [
      { nodeName: "H1" },
      { nodeName: "CANVAS" },
      { nodeName: "DIV", attributes: ["data-facet-renderer-root", "true"] },
      {
        nodeName: "IFRAME",
        backendNodeId: 41,
        contentDocument: {
          nodeName: "#document",
          children: [
            {
              nodeName: "DIV",
              attributes: ["data-facet-renderer-root", "true"],
              children: [
                { nodeName: "H1" },
                { nodeName: "TABLE" },
                { nodeName: "UL" },
                { nodeName: "IMG", attributes: ["src", "https://example.test/a.png"] },
                { nodeName: "CANVAS" },
                {
                  nodeName: "DIV",
                  attributes: ["data-facet-renderer-root", "true"],
                  children: [{ nodeName: "H2" }],
                },
              ],
            },
            { nodeName: "H3" },
          ],
        },
      },
    ],
  },
};

const childFrame = { frameId: "child-frame", url: "about:srcdoc" } as const;

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

describe("protocol probes — html marker scoping", () => {
  test("html counts use the child-frame outermost owned wrapper and ignore parent decoys", async () => {
    const cdp = session();
    const fromSnapshot = await probeProtocolSnapshot(cdp, childFrame);
    const fromDocument = await probeProtocolGetDocument(cdp, childFrame);

    const expected = {
      rendererRootCount: 1,
      headingCount: 2,
      tableCount: 1,
      listCount: 1,
      imageCount: 1,
      canvasCount: 1,
      externalImageCount: 1,
    };
    expect(fromSnapshot.html).toEqual(expected);
    expect(fromDocument.html).toEqual(expected);
  });

  test("artifact fake marker remains a descendant rather than a second root", async () => {
    const observation = await probeProtocolGetDocument(session(), childFrame);
    expect(observation.html?.rendererRootCount).toBe(1);
    expect(observation.html?.headingCount).toBe(2);
  });
});

test("HTML marker nested under an SVG marker is not an outermost HTML root in either protocol channel", async () => {
  const nestedSnapshot = {
    documents: [
      {
        frameId: 0,
        nodes: {
          nodeName: [1, 12, 2, 5],
          parentIndex: [-1, 0, 1, 2],
          attributes: [[], [3, 4], [3, 4], []],
        },
      },
    ],
    strings: [...strings, "svg"],
  };
  const nestedDocument = {
    root: {
      nodeName: "#document",
      children: [
        {
          nodeName: "IFRAME",
          backendNodeId: 41,
          contentDocument: {
            nodeName: "#document",
            children: [
              {
                nodeName: "SVG",
                attributes: ["data-facet-renderer-root", "true"],
                children: [
                  {
                    nodeName: "DIV",
                    attributes: ["data-facet-renderer-root", "true"],
                    children: [{ nodeName: "H1" }],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  };
  const cdp: VerifierCdpSession = {
    async send(method: string): Promise<never> {
      if (method === "DOMSnapshot.captureSnapshot") return nestedSnapshot as never;
      if (method === "DOM.getFrameOwner") return { backendNodeId: 41 } as never;
      if (method === "DOM.getDocument") return nestedDocument as never;
      throw new Error(`unexpected CDP method: ${method}`);
    },
    async detach(): Promise<void> {},
  };

  expect((await probeProtocolSnapshot(cdp, childFrame)).html).toBeUndefined();
  expect((await probeProtocolGetDocument(cdp, childFrame)).html).toBeUndefined();
});
