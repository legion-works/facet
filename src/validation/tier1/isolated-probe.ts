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
 * descendants. The shim and protocol use the same definition so
 * a forged page-shim cannot drift from the protocol truth.
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
        "  var svgs = document.querySelectorAll('svg');",
        "  var svgCount = svgs.length;",
        "  var nodeCount = 0;",
        "  var visibleSvgCount = 0;",
        "  for (var i = 0; i < svgs.length; i++) {",
        "    nodeCount += svgs[i].querySelectorAll('g.node').length;",
        "    var vb = svgs[i].getAttribute('viewBox');",
        "    if (vb && !/^\\s*0\\s+0\\s+0\\s+0\\s*$/.test(vb)) visibleSvgCount += 1;",
        "  }",
        "  var errorCount = document.querySelectorAll('[data-facet-error]').length;",
        "  return {",
        "    rendererRootSvgCount: svgCount,",
        "    graphCount: svgCount,",
        "    mermaidNodeCount: nodeCount,",
        "    visibleSvgCount: visibleSvgCount,",
        "    viewBoxes: [],",
        "    errorCount: errorCount,",
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
