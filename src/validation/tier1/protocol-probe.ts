/**
 * The protocol-authority probe.
 *
 * Every observation in this module is taken from the Chrome DevTools
 * Protocol — NOT from page-world JavaScript. Page-world JS can be
 * monkey-patched by a hostile artifact; the protocol data cannot.
 * Two channels are surfaced:
 *
 *   - `DOMSnapshot.captureSnapshot` — primary. Returns the document
 *     tree as a flat string-table-plus-nodes structure with
 *     `DocumentSnapshot.frameId` we cross-check against the resolved
 *     child frame id. Counts `svg`, `g.node`, `facet-error`, and
 *     captures viewBoxes for the layout-observability check.
 *
 *   - `DOM.getDocument({ depth: -1, pierce: true })` — corroboration.
 *     Walks the same DOM tree via a different protocol path so the
 *     counts from one channel can be cross-checked against the other.
 *     A divergence here is itself an anomaly; the verdict layer
 *     treats both as authority and the test layer asserts agreement.
 */

import type { ProtocolObservation } from "../../shared/contracts/validation";

import type { VerifierCdpSession } from "./browser-process";
import type { ResolvedChildFrame } from "./frame-target";

/** Raw shape of `DOMSnapshot.captureSnapshot` for one document. */
interface SnapshotDocument {
  readonly frameId: number;
  readonly nodes: {
    readonly nodeName: number[];
    /**
     * Per-node attribute payload. The wire format is a FLAT array of
     * alternating string-table indices — `[nameIdx, valueIdx, …]` —
     * not `{name, value}` pairs (verified against the pinned shell:
     * misparsing this shape silently zeroes every attribute-derived
     * count, which the verdict layer then reads as a channel
     * divergence → `tampered`).
     */
    readonly attributes?: readonly (readonly number[])[];
  };
}

interface SnapshotResponse {
  readonly documents: readonly SnapshotDocument[];
  readonly strings: readonly string[];
}

function readString(table: readonly string[], index: number): string {
  return table[index] ?? "";
}

function countByName(snapshot: SnapshotResponse, documentIndex: number, name: string): number {
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return 0;
  let count = 0;
  for (const nodeNameIndex of document.nodes.nodeName) {
    if (readString(snapshot.strings, nodeNameIndex).toLowerCase() === name) count += 1;
  }
  return count;
}

/** Iterate one node's attributes as decoded `[name, value]` pairs. */
function* attributePairs(
  snapshot: SnapshotResponse,
  attr: readonly number[],
): Generator<readonly [string, string]> {
  for (let i = 0; i + 1 < attr.length; i += 2) {
    yield [
      readString(snapshot.strings, attr[i] ?? 0),
      readString(snapshot.strings, attr[i + 1] ?? 0),
    ] as const;
  }
}

function countGNode(snapshot: SnapshotResponse, documentIndex: number): number {
  // Count `g.node` via the per-node attribute walk: DOMSnapshot exposes
  // attribute lists, so the protocol authority counts the SAME class
  // the isolated world counts. The all-`<g>` census was an
  // approximation from the stand-in-renderer era; with the real
  // mermaid renderer (which emits edgePath/edgeLabel groups) it would
  // diverge from the isolated-world `g.node` count and forge a
  // `tampered` verdict on honest renders.
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return 0;
  const attributes = document.nodes.attributes ?? [];
  let count = 0;
  for (let nodeIdx = 0; nodeIdx < document.nodes.nodeName.length; nodeIdx += 1) {
    const tag = readString(snapshot.strings, document.nodes.nodeName[nodeIdx] ?? 0).toLowerCase();
    if (tag !== "g") continue;
    const attr = attributes[nodeIdx];
    if (attr === undefined) continue;
    for (const [name, value] of attributePairs(snapshot, attr)) {
      if (name !== "class") continue;
      if (value.split(/\s+/).includes("node")) count += 1;
      break;
    }
  }
  return count;
}

function collectViewBoxes(snapshot: SnapshotResponse, documentIndex: number): string[] {
  // Only `<svg>` elements carry the layout signal: mermaid also puts
  // viewBox on `<marker>`/`<symbol>` defs, and counting those would
  // diverge from the isolated-world census (which reads viewBox off
  // svg roots only) and forge a `tampered` verdict on honest renders.
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return [];
  const result: string[] = [];
  const attributes = document.nodes.attributes ?? [];
  for (let nodeIdx = 0; nodeIdx < document.nodes.nodeName.length; nodeIdx += 1) {
    const tag = readString(snapshot.strings, document.nodes.nodeName[nodeIdx] ?? 0).toLowerCase();
    if (tag !== "svg") continue;
    const attr = attributes[nodeIdx];
    if (attr === undefined) continue;
    for (const [name, value] of attributePairs(snapshot, attr)) {
      if (name === "viewBox" && value.length > 0) result.push(value);
    }
  }
  return result;
}

function collectDiscriminativeErrors(
  snapshot: SnapshotResponse,
  documentIndex: number,
): readonly { code: string; message: string }[] {
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return [];
  const result: { code: string; message: string }[] = [];
  const attributes = document.nodes.attributes ?? [];
  let inFacetError = false;
  for (let i = 0; i < document.nodes.nodeName.length; i += 1) {
    const tag = readString(snapshot.strings, document.nodes.nodeName[i] ?? 0).toLowerCase();
    const attr = attributes[i];
    if (tag === "facet-error") {
      inFacetError = true;
      continue;
    }
    if (inFacetError) {
      inFacetError = false;
      if (attr === undefined) continue;
      for (const [name] of attributePairs(snapshot, attr)) {
        if (name === "data-facet-error") {
          result.push({ code: "facet_error", message: "facet-error element" });
          break;
        }
      }
    }
  }
  return result;
}

/**
 * Pick the document index whose `frameId` matches the resolved
 * child frame id. The snapshot string table maps frameId strings
 * to integer indices; the document's `frameId` field is the
 * INTEGER index into `strings`.
 */
function findDocumentIndex(snapshot: SnapshotResponse, childFrameId: string): number {
  for (let i = 0; i < snapshot.documents.length; i += 1) {
    const document = snapshot.documents[i];
    if (document === undefined) continue;
    const indexed = readString(snapshot.strings, document.frameId);
    if (indexed === childFrameId) return i;
  }
  return -1;
}

/**
 * Run `DOMSnapshot.captureSnapshot` scoped to the resolved child
 * frame and surface the canonical `ProtocolObservation`.
 */
export async function probeProtocolSnapshot(
  session: VerifierCdpSession,
  childFrame: ResolvedChildFrame,
): Promise<ProtocolObservation> {
  const snapshot = (await session.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [],
  })) as SnapshotResponse;
  const documentIndex = findDocumentIndex(snapshot, childFrame.frameId);
  if (documentIndex < 0) {
    return {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      viewBoxes: [],
      errorCount: 0,
      opaqueRegionCount: 0,
      discriminativeErrors: [],
    };
  }
  const svgCount = countByName(snapshot, documentIndex, "svg");
  const errorCount = countByName(snapshot, documentIndex, "facet-error");
  // graphCount equals renderer-owned SVG count: each rendered mermaid
  // block produces exactly one top-level SVG, regardless of how many
  // `g.node` children it carries (a parsed-but-empty block is still a
  // graph for the protocol authority).
  const graphCount = svgCount;
  const viewBoxes = collectViewBoxes(snapshot, documentIndex);
  const discriminativeErrors = collectDiscriminativeErrors(snapshot, documentIndex);
  // visibleSvgCount falls back to rendererRootSvgCount when DOMSnapshot
  // attributes are not surfaced (older pinned shells sometimes return
  // empty attribute arrays). Layout observability is then decided by
  // the viewBoxes list — a renderer that produced SVGs with no
  // reported viewBoxes still earns `partial:layout_unverified` until
  // an explicit non-degenerate viewBox is observed.
  const visibleSvgCount = viewBoxes.length > 0 ? viewBoxes.length : svgCount;
  return {
    rendererRootSvgCount: svgCount,
    graphCount,
    mermaidNodeCount: countGNode(snapshot, documentIndex),
    visibleSvgCount,
    opaqueRegionCount: 0,
    viewBoxes,
    errorCount,
    discriminativeErrors: discriminativeErrors.map((entry) => ({
      code: entry.code,
      message: entry.message,
    })),
  };
}

/**
 * Run `DOM.getDocument({ depth: -1, pierce: true })` as a
 * corroborating channel. Returns the same canonical shape so the
 * verdict layer can either-or both channels and any divergence
 * surfaces as `tampered`.
 */
export async function probeProtocolGetDocument(
  session: VerifierCdpSession,
): Promise<ProtocolObservation> {
  const result = (await session.send("DOM.getDocument", {
    depth: -1,
    pierce: true,
  })) as {
    root: {
      nodeName: string;
      contentDocument?: { nodeName: string; children?: unknown[] };
      children?: unknown[];
      shadowRoots?: unknown[];
    };
  };
  let svgCount = 0;
  let errorCount = 0;
  let gNodeCount = 0;
  const viewBoxes: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as {
      nodeName?: string;
      // DOM.Node attributes arrive as a FLAT string array
      // [name1, value1, name2, value2, …] — not {name, value} objects.
      attributes?: string[];
      contentDocument?: unknown;
      children?: unknown[];
      shadowRoots?: unknown[];
    };
    const findAttr = (wanted: string): string | undefined => {
      const attrs = record.attributes;
      if (!Array.isArray(attrs)) return undefined;
      for (let i = 0; i + 1 < attrs.length; i += 2) {
        if (attrs[i] === wanted) return attrs[i + 1];
      }
      return undefined;
    };
    const name = (record.nodeName ?? "").toLowerCase();
    if (name === "svg") svgCount += 1;
    if (name === "facet-error") errorCount += 1;
    if (name === "g") {
      // Class-aware g.node census — the same definition the isolated
      // world and DOMSnapshot channels use.
      const classAttr = findAttr("class");
      if (classAttr !== undefined && classAttr.split(/\s+/).includes("node")) gNodeCount += 1;
    }
    if (name === "svg") {
      const vb = findAttr("viewBox");
      if (vb !== undefined) viewBoxes.push(vb);
    }
    if (record.contentDocument !== undefined) visit(record.contentDocument);
    if (record.children !== undefined) for (const child of record.children) visit(child);
    if (record.shadowRoots !== undefined) for (const shadow of record.shadowRoots) visit(shadow);
  };
  visit(result.root);
  return {
    rendererRootSvgCount: svgCount,
    graphCount: svgCount,
    mermaidNodeCount: gNodeCount,
    visibleSvgCount: viewBoxes.length,
    opaqueRegionCount: 0,
    viewBoxes,
    errorCount,
    discriminativeErrors:
      errorCount > 0 ? [{ code: "facet_error", message: "DOM.getDocument" }] : [],
  };
}
