/**
 * SVG renderer + the ONE canonical sanitized-SVG import path.
 *
 * Mermaid and chart renderers produce SVG text and import it through
 * `importSanitizedSvgText` here — a single choke point that parses the
 * SVG as DATA, strips executable/hostile surface, and only then moves
 * nodes into the live document. The CSP is the backstop; this strip
 * pass is the front gate.
 *
 * Strip set (BEFORE import, never sanitize-after-insert):
 *   - script-bearing / document-bearing elements: script, foreignObject
 *     (nested HTML document), use/image (reference fetchers), SMIL
 *     animation elements (attribute-mutation vectors incl. `to=javascript:`),
 *     and embedded media/iframe/object/embed.
 *   - every `on*` event-handler attribute.
 *   - URL-bearing attributes (href/xlink:href/src): only fragment
 *     references (`#...`) survive; external schemes (http, data, blob,
 *     javascript, …) are removed.
 *
 * The frame CSP (`connect-src 'none'`, `script-src 'nonce-…'`) blocks
 * anything that slipped the strip; the strip exists so the DOM the
 * verifier probes never carries attack surface at all.
 */

import { FacetRenderError, type RenderContext, decodeArtifactBytes } from "./registry";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Element local names removed wholesale before import. */
const STRIPPED_TAGS = new Set([
  "script",
  "foreignobject",
  "use",
  "image",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
  "audio",
  "video",
  "iframe",
  "object",
  "embed",
]);

/** Attributes carrying URLs: only fragment references survive. */
const URL_ATTRS = ["href", "xlink:href", "src"];

const EVENT_HANDLER_RE = /^on[a-z]+$/i;

/**
 * Walk a parsed SVG document and strip hostile surface IN PLACE.
 * Matching is by local tag name (lower-cased) so the walk holds under
 * any namespace the parser assigned; foreignObject — the nested-document
 * vector — is removed wholesale regardless of what it contains.
 */
export function sanitizeSvgDocument(doc: Document): void {
  const all = Array.from(doc.querySelectorAll("*"));
  for (const el of all) {
    if (STRIPPED_TAGS.has(el.localName.toLowerCase())) {
      el.parentNode?.removeChild(el);
      continue;
    }
    for (const attr of Array.from(el.attributes ?? [])) {
      const name = attr.name.toLowerCase();
      if (EVENT_HANDLER_RE.test(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.includes(name) && !attr.value.trim().startsWith("#")) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

/**
 * Parse SVG text as DATA. Throws FacetRenderError on malformed XML or
 * a non-`<svg>` root (a hostile XML payload that happens to parse is
 * not an SVG artifact).
 */
export function parseSvgData(svgText: string): Document {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new FacetRenderError("SVG source is not well-formed XML", "svg_malformed");
  }
  const root = doc.documentElement;
  if (root === null || root.localName.toLowerCase() !== "svg") {
    throw new FacetRenderError("SVG source root element is not <svg>", "svg_bad_root");
  }
  // Defensive malformed check for parsers that recover silently instead
  // of surfacing `parsererror`: a real SVG document has no `<` in its
  // serialized root tag name.
  if (root.tagName.includes("<") || root.tagName.includes(">")) {
    throw new FacetRenderError("SVG source is not well-formed XML", "svg_malformed");
  }
  return doc;
}

export interface SvgImportSettleOptions {
  /** Quiet window before the import counts as settled. */
  readonly settleMs?: number;
  /** Hard cap — a never-settling subtree cannot wedge the barrier. */
  readonly maxWaitMs?: number;
}

/**
 * Import sanitized SVG into the live container through the ONE
 * sanitized path, then wait for the imported subtree to settle under a
 * BOUNDED MutationObserver (quiet-window with a hard cap). The observer
 * disconnects on settle; frame replacement drops the whole subtree, so
 * no observer outlives its frame.
 */
export async function importSanitizedSvgText(
  container: HTMLElement,
  svgText: string,
  options: SvgImportSettleOptions = {},
): Promise<void> {
  const settleMs = options.settleMs ?? 40;
  const maxWaitMs = options.maxWaitMs ?? 1_500;
  const doc = parseSvgData(svgText);
  sanitizeSvgDocument(doc);
  const imported = document.importNode(doc.documentElement, true);
  container.appendChild(imported);
  await new Promise<void>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const cap = setTimeout(() => finish(), maxWaitMs);
    const observer = new MutationObserver(() => {
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), settleMs);
    });
    const finish = (): void => {
      observer.disconnect();
      if (quietTimer !== null) clearTimeout(quietTimer);
      clearTimeout(cap);
      resolve();
    };
    observer.observe(imported, { childList: true, subtree: true, attributes: true });
    quietTimer = setTimeout(() => finish(), settleMs);
  });
}

/** Render a standalone SVG artifact (artifactType "svg"). */
export async function renderSvgDocument(ctx: RenderContext, bytes: Uint8Array): Promise<void> {
  const text = decodeArtifactBytes(bytes);
  await importSanitizedSvgText(ctx.container, text);
}

export const SVG_NAMESPACE = SVG_NS;
