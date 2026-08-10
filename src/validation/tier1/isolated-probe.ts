/**
 * Isolated-world probe — evaluate counts inside the pre-created
 * execution context (`Page.createIsolatedWorld`). The isolated world
 * is OUTSIDE the page's JavaScript scope: a hostile artifact that
 * monkey-patched `document.querySelectorAll` (Test A) cannot reach
 * it. Counts taken here are the third authority channel after
 * `DOMSnapshot` and `DOM.getDocument`.
 *
 * Failure to evaluate returns null — the verifier falls back to
 * `shim_only` instead of `tampered` because a missing isolated
 * world is a probe-level failure, not a page-world divergence.
 *
 * `graphCount` matches the protocol probe: one count per
 * renderer-owned `<svg>`. `mermaidNodeCount` sums the `g.node`
 * descendants. Those renderer counts are marker-scoped; opaque regions
 * deliberately census every owning `<canvas>` in the frame document so
 * smuggled canvases cannot hide outside a marked root. The probe never
 * calls getContext(), which would create an observation.
 */

import type { ProtocolObservation } from "../../shared/contracts/validation";
import { HTML_STRUCTURAL_GROUPS } from "../../shared/html/policy";

import type { VerifierCdpSession } from "./browser-process";

export async function probeIsolatedCounts(
  session: VerifierCdpSession,
  executionContextId: number,
): Promise<ProtocolObservation | null> {
  try {
    const selectors = Object.fromEntries(
      Object.entries(HTML_STRUCTURAL_GROUPS).map(([group, names]) => [group, names.join(",")]),
    );
    const result = (await session.send("Runtime.evaluate", {
      contextId: executionContextId,
      returnByValue: true,
      expression: [
        "(function(){",
        "  var candidates = Array.prototype.slice.call(document.querySelectorAll('[data-facet-renderer-root=\"true\"]'));",
        "  var candidateSet = new Set(candidates);",
        "  var roots = candidates.filter(function(root){",
        "    for (var parent = root.parentElement; parent; parent = parent.parentElement) {",
        "      if (candidateSet.has(parent)) return false;",
        "    }",
        "    return true;",
        "  });",
        "  var svgRoots = roots.filter(function(root){ return String(root.nodeName).toLowerCase() === 'svg'; });",
        "  var graphRoots = svgRoots.filter(function(root){ return root.getAttribute('data-facet-renderer-graph') === 'true'; });",
        "  var htmlRoots = roots.filter(function(root){ return String(root.nodeName).toLowerCase() !== 'svg'; });",
        `  var selectors = ${JSON.stringify(selectors)};`,
        "  var html = htmlRoots.length === 0 ? null : {rendererRootCount:htmlRoots.length,headingCount:0,tableCount:0,listCount:0,imageCount:0,canvasCount:0,externalImageCount:0};",
        "  var externalImageCount = 0;",
        "  for (var h = 0; h < htmlRoots.length; h++) {",
        "    var htmlRoot = htmlRoots[h];",
        "    html.headingCount += htmlRoot.querySelectorAll(selectors.headings).length;",
        "    html.tableCount += htmlRoot.querySelectorAll(selectors.tables).length;",
        "    html.listCount += htmlRoot.querySelectorAll(selectors.lists).length;",
        "    var images = Array.prototype.slice.call(htmlRoot.querySelectorAll(selectors.images));",
        "    html.imageCount += images.length;",
        "    var rootExternal = images.filter(function(image){ try { return new URL(image.getAttribute('src') || '').protocol === 'https:'; } catch (_) { return false; } }).length;",
        "    html.externalImageCount += rootExternal;",
        "    externalImageCount += rootExternal;",
        "    html.canvasCount += htmlRoot.querySelectorAll(selectors.canvases).length;",
        "  }",
        "  var nodeCount = 0;",
        "  var visibleSvgCount = 0;",
        "  for (var i = 0; i < svgRoots.length; i++) {",
        "    var vb = svgRoots[i].getAttribute('viewBox') || '';",
        "    var parts = vb.trim().split(/[\\s,]+/).map(Number.parseFloat);",
        "    if (parts.length === 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3]) && parts[2] > 0 && parts[3] > 0) visibleSvgCount += 1;",
        "  }",
        "  for (var j = 0; j < graphRoots.length; j++) nodeCount += graphRoots[j].querySelectorAll('g.node').length;",
        "  var errorCount = document.querySelectorAll('[data-facet-error]').length;",
        "  var opaqueRegionCount = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function(el){ return String(el.nodeName).toLowerCase() === 'canvas'; }).length;",
        "  return {",
        "    rendererRootSvgCount: svgRoots.length,",
        "    graphCount: graphRoots.length,",
        "    mermaidNodeCount: nodeCount,",
        "    visibleSvgCount: visibleSvgCount,",
        "    viewBoxes: [],",
        "    errorCount: errorCount,",
        "    opaqueRegionCount: opaqueRegionCount,",
        "    externalImageCount: externalImageCount,",
        "    discriminativeErrors: [],",
        "    ...(html === null ? {} : {html: html})",
        "  };",
        "})()",
      ].join("\n"),
    })) as { result: { value?: ProtocolObservation } };
    return result.result.value ?? null;
  } catch {
    return null;
  }
}
