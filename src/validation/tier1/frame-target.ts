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
import { TSX_ARTIFACT_FRAME_ATTRIBUTE } from "../../shared/tsx/execution";

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

interface FrameTreeNode {
  readonly frame: { readonly id: string; readonly url: string };
  readonly childFrames?: readonly FrameTreeNode[];
}

interface ProtocolDomNode {
  readonly nodeName?: string;
  readonly backendNodeId?: number;
  readonly attributes?: readonly string[];
  readonly contentDocument?: ProtocolDomNode;
  readonly children?: readonly ProtocolDomNode[];
  readonly shadowRoots?: readonly ProtocolDomNode[];
}

function findFrameTreeNode(node: FrameTreeNode, frameId: string): FrameTreeNode | null {
  if (node.frame.id === frameId) return node;
  for (const child of node.childFrames ?? []) {
    const found = findFrameTreeNode(child, frameId);
    if (found !== null) return found;
  }
  return null;
}

function findContentDocument(node: ProtocolDomNode, backendNodeId: number): ProtocolDomNode | null {
  if (node.backendNodeId === backendNodeId) return node.contentDocument ?? null;
  for (const child of [
    node.contentDocument,
    ...(node.children ?? []),
    ...(node.shadowRoots ?? []),
  ]) {
    if (child === undefined) continue;
    const found = findContentDocument(child, backendNodeId);
    if (found !== null) return found;
  }
  return null;
}

function isMarkedArtifactFrame(node: ProtocolDomNode, backendNodeId: number): boolean {
  if (node.backendNodeId === backendNodeId) {
    const attributes = node.attributes ?? [];
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      if (attributes[index] === TSX_ARTIFACT_FRAME_ATTRIBUTE && attributes[index + 1] === "true") {
        return true;
      }
    }
    return false;
  }
  for (const child of [
    node.contentDocument,
    ...(node.children ?? []),
    ...(node.shadowRoots ?? []),
  ]) {
    if (child !== undefined && isMarkedArtifactFrame(child, backendNodeId)) return true;
  }
  return false;
}

/**
 * Resolve the renderer-owned nested TSX frame under the outer harness child.
 * Frame order and `about:srcdoc` URLs are non-authoritative: the backend node
 * ties each frame ID to its iframe element in the outer document.
 */
export async function resolveNestedArtifactFrame(
  session: VerifierCdpSession,
  outerFrame: ResolvedChildFrame,
): Promise<ResolvedChildFrame> {
  const tree = (await session.send("Page.getFrameTree")) as { readonly frameTree: FrameTreeNode };
  const outerNode = findFrameTreeNode(tree.frameTree, outerFrame.frameId);
  if (outerNode === null) {
    throw new Error("verifier: outer child frame disappeared before nested TSX resolution");
  }
  const candidates = outerNode.childFrames ?? [];
  const document = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as {
    readonly root: ProtocolDomNode;
  };
  const outerOwner = (await session.send("DOM.getFrameOwner", { frameId: outerFrame.frameId })) as {
    readonly backendNodeId: number;
  };
  const outerDocument = findContentDocument(document.root, outerOwner.backendNodeId);
  if (outerDocument === null) {
    throw new Error("verifier: outer child document unavailable for nested TSX resolution");
  }
  const owned: ResolvedChildFrame[] = [];
  for (const candidate of candidates) {
    const owner = (await session.send("DOM.getFrameOwner", { frameId: candidate.frame.id })) as {
      readonly backendNodeId: number;
    };
    if (!isMarkedArtifactFrame(outerDocument, owner.backendNodeId)) continue;
    owned.push({ frameId: candidate.frame.id, url: candidate.frame.url });
  }
  if (owned.length !== 1) {
    throw new Error(
      `verifier: expected one renderer-owned nested TSX frame, found ${owned.length}`,
    );
  }
  return owned[0]!;
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
