/**
 * Resolve the opaque-origin `about:srcdoc` child frame the verifier
 * probes. The parent page loads the host HTML which builds an iframe
 * with `srcdoc` (the harness). The verifier needs the child frame's
 * CDP frame ID to:
 *
 *   1. Create an isolated execution world BEFORE source ingress
 *      (so the page shim cannot reach it).
 *   2. Scope `DOMSnapshot.captureSnapshot` to that exact frame
 *      (so the protocol data is independent of the parent page world).
 *
 * The parent page world (the iframe HOST) is untrusted for the same
 * reason the page shim is — only the child frame's CDP-observed
 * counts are the authority.
 */

import type { VerifierCdpSession } from "./browser-process";

export interface ResolvedChildFrame {
  readonly frameId: string;
  readonly url: string;
}

/**
 * Walk `Page.getFrameTree` and return the first child frame whose
 * URL is `about:srcdoc` (or, when the harness loads via a `src=`
 * URL, `about:blank` is the initial state — the verifier accepts
 * either). Throws when no child frame matches — that is a
 * verifier-side setup failure (the harness page never built the
 * iframe), not a `tampered` verdict.
 */
export async function resolveSrcdocChildFrame(
  session: VerifierCdpSession,
): Promise<ResolvedChildFrame> {
  const tree = (await session.send("Page.getFrameTree")) as {
    frameTree: {
      frame: { id: string; url: string };
      childFrames?: { frame: { id: string; url: string } }[];
    };
  };
  const children = tree.frameTree.childFrames ?? [];
  for (const child of children) {
    const url = child.frame.url;
    if (url === "about:srcdoc" || url.startsWith("file://") || url === "about:blank") {
      return { frameId: child.frame.id, url };
    }
  }
  throw new Error("verifier: no about:srcdoc child frame resolved");
}

/**
 * Create an isolated execution world on the resolved child frame.
 * `grantUniveralAccess` is intentionally `false` — the isolated world
 * is sandboxed to the same origin as the child frame (opaque / about:
 * srcdoc), so it has no network or localStorage surface. The protocol
 * data returned by `Runtime.evaluate` calls inside this world is what
 * the verifier compares against the untrusted page shim.
 */
export async function createIsolatedWorld(
  session: VerifierCdpSession,
  frameId: string,
): Promise<{ readonly executionContextId: number }> {
  const result = (await session.send("Page.createIsolatedWorld", {
    frameId,
    worldName: "facet-tier1-probe",
    grantUniveralAccess: false,
  })) as { executionContextId: number };
  return { executionContextId: result.executionContextId };
}
