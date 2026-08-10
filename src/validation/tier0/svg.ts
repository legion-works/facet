/**
 * Tier 0 SVG parser.
 *
 * Uses `fast-xml-parser` to tokenize the source as XML, then walks the
 * tree checking structural invariants. The Tier 0 verdict never
 * executes any SVG; it only verifies that the artifact cannot smuggle
 * executable content past the renderer:
 *
 *   - `<script>` elements are rejected at any depth.
 *   - `<foreignObject>` may not contain `<script>` either (a nested
 *     escape vector).
 *   - Event-handler attributes (`on*`) on every element are rejected.
 *   - URLs in `href`/`xlink:href` must NOT reference external schemes
 *     (http(s), file, ftp, javascript, data, blob). Inline-only.
 *   - The root element must be `<svg>` (not, e.g., a hostile XML
 *     payload that happens to parse as XML).
 *   - The root must carry a `viewBox` (verifiers check `viewBoxes`).
 *
 * The parser does not enforce renderer-side layout (Tier 1's job); it
 * only validates structural safety.
 */

import { XMLParser } from "fast-xml-parser";

import { MAX_SVG_BYTES, MAX_SVG_ROOTS } from "../../shared/config/limits";
import type { DiscriminativeError, VerdictObserved } from "../../shared/contracts/validation";

const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Treat these as void so a hostile DTD/ENTITY doesn't expand.
  processEntities: false,
};

export interface SvgParseOk {
  readonly status: "ok";
  readonly observed: VerdictObserved;
  readonly viewBoxes: readonly string[];
}

export interface SvgParseFail {
  readonly status: "error";
  readonly observed: VerdictObserved;
  readonly errors: readonly DiscriminativeError[];
}

export type SvgParseResult = SvgParseOk | SvgParseFail;

const EVENT_HANDLER_RE = /^on[a-z]+$/i;
const EXTERNAL_SCHEME_RE = /^(?:https?|ftp|file|javascript|data|blob|vbscript|jar):/i;
const DANGEROUS_TAGS = new Set(["script"]);

/**
 * Recursively walk the parsed XML tree, counting the elements/attributes
 * Tier 0 must reject. The walk does NOT execute anything; it only
 * collects evidence for the verdict.
 */
function walkNode(
  node: unknown,
  name: string,
  ctx: {
    scriptElements: number;
    eventHandlerAttributes: number;
    externalRefAttributes: number;
    rootSvgCount: number;
    viewBoxes: string[];
  },
  isRoot: boolean,
): void {
  if (name === "script" || DANGEROUS_TAGS.has(name)) {
    ctx.scriptElements += 1;
  }
  if (!isPlainObject(node)) return;
  // Detect attributes on the current element.
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith("@_")) continue;
    const attrName = key.slice(2);
    const attrValue = typeof value === "string" ? value : String(value ?? "");
    if (EVENT_HANDLER_RE.test(attrName)) {
      ctx.eventHandlerAttributes += 1;
      continue;
    }
    if (attrName === "href" || attrName === "xlink:href") {
      if (EXTERNAL_SCHEME_RE.test(attrValue.trim())) {
        ctx.externalRefAttributes += 1;
      }
      continue;
    }
    if (isRoot && attrName === "viewBox") {
      ctx.viewBoxes.push(attrValue);
    }
  }
  if (isRoot && name === "svg") {
    ctx.rootSvgCount += 1;
  }
  // Recurse into children (each key maps to a sub-node or array of sub-nodes).
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (key === "#text") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkNode(child, key, ctx, false);
    } else if (value !== undefined) {
      walkNode(value, key, ctx, false);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the source bytes as SVG. The parse is structural: no DOM, no
 * rendering, no URL fetch. A hostile source that smuggles
 * `<script>`/handlers/external URLs is rejected at Tier 0 so it can
 * never reach a renderer.
 */
export function parseSvg(bytes: Uint8Array): SvgParseResult {
  if (bytes.byteLength > MAX_SVG_BYTES) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
      errors: [
        {
          code: "svg_too_large",
          message: `SVG bytes exceed MAX_SVG_BYTES (${MAX_SVG_BYTES})`,
        },
      ],
    };
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const parser = new XMLParser(XML_OPTIONS);
  let parsed: unknown;
  try {
    parsed = parser.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
      errors: [{ code: "svg_xml_error", message }],
    };
  }

  // The parsed root is an object whose keys are the top-level XML
  // elements. We walk it as if the outermost key were the document
  // element; for an SVG document the key is "svg" and the inner
  // children are the elements we want to scan.
  const ctx = {
    scriptElements: 0,
    eventHandlerAttributes: 0,
    externalRefAttributes: 0,
    rootSvgCount: 0,
    viewBoxes: [] as string[],
  };
  if (isPlainObject(parsed)) {
    for (const [topName, topValue] of Object.entries(parsed)) {
      const children = Array.isArray(topValue) ? topValue : [topValue];
      for (const child of children) {
        walkNode(child, topName, ctx, true);
      }
    }
  }

  if (ctx.rootSvgCount === 0) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
      errors: [
        {
          code: "svg_no_root",
          message: "Document does not contain a top-level <svg> element",
        },
      ],
    };
  }
  if (ctx.rootSvgCount > MAX_SVG_ROOTS) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: ctx.rootSvgCount,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
      errors: [
        {
          code: "svg_too_many_roots",
          message: `SVG contains ${ctx.rootSvgCount} top-level <svg> elements; cap is ${MAX_SVG_ROOTS}`,
        },
      ],
    };
  }
  if (ctx.viewBoxes.length === 0) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: ctx.rootSvgCount,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
      errors: [
        {
          code: "svg_missing_viewbox",
          message:
            "Top-level <svg> element must declare a viewBox; Tier 0 rejects ambiguous bounds",
        },
      ],
    };
  }
  if (ctx.scriptElements > 0) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: ctx.rootSvgCount,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: ctx.scriptElements,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
      errors: [
        {
          code: "svg_script_element",
          message: `SVG contains ${ctx.scriptElements} <script> element(s); Tier 0 rejects them`,
        },
      ],
    };
  }
  if (ctx.eventHandlerAttributes > 0) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: ctx.rootSvgCount,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: ctx.eventHandlerAttributes,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
      errors: [
        {
          code: "svg_event_handler",
          message: `SVG contains ${ctx.eventHandlerAttributes} on*= event-handler attribute(s); Tier 0 rejects them`,
        },
      ],
    };
  }
  if (ctx.externalRefAttributes > 0) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: ctx.rootSvgCount,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: ctx.externalRefAttributes,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
      errors: [
        {
          code: "svg_external_reference",
          message: `SVG contains ${ctx.externalRefAttributes} external-scheme URL attribute(s); Tier 0 rejects them`,
        },
      ],
    };
  }

  return {
    status: "ok",
    observed: {
      rendererRootSvgCount: ctx.rootSvgCount,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: ctx.rootSvgCount,
      errorCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 0,
    },
    viewBoxes: ctx.viewBoxes,
  };
}
