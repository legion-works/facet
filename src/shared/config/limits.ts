/**
 * Hard cap on artifact source bytes per ADR 0001 D2. Benchmarks measured
 * 20/20 clean renders through 5 MB inside the 200 ms visibility budget;
 * 10 MB breaches it. Renderer-complexity guards are separate from this
 * cap and live alongside it (see below).
 */
export const SOURCE_CAP_BYTES = 5 * 1024 * 1024;

/** Pinned Chrome for Testing build used by the Tier 1 verifier. */
export const TIER1_PINNED_VERSION = "151.0.7922.77";

/**
 * Lexical guard: at most this many ```mermaid fenced blocks in one
 * artifact. Larger graphs hit the mermaid parser's own limits and
 * produce unreadable SVGs.
 */
export const MAX_MERMAID_BLOCKS = 64;

/**
 * Lexical guard: at most this many `N<digits>[...]` node declarations
 * across all mermaid blocks in one artifact. Bounds the rendered DOM
 * size independent of source byte count.
 */
export const MAX_MERMAID_NODES = 10_000;

/**
 * Lexical guard: max bytes in a single SVG artifact. Bounds the render
 * time on the Tier 1 verifier independent of the source cap (an SVG
 * can be small in bytes but enormous in DOM).
 */
export const MAX_SVG_BYTES = 1 * 1024 * 1024;

/**
 * Lexical guard: max top-level `<svg>` elements in a single SVG
 * artifact. Forged pages cannot add more than this without inflating
 * the verifier's own SVG count past the lexical expectation.
 */
export const MAX_SVG_ROOTS = 16;
