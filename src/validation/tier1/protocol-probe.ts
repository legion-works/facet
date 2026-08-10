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
 *     Walks the same resolved child-frame document via a different protocol path so the
 *     counts from one channel can be cross-checked against the other.
 *     A divergence here is itself an anomaly; the verdict layer
 *     treats both as authority and the test layer asserts agreement.
 */

import type { HtmlStructureCounts, ProtocolObservation } from "../../shared/contracts/validation";
import { HTML_STRUCTURAL_GROUPS } from "../../shared/html/policy";

import type { VerifierCdpSession } from "./browser-process";
import type { ResolvedChildFrame } from "./frame-target";

/** Raw shape of `DOMSnapshot.captureSnapshot` for one document. */
interface SnapshotDocument {
  readonly frameId: number;
  readonly nodes: {
    readonly nodeName: number[];
    /** Parent node index for every entry in nodeName. */
    readonly parentIndex: readonly number[];
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

interface ProtocolDomNode {
  readonly backendNodeId?: number;
  readonly contentDocument?: unknown;
  readonly children?: unknown[];
  readonly shadowRoots?: unknown[];
  readonly shadowRootType?: string;
}

function findFrameDocument(node: unknown, ownerBackendNodeId: number): unknown | null {
  if (node === null || typeof node !== "object") return null;
  const record = node as ProtocolDomNode;
  if (record.backendNodeId === ownerBackendNodeId) return record.contentDocument ?? null;
  const nested = [
    record.contentDocument,
    ...(record.children ?? []),
    ...(record.shadowRoots ?? []),
  ];
  for (const candidate of nested) {
    const document = findFrameDocument(candidate, ownerBackendNodeId);
    if (document !== null) return document;
  }
  return null;
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

function attributeValue(
  snapshot: SnapshotResponse,
  document: SnapshotDocument,
  nodeIndex: number,
  wanted: string,
): string | undefined {
  const attr = document.nodes.attributes?.[nodeIndex];
  if (attr === undefined) return undefined;
  for (const [name, value] of attributePairs(snapshot, attr)) {
    if (name.toLowerCase() === wanted.toLowerCase()) return value;
  }
  return undefined;
}

function isMarkedRoot(
  snapshot: SnapshotResponse,
  document: SnapshotDocument,
  nodeIndex: number,
): boolean {
  return attributeValue(snapshot, document, nodeIndex, "data-facet-renderer-root") === "true";
}

function isRendererRoot(
  snapshot: SnapshotResponse,
  document: SnapshotDocument,
  nodeIndex: number,
): boolean {
  const name = readString(snapshot.strings, document.nodes.nodeName[nodeIndex] ?? 0).toLowerCase();
  return name === "svg" && isMarkedRoot(snapshot, document, nodeIndex);
}

function hasAncestorIn(
  document: SnapshotDocument,
  nodeIndex: number,
  ancestors: ReadonlySet<number>,
): boolean {
  const seen = new Set<number>();
  let parentIndex = document.nodes.parentIndex[nodeIndex] ?? -1;
  while (parentIndex >= 0 && !seen.has(parentIndex)) {
    if (ancestors.has(parentIndex)) return true;
    seen.add(parentIndex);
    parentIndex = document.nodes.parentIndex[parentIndex] ?? -1;
  }
  return false;
}

function htmlRootIndexes(snapshot: SnapshotResponse, documentIndex: number): number[] {
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return [];
  const candidates = new Set<number>();
  for (let nodeIndex = 0; nodeIndex < document.nodes.nodeName.length; nodeIndex += 1) {
    if (isMarkedRoot(snapshot, document, nodeIndex)) candidates.add(nodeIndex);
  }
  return [...candidates].filter((nodeIndex) => {
    const name = readString(
      snapshot.strings,
      document.nodes.nodeName[nodeIndex] ?? 0,
    ).toLowerCase();
    return name !== "svg" && !hasAncestorIn(document, nodeIndex, candidates);
  });
}

function isDescendantOf(
  document: SnapshotDocument,
  nodeIndex: number,
  roots: ReadonlySet<number>,
): boolean {
  let parent = document.nodes.parentIndex[nodeIndex] ?? -1;
  while (parent >= 0) {
    if (roots.has(parent)) return true;
    parent = document.nodes.parentIndex[parent] ?? -1;
  }
  return false;
}

function isExternalHttps(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function countSnapshotHtml(
  snapshot: SnapshotResponse,
  documentIndex: number,
): HtmlStructureCounts | undefined {
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return undefined;
  const roots = htmlRootIndexes(snapshot, documentIndex);
  if (roots.length === 0) return undefined;
  const rootSet = new Set(roots);
  const counts = {
    rendererRootCount: roots.length,
    headingCount: 0,
    tableCount: 0,
    listCount: 0,
    imageCount: 0,
    canvasCount: 0,
    externalImageCount: 0,
  };
  for (let nodeIndex = 0; nodeIndex < document.nodes.nodeName.length; nodeIndex += 1) {
    if (!isDescendantOf(document, nodeIndex, rootSet)) continue;
    const name = readString(
      snapshot.strings,
      document.nodes.nodeName[nodeIndex] ?? 0,
    ).toLowerCase();
    if ((HTML_STRUCTURAL_GROUPS.headings as readonly string[]).includes(name))
      counts.headingCount += 1;
    if ((HTML_STRUCTURAL_GROUPS.tables as readonly string[]).includes(name)) counts.tableCount += 1;
    if ((HTML_STRUCTURAL_GROUPS.lists as readonly string[]).includes(name)) counts.listCount += 1;
    if ((HTML_STRUCTURAL_GROUPS.images as readonly string[]).includes(name)) {
      counts.imageCount += 1;
      if (isExternalHttps(attributeValue(snapshot, document, nodeIndex, "src"))) {
        counts.externalImageCount += 1;
      }
    }
    if ((HTML_STRUCTURAL_GROUPS.canvases as readonly string[]).includes(name))
      counts.canvasCount += 1;
  }
  return counts;
}

function rendererRootIndexes(snapshot: SnapshotResponse, documentIndex: number): number[] {
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return [];
  const candidates = new Set<number>();
  for (let nodeIdx = 0; nodeIdx < document.nodes.nodeName.length; nodeIdx += 1) {
    if (isRendererRoot(snapshot, document, nodeIdx)) candidates.add(nodeIdx);
  }
  return [...candidates].filter((nodeIdx) => !hasAncestorIn(document, nodeIdx, candidates));
}

function graphRootIndexes(
  snapshot: SnapshotResponse,
  documentIndex: number,
  rendererRoots: readonly number[],
): number[] {
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return [];
  return rendererRoots.filter(
    (nodeIdx) =>
      attributeValue(snapshot, document, nodeIdx, "data-facet-renderer-graph") === "true",
  );
}

function countGNode(
  snapshot: SnapshotResponse,
  documentIndex: number,
  graphRoots: readonly number[],
): number {
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return 0;
  const graphRootSet = new Set(graphRoots);
  let count = 0;
  for (let nodeIdx = 0; nodeIdx < document.nodes.nodeName.length; nodeIdx += 1) {
    const tag = readString(snapshot.strings, document.nodes.nodeName[nodeIdx] ?? 0).toLowerCase();
    if (tag !== "g" || !hasAncestorIn(document, nodeIdx, graphRootSet)) continue;
    if (attributeValue(snapshot, document, nodeIdx, "class")?.split(/\s+/).includes("node"))
      count += 1;
  }
  return count;
}

function isNonDegenerateViewBox(viewBox: string): boolean {
  const parts = viewBox
    .trim()
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part));
  if (parts.length !== 4) return false;
  const [, , width, height] = parts as [number, number, number, number];
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

function collectViewBoxes(
  snapshot: SnapshotResponse,
  documentIndex: number,
  rendererRoots: readonly number[],
): string[] {
  const document = snapshot.documents[documentIndex];
  if (document === undefined) return [];
  const result: string[] = [];
  for (const nodeIdx of rendererRoots) {
    const viewBox = attributeValue(snapshot, document, nodeIdx, "viewbox");
    if (viewBox !== undefined && viewBox.length > 0) result.push(viewBox);
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
  for (let i = 0; i < document.nodes.nodeName.length; i += 1) {
    if (attributeValue(snapshot, document, i, "data-facet-error") !== undefined) {
      result.push({ code: "facet_error", message: "facet-error element" });
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
  const rendererRoots = rendererRootIndexes(snapshot, documentIndex);
  const graphRoots = graphRootIndexes(snapshot, documentIndex, rendererRoots);
  const viewBoxes = collectViewBoxes(snapshot, documentIndex, rendererRoots);
  const discriminativeErrors = collectDiscriminativeErrors(snapshot, documentIndex);
  const errorCount = discriminativeErrors.length;
  return {
    rendererRootSvgCount: rendererRoots.length,
    graphCount: graphRoots.length,
    mermaidNodeCount: countGNode(snapshot, documentIndex, graphRoots),
    visibleSvgCount: viewBoxes.filter(isNonDegenerateViewBox).length,
    opaqueRegionCount: countByName(snapshot, documentIndex, "canvas"),
    ...(countSnapshotHtml(snapshot, documentIndex) === undefined
      ? {}
      : { html: countSnapshotHtml(snapshot, documentIndex) }),
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
  childFrame: ResolvedChildFrame,
): Promise<ProtocolObservation> {
  const result = (await session.send("DOM.getDocument", {
    depth: -1,
    pierce: true,
  })) as {
    root: {
      nodeName: string;
      backendNodeId?: number;
      contentDocument?: { nodeName: string; children?: unknown[] };
      children?: unknown[];
      shadowRoots?: unknown[];
      shadowRootType?: string;
    };
  };
  const owner = (await session.send("DOM.getFrameOwner", {
    frameId: childFrame.frameId,
  })) as { backendNodeId: number };
  let rendererRootSvgCount = 0;
  let graphCount = 0;
  let errorCount = 0;
  let gNodeCount = 0;
  let opaqueRegionCount = 0;
  let visibleSvgCount = 0;
  let html: HtmlStructureCounts | undefined;
  const viewBoxes: string[] = [];
  const visit = (
    node: unknown,
    withinRendererRoot = false,
    withinGraphRoot = false,
    withinHtmlRoot = false,
    withinMarkedRoot = false,
  ): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as {
      nodeName?: string;
      // DOM.Node attributes arrive as a FLAT string array
      // [name1, value1, name2, value2, …] — not {name, value} objects.
      attributes?: string[];
      contentDocument?: unknown;
      children?: unknown[];
      shadowRoots?: unknown[];
      shadowRootType?: string;
    };
    const findAttr = (wanted: string): string | undefined => {
      const attrs = record.attributes;
      if (!Array.isArray(attrs)) return undefined;
      for (let i = 0; i + 1 < attrs.length; i += 2) {
        if (attrs[i]?.toLowerCase() === wanted.toLowerCase()) return attrs[i + 1];
      }
      return undefined;
    };
    const name = (record.nodeName ?? "").toLowerCase();
    const markedRoot = findAttr("data-facet-renderer-root") === "true";
    const rendererRoot = name === "svg" && markedRoot && !withinRendererRoot;
    const htmlRoot = name !== "svg" && markedRoot && !withinMarkedRoot;
    const graphRoot = rendererRoot && findAttr("data-facet-renderer-graph") === "true";
    if (htmlRoot) {
      html ??= {
        rendererRootCount: 0,
        headingCount: 0,
        tableCount: 0,
        listCount: 0,
        imageCount: 0,
        canvasCount: 0,
        externalImageCount: 0,
      };
      html.rendererRootCount += 1;
    }
    if (rendererRoot) {
      rendererRootSvgCount += 1;
      const vb = findAttr("viewBox");
      if (vb !== undefined) {
        viewBoxes.push(vb);
        if (isNonDegenerateViewBox(vb)) visibleSvgCount += 1;
      }
    }
    if (graphRoot) graphCount += 1;
    if (name === "g" && withinGraphRoot && findAttr("class")?.split(/\s+/).includes("node")) {
      gNodeCount += 1;
    }
    // Renderer markers scope SVG counts, but the canvas census deliberately
    // covers the entire child-frame document so smuggled canvases stay visible.
    // getContext() would create a context and make the observation self-fulfilling.
    if (name === "canvas") opaqueRegionCount += 1;
    if (withinHtmlRoot && html !== undefined) {
      if ((HTML_STRUCTURAL_GROUPS.headings as readonly string[]).includes(name))
        html.headingCount += 1;
      if ((HTML_STRUCTURAL_GROUPS.tables as readonly string[]).includes(name)) html.tableCount += 1;
      if ((HTML_STRUCTURAL_GROUPS.lists as readonly string[]).includes(name)) html.listCount += 1;
      if ((HTML_STRUCTURAL_GROUPS.images as readonly string[]).includes(name)) {
        html.imageCount += 1;
        if (isExternalHttps(findAttr("src"))) html.externalImageCount += 1;
      }
      if ((HTML_STRUCTURAL_GROUPS.canvases as readonly string[]).includes(name))
        html.canvasCount += 1;
    }
    if (findAttr("data-facet-error") !== undefined) errorCount += 1;
    const nextWithinRendererRoot = withinRendererRoot || rendererRoot;
    const nextWithinGraphRoot = withinGraphRoot || graphRoot;
    const nextWithinHtmlRoot = withinHtmlRoot || htmlRoot;
    const nextWithinMarkedRoot = withinMarkedRoot || markedRoot;
    if (record.children !== undefined)
      for (const child of record.children)
        visit(
          child,
          nextWithinRendererRoot,
          nextWithinGraphRoot,
          nextWithinHtmlRoot,
          nextWithinMarkedRoot,
        );
    if (record.shadowRoots !== undefined)
      for (const shadow of record.shadowRoots) {
        const shadowRecord = shadow as ProtocolDomNode;
        if (shadowRecord.shadowRootType === "user-agent") continue;
        visit(
          shadow,
          nextWithinRendererRoot,
          nextWithinGraphRoot,
          nextWithinHtmlRoot,
          nextWithinMarkedRoot,
        );
      }
  };
  const frameDocument = findFrameDocument(result.root, owner.backendNodeId);
  if (frameDocument !== null) visit(frameDocument);
  return {
    rendererRootSvgCount,
    graphCount,
    mermaidNodeCount: gNodeCount,
    visibleSvgCount,
    opaqueRegionCount,
    ...(html === undefined ? {} : { html }),
    viewBoxes,
    errorCount,
    discriminativeErrors:
      errorCount > 0 ? [{ code: "facet_error", message: "DOM.getDocument" }] : [],
  };
}
