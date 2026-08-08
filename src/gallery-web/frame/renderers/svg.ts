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
 *   - CSS-bearing surface: `<style>` element textContent and `style=`
 *     attribute values are scanned for `@import`, `expression(...)`,
 *     `progid:`, and `url(...)` with a script/external scheme; benign
 *     property:value rules (mermaid node/edge colors, `url(#id)` paint
 *     refs) survive. Presentation attrs that may carry a paint server
 *     (`fill`, `stroke`, `filter`, `mask`, `clip-path`, `marker*`,
 *     `color-profile`, `cursor`, `background-image`) are stripped when
 *     their value resolves to a non-fragment URL with a dangerous scheme;
 *     color literals and fragment refs survive.
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

/** Attributes carrying URLs where only fragment references survive. */
const STRICT_URL_ATTRS = new Set(["href", "xlink:href", "src"]);

/**
 * Presentation attributes that may carry a paint server (`url(#id)`)
 * OR a color/named value. Color literals and fragment refs survive;
 * an attribute is stripped when its value resolves to a non-fragment
 * URL with a dangerous scheme (script execution, external fetch,
 * data: payload, or protocol-relative).
 */
const CSS_REF_ATTRS = new Set([
  "fill",
  "stroke",
  "filter",
  "mask",
  "clip-path",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
  "color-profile",
  "cursor",
  "background-image",
]);

const EVENT_HANDLER_RE = /^on[a-z]+$/i;

/**
 * Dangerous CSS url() targets. `expression(...)` and the legacy
 * `progid:DXImageTransform.*` IE vector are stripped in the same
 * pass because they are equivalent script-execution surface.
 */
const DANGEROUS_CSS_URL_RE =
  /url\s*\(\s*["']?(?:javascript|vbscript|data|https?|file|ftp|blob):[^)]*\)/gi;
const DANGEROUS_PROTOCOL_RELATIVE_URL_RE = /url\s*\(\s*["']?\/\/[^)]*\)/gi;
const CSS_EXPRESSION_RE = /expression\s*\([^)]*\)/gi;
const CSS_PROGID_RE = /progid\s*:[^;}]*/gi;
const CSS_AT_IMPORT_RE = /@import\s+[^;}]*[;}]?/gi;

/** Strip dangerous CSS constructs from raw CSS text. Benign rules survive. */
function sanitizeCssText(css: string): string {
  if (!css) return css;
  return css
    .replace(CSS_AT_IMPORT_RE, "")
    .replace(CSS_EXPRESSION_RE, "")
    .replace(CSS_PROGID_RE, "")
    .replace(DANGEROUS_CSS_URL_RE, "none")
    .replace(DANGEROUS_PROTOCOL_RELATIVE_URL_RE, "none");
}

const CSS_URL_VALUE_RE = /url\s*\(\s*["']?([^)]*?)["']?\s*\)/gi;

/**
 * True when a presentation-attribute value carries a url() whose target
 * is a script/external scheme, or the value itself starts with such a
 * scheme. Fragment refs (`url(#id)`) and color/named values return false.
 */
function containsDangerousCssRef(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  let m: RegExpExecArray | null;
  CSS_URL_VALUE_RE.lastIndex = 0;
  while ((m = CSS_URL_VALUE_RE.exec(v)) !== null) {
    const inner = (m[1] ?? "").trim();
    if (inner.startsWith("#")) continue;
    if (/^(?:javascript|vbscript|data|https?|file|ftp|blob):/i.test(inner)) return true;
    if (inner.startsWith("//")) return true;
  }
  if (/^(?:javascript|vbscript|data|https?|file|ftp|blob):/i.test(v)) return true;
  if (v.startsWith("//")) return true;
  return false;
}

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
      if (STRICT_URL_ATTRS.has(name) && !attr.value.trim().startsWith("#")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (CSS_REF_ATTRS.has(name) && containsDangerousCssRef(attr.value)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "style") {
        const sanitized = sanitizeCssText(attr.value);
        if (sanitized !== attr.value) el.setAttribute(attr.name, sanitized);
      }
    }
    if (el.localName.toLowerCase() === "style") {
      const text = el.textContent;
      if (text) {
        const sanitized = sanitizeCssText(text);
        if (sanitized !== text) el.textContent = sanitized;
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
