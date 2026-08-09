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
 * descendants. Opaque regions are owning `<canvas>` elements; the
 * probe never calls getContext(), which would create an observation.
 */

import type { ProtocolObservation } from "../../shared/contracts/validation";

import type { VerifierCdpSession } from "./browser-process";

export async function probeIsolatedCounts(
  session: VerifierCdpSession,
  executionContextId: number,
): Promise<ProtocolObservation | null> {
  try {
    const result = (await session.send("Runtime.evaluate", {
      contextId: executionContextId,
      returnByValue: true,
      expression: [
        "(function(){",
        "  var candidates = Array.prototype.slice.call(document.querySelectorAll('svg[data-facet-renderer-root=\"true\"]'));",
        "  var candidateSet = new Set(candidates);",
        "  var roots = candidates.filter(function(root){",
        "    for (var parent = root.parentElement; parent; parent = parent.parentElement) {",
        "      if (candidateSet.has(parent)) return false;",
        "    }",
        "    return true;",
        "  });",
        "  var graphRoots = roots.filter(function(root){ return root.getAttribute('data-facet-renderer-graph') === 'true'; });",
        "  var nodeCount = 0;",
        "  var visibleSvgCount = 0;",
        "  for (var i = 0; i < roots.length; i++) {",
        "    var vb = roots[i].getAttribute('viewBox') || '';",
        "    var parts = vb.trim().split(/[\\s,]+/).map(Number.parseFloat);",
        "    if (parts.length === 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3]) && parts[2] > 0 && parts[3] > 0) visibleSvgCount += 1;",
        "  }",
        "  for (var j = 0; j < graphRoots.length; j++) nodeCount += graphRoots[j].querySelectorAll('g.node').length;",
        "  var errorCount = document.querySelectorAll('[data-facet-error]').length;",
        "  var opaqueRegionCount = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function(el){ return String(el.nodeName).toLowerCase() === 'canvas'; }).length;",
        "  return {",
        "    rendererRootSvgCount: roots.length,",
        "    graphCount: graphRoots.length,",
        "    mermaidNodeCount: nodeCount,",
        "    visibleSvgCount: visibleSvgCount,",
        "    viewBoxes: [],",
        "    errorCount: errorCount,",
        "    opaqueRegionCount: opaqueRegionCount,",
        "    discriminativeErrors: []",
        "  };",
        "})()",
      ].join("\n"),
    })) as { result: { value: ProtocolObservation } };
    return result.result.value;
  } catch {
    return null;
  }
}
