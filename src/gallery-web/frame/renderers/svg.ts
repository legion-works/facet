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
  "background",
  "background-image",
]);

const EVENT_HANDLER_RE = /^on[a-z]+$/i;

function stripCssComments(css: string): string {
  let clean = "";
  let quote = "";
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]!;
    if (quote) {
      clean += char;
      if (char === "\\" && index + 1 < css.length) clean += css[(index += 1)]!;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      clean += char;
      continue;
    }
    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 1;
      continue;
    }
    clean += char;
  }
  return clean;
}

function canonicalizeCss(css: string): string {
  const uncommented = stripCssComments(css);
  let decoded = "";
  for (let index = 0; index < uncommented.length; index += 1) {
    const char = uncommented[index]!;
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const next = uncommented[index + 1];
    if (next === undefined) break;
    if (next === "\n" || next === "\f") {
      index += 1;
      continue;
    }
    if (next === "\r") {
      index += uncommented[index + 2] === "\n" ? 2 : 1;
      continue;
    }
    let hex = "";
    while (hex.length < 6 && /[0-9a-f]/i.test(uncommented[index + 1] ?? "")) {
      hex += uncommented[(index += 1)]!;
    }
    if (hex) {
      const codePoint = Number.parseInt(hex, 16);
      decoded +=
        codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? "\uFFFD"
          : String.fromCodePoint(codePoint);
      if (/\s/.test(uncommented[index + 1] ?? "")) index += 1;
      continue;
    }
    decoded += next;
    index += 1;
  }
  return decoded.toLowerCase().replace(/\s+/g, " ").trim();
}

function findClosingDelimiter(css: string, openIndex: number, open: string, close: string): number {
  let depth = 1;
  let quote = "";
  for (let index = openIndex + 1; index < css.length; index += 1) {
    const char = css[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === open) depth += 1;
    else if (char === close && --depth === 0) return index;
  }
  return -1;
}

function containsUnsafeCssValue(value: string): boolean {
  const canonical = canonicalizeCss(value);
  if (!canonical) return false;
  if (
    /@import\b/.test(canonical) ||
    /(?:^|[^a-z0-9_-])expression\s*\(/.test(canonical) ||
    /(?:^|[^a-z0-9_-])progid\s*:/.test(canonical) ||
    /(?:^|[^a-z0-9_-])behavior\s*:/.test(canonical) ||
    /^[a-z][a-z0-9+.-]*\s*:/.test(canonical)
  ) {
    return true;
  }

  for (let searchFrom = 0; searchFrom < canonical.length; ) {
    const index = canonical.indexOf("url", searchFrom);
    if (index === -1) return false;
    searchFrom = index + 3;
    if (index > 0 && /[a-z0-9_-]/.test(canonical[index - 1]!)) continue;
    let openIndex = searchFrom;
    while (canonical[openIndex] === " ") openIndex += 1;
    if (canonical[openIndex] !== "(") continue;
    const closeIndex = findClosingDelimiter(canonical, openIndex, "(", ")");
    if (closeIndex === -1) return true;
    let argument = canonical.slice(openIndex + 1, closeIndex).trim();
    const quote = argument[0];
    if (quote === '"' || quote === "'") {
      if (argument.at(-1) !== quote) return true;
      argument = argument.slice(1, -1).trim();
    }
    if (!argument.startsWith("#")) return true;
    searchFrom = closeIndex + 1;
  }
  return false;
}

function findDeclarationColon(css: string): number {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ":" && depth === 0) return index;
  }
  return -1;
}

function sanitizeCssStatement(statement: string): string {
  const trimmed = statement.trim();
  if (!trimmed) return "";
  const colon = findDeclarationColon(trimmed);
  const checkedValue = colon === -1 ? trimmed : trimmed.slice(colon + 1);
  return containsUnsafeCssValue(checkedValue) || /@import\b/.test(canonicalizeCss(trimmed))
    ? ""
    : trimmed;
}

function sanitizeCssBlock(css: string): string {
  let sanitized = "";
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) {
      const statement = sanitizeCssStatement(css.slice(start, index));
      if (statement) sanitized += `${statement};`;
      start = index + 1;
    } else if (char === "{" && depth === 0) {
      const closeIndex = findClosingDelimiter(css, index, "{", "}");
      const prelude = css.slice(start, index).trim();
      if (closeIndex === -1) return sanitized;
      if (!containsUnsafeCssValue(prelude) && !/@import\b/.test(canonicalizeCss(prelude))) {
        sanitized += `${prelude}{${sanitizeCssBlock(css.slice(index + 1, closeIndex))}}`;
      }
      index = closeIndex;
      start = closeIndex + 1;
    }
  }
  const trailing = sanitizeCssStatement(css.slice(start));
  return trailing ? sanitized + trailing : sanitized;
}

/** CSS is decoded for comparison because source spelling is not a security boundary. */
function sanitizeCssText(css: string): string {
  return sanitizeCssBlock(stripCssComments(css));
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
      if (CSS_REF_ATTRS.has(name) && containsUnsafeCssValue(attr.value)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "style") {
        const sanitized = sanitizeCssText(attr.value);
        if (!sanitized) el.removeAttribute(attr.name);
        else if (sanitized !== attr.value) el.setAttribute(attr.name, sanitized);
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
