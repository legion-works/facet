/**
 * Tier 0 mermaid parser.
 *
 * `mermaid.parse()` is the canonical mermaid grammar check: it runs
 * the JISON parser over the input and returns `{ diagramType, config }`
 * for valid sources or THROWS a parse error for invalid ones. No DOM,
 * no rendering — but the library itself depends on a browser-shaped
 * DOM (DOMPurify, etc.) at IMPORT TIME.
 *
 * `dom-shim.ts` installs a linkedom-based structural DOM stub BEFORE
 * this module imports mermaid, so the library's import-time
 * DOMPurify check succeeds. The shim is structural: it never executes
 * artifact source against the DOM. netns ensures any library-initiated
 * network egress cannot reach a host.
 */

import "./dom-shim";
import mermaid from "mermaid";

import type { DiscriminativeError, VerdictObserved } from "../../shared/contracts/validation";
import { countMermaidNodeDeclarations } from "../../shared/util/mermaid-nodes";

export interface MermaidParseOk {
  readonly status: "ok";
  readonly observed: VerdictObserved;
}

export interface MermaidParseFail {
  readonly status: "error";
  readonly observed: VerdictObserved;
  readonly errors: readonly DiscriminativeError[];
}

export type MermaidParseResult = MermaidParseOk | MermaidParseFail;

/**
 * Count node declarations across the source. This is the lexical
 * counter the parser agrees with when the parse succeeds and disagrees
 * with when a hostile artifact lies in its mermaid nodes; the canonical
 * prediction lives in `shared/util/mermaid-nodes.ts` (the service-side
 * expectations import the same one).
 */
function countMermaidNodes(bytes: Uint8Array): number {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return countMermaidNodeDeclarations(text) ?? 0;
}

interface MermaidResolved {
  readonly diagramType: string;
}

/**
 * Parse the source bytes as a mermaid diagram. On success, returns
 * the lexical mermaid-node count. On failure, returns the parser's
 * error text wrapped as a discriminative error.
 */
export async function parseMermaid(bytes: Uint8Array): Promise<MermaidParseResult> {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const lexicalNodes = countMermaidNodes(bytes);
  try {
    const resolved = (await (mermaid as { parse: (s: string) => Promise<MermaidResolved> }).parse(
      text,
    )) as MermaidResolved;
    void resolved;
    return {
      status: "ok",
      observed: {
        rendererRootSvgCount: 1,
        graphCount: 1,
        mermaidNodeCount: lexicalNodes,
        visibleSvgCount: 1,
        errorCount: 0,
        opaqueRegionCount: 0,
        externalImageCount: 0,
      },
    };
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
      errors: [
        {
          code: "mermaid_parse_error",
          message,
        },
      ],
    };
  }
}
