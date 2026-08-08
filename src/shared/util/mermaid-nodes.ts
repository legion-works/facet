/**
 * Canonical lexical counter for mermaid node declarations.
 *
 * A "node declaration" is an identifier directly followed by `[` — the
 * flowchart label shape (`N1[Node 1]`, `A[End]`). The Tier 1 verdict
 * compares this prediction against the renderer-owned `g.node` count
 * observed in the frame, so the prediction lives in ONE place: the
 * service lexical expectations and the Tier 0 parser both import it.
 *
 * The prediction is deliberately bracket-only (it ignores paren/brace
 * shapes, quoted ids, and subgraph titles). Any divergence from the
 * real render maps to `error` in the verdict — never a false `ok` —
 * so an under- or over-prediction fails closed.
 */
export const MERMAID_NODE_DECL_RE = /\b[A-Za-z_][A-Za-z0-9_]*\[/g;

export function countMermaidNodeDeclarations(text: string): number {
  return (text.match(MERMAID_NODE_DECL_RE) ?? []).length;
}
