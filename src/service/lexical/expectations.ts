/**
 * Lexical expectations — the ONLY type-adjacent service module. It
 * scans source bytes as TEXT to count fenced blocks (total + per-language
 * for `mermaid`) and to estimate the renderer root count, WITHOUT
 * importing any markdown, mermaid, svg, or dom-shim library.
 *
 * The boundary checker (scripts/check-boundaries.ts) tolerates this
 * single file under src/service/ because the whole point of the
 * service is to remain byte-dumb while still being able to compute
 * lexical expectations the verifier compares against its own observed
 * counts.
 */

import { MAX_MERMAID_BLOCKS, MAX_MERMAID_NODES } from "../../shared/config/limits";
import type { ArtifactType } from "../../shared/contracts/artifact";
import type { Renderer } from "../../shared/contracts/renderers";
import { countMermaidNodeDeclarations } from "../../shared/util/mermaid-nodes";

export interface FencedBlockCounts {
  /** Total number of fenced blocks (any language) in the source. */
  readonly total: number;
  /** Number of fenced blocks whose info string equals "mermaid" (trimmed, case-sensitive). */
  readonly mermaid: number;
  /**
   * Per-language counts. Key is the trimmed info string of the fence
   * (e.g. "mermaid", "typescript"); fenced blocks with no info string
   * collapse into the empty-string key.
   */
  readonly byLanguage: ReadonlyMap<string, number>;
}

export interface LexicalExpectations {
  readonly totalFencedBlocks: number;
  readonly mermaidBlocks: number;
  readonly fencedBlocksByLanguage: ReadonlyMap<string, number>;
  /**
   * Expected number of renderer-root SVGs. For markdown sources this
   * is the mermaid block count (each fenced mermaid block produces one
   * renderer root); for mermaid/svg/chart sources it is 1 (the whole
   * document renders as one renderer-owned root). The verifier counts
   * the actual SVGs and the verdict fails closed on any divergence.
   */
  readonly expectedRendererRoots: number;
  /** Expected opaque regions produced by renderer modes without SVG roots. */
  readonly expectedOpaqueRegions: number;
  /**
   * Lexical node count: identifier-`[` declarations (`N1[...]`,
   * `A[...]`) across all mermaid blocks — the prediction the verdict
   * compares against the renderer-owned `g.node` count. Bounds the
   * verifier's expected observation independent of byte count.
   */
  readonly mermaidNodeCount: number;
  /** True iff the source exceeds MAX_MERMAID_BLOCKS or MAX_MERMAID_NODES. */
  readonly exceedsComplexityBudget: boolean;
}

/**
 * Fence opener: a line that begins with three-or-more backticks OR
 * three-or-more tildes, optionally followed by an info string. Closing
 * fence: a line of the same character whose run length is at least the
 * opener's run length. Info strings are trimmed; an empty info string
 * is allowed and maps to the "" key.
 */
const FENCE_OPENER_RE = /^[ ]{0,3}(`{3,}|~{3,})([^\n]*)$/gm;

interface FenceSpan {
  readonly start: number;
  readonly end: number;
  readonly info: string;
  readonly char: "`" | "~";
}

interface FenceCandidate {
  readonly index: number;
  readonly length: number;
  readonly char: "`" | "~";
  /** Trimmed info string after the fence chars; "" when only whitespace. */
  readonly info: string;
}

/**
 * A closing code fence must use the same character as the opening
 * fence, be at least as long, and carry NO info string (only whitespace
 * after the fence chars). Without the info-string check, an inner fence
 * with a language tag (e.g. ```mermaid inside a ```mermaid body)
 * would silently close its enclosing fence and split one block into two.
 */
function isValidCloser(candidate: FenceCandidate, open: FenceCandidate): boolean {
  return candidate.char === open.char && candidate.length >= open.length && candidate.info === "";
}

function findFenceSpans(text: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  const candidates: FenceCandidate[] = [];
  for (const match of text.matchAll(FENCE_OPENER_RE)) {
    const index = match.index ?? 0;
    const fence = match[1] ?? "";
    const info = (match[2] ?? "").trim();
    const char: "`" | "~" = fence.startsWith("`") ? "`" : "~";
    candidates.push({ index, length: fence.length, char, info });
  }
  let open: FenceCandidate | null = null;
  for (const candidate of candidates) {
    if (open === null) {
      open = candidate;
      continue;
    }
    if (isValidCloser(candidate, open)) {
      spans.push({
        start: open.index,
        end: candidate.index + candidate.length,
        info: open.info,
        char: open.char,
      });
      open = null;
      continue;
    }
    // Not a valid closer (different char, shorter run, or carries an
    // info string). The candidate is body content of the open fence;
    // keep looking for the real closer.
  }
  return spans;
}

function countMermaidNodes(text: string, spans: readonly FenceSpan[]): number {
  let count = 0;
  for (const span of spans) {
    if (span.info !== "mermaid") continue;
    const body = text.slice(span.start, span.end);
    count += countMermaidNodeDeclarations(body);
  }
  return count;
}

/**
 * Count fenced code blocks. Returns total + per-language + the
 * special-cased mermaid count. The byte input is decoded as UTF-8;
 * the caller is expected to pass artifact source bytes, not arbitrary
 * binary blobs.
 */
export function countFencedBlocks(bytes: Uint8Array): {
  total: number;
  mermaid: number;
  byLanguage: Map<string, number>;
} {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const spans = findFenceSpans(text);
  const byLanguage = new Map<string, number>();
  let mermaid = 0;
  for (const span of spans) {
    const key = span.info;
    byLanguage.set(key, (byLanguage.get(key) ?? 0) + 1);
    if (key === "mermaid") mermaid += 1;
  }
  return { total: spans.length, mermaid, byLanguage };
}

/** Convenience wrapper that returns only the mermaid block count. */
export function countMermaidBlocks(bytes: Uint8Array): number {
  return countFencedBlocks(bytes).mermaid;
}

/**
 * Compute the full lexical expectation surface for a source. The
 * shape is the one consumed later by Tier 0 / Tier 1 verifiers to
 * compare lexical expectations against observed counters.
 *
 * The expectations are artifact-type aware because the renderers are:
 * markdown produces one renderer root per mermaid fence; mermaid,
 * svg, and chart each render the whole document as ONE renderer-owned
 * root. Node declarations are predicted only for the diagram-bearing
 * types (markdown fences, mermaid documents).
 */
export function computeLexicalExpectations(
  bytes: Uint8Array,
  artifactType: ArtifactType,
  renderer: Renderer = "svg",
): LexicalExpectations {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const spans = findFenceSpans(text);
  const byLanguage = new Map<string, number>();
  let mermaid = 0;
  for (const span of spans) {
    byLanguage.set(span.info, (byLanguage.get(span.info) ?? 0) + 1);
    if (span.info === "mermaid") mermaid += 1;
  }
  const mermaidNodeCount =
    artifactType === "markdown"
      ? countMermaidNodes(text, spans)
      : artifactType === "mermaid"
        ? countMermaidNodeDeclarations(text)
        : 0;
  const exceedsComplexityBudget =
    mermaid > MAX_MERMAID_BLOCKS || mermaidNodeCount > MAX_MERMAID_NODES;
  const canvasChart = artifactType === "chart" && renderer === "canvas";
  const expectedRendererRoots = canvasChart ? 0 : artifactType === "markdown" ? mermaid : 1;
  return {
    totalFencedBlocks: spans.length,
    mermaidBlocks: mermaid,
    fencedBlocksByLanguage: byLanguage,
    expectedRendererRoots,
    expectedOpaqueRegions: canvasChart ? 1 : 0,
    mermaidNodeCount,
    exceedsComplexityBudget,
  };
}
