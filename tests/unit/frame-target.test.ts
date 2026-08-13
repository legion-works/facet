import { expect, test } from "bun:test";

import type { VerifierCdpSession } from "../../src/validation/tier1/browser-process";
import {
  resolveNestedArtifactFrame,
  type ResolvedChildFrame,
} from "../../src/validation/tier1/frame-target";

const outerFrame: ResolvedChildFrame = { frameId: "outer", url: "about:srcdoc" };

test("nested owner selection ignores host decoys and selects the renderer-owned sibling", async () => {
  const owners: Record<string, number> = {
    outer: 10,
    decoy: 20,
    artifact: 30,
  };
  const session: VerifierCdpSession = {
    async send(method: string, params?: Record<string, unknown>): Promise<never> {
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "host", url: "file:///host.html" },
            childFrames: [
              {
                frame: { id: "outer", url: "about:srcdoc" },
                childFrames: [
                  { frame: { id: "decoy", url: "about:srcdoc" } },
                  { frame: { id: "artifact", url: "about:srcdoc" } },
                ],
              },
            ],
          },
        } as never;
      }
      if (method === "DOM.getFrameOwner") {
        const frameId = String(params?.frameId);
        return { backendNodeId: owners[frameId]! } as never;
      }
      if (method === "DOM.getDocument") {
        return {
          root: {
            nodeName: "#document",
            children: [
              {
                nodeName: "IFRAME",
                backendNodeId: 99,
                attributes: ["data-facet-tsx-frame", "true"],
              },
              {
                nodeName: "IFRAME",
                backendNodeId: 10,
                contentDocument: {
                  nodeName: "#document",
                  children: [
                    {
                      nodeName: "IFRAME",
                      backendNodeId: 20,
                      attributes: ["data-facet-tsx-frame", "false"],
                    },
                    {
                      nodeName: "IFRAME",
                      backendNodeId: 30,
                      attributes: ["data-facet-tsx-frame", "true"],
                    },
                  ],
                },
              },
            ],
          },
        } as never;
      }
      throw new Error(`unexpected CDP method: ${method}`);
    },
    async detach(): Promise<void> {},
    on(): void {},
    off(): void {},
  };

  await expect(resolveNestedArtifactFrame(session, outerFrame)).resolves.toEqual({
    frameId: "artifact",
    url: "about:srcdoc",
  });
});
