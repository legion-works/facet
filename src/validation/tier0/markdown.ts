/**
 * Tier 0 markdown parser.
 *
 * Marked's Lexer tokenizes the source into the CommonMark block tree
 * without rendering. We use it to (a) confirm the source is structurally
 * well-formed CommonMark, (b) count fenced blocks and per-language
 * counts (cross-checking the service-side `computeLexicalExpectations`),
 * and (c) verify raw HTML is treated as DATA, not executed.
 *
 * The Tier 0 renderer root expectation is one per ```mermaid fence.
 * Marked produces inline `html` tokens for raw HTML blocks; those are
 * counted but never attached to a DOM. The `marked` lexer therefore
 * gives us a safe structural check without any rendering surface.
 */

import { Lexer, type Token, type Tokens } from "marked";

import type { DiscriminativeError, VerdictObserved } from "../../shared/contracts/validation";

export interface MarkdownParseOk {
  readonly status: "ok";
  readonly observed: VerdictObserved;
}

export interface MarkdownParseFail {
  readonly status: "error";
  readonly observed: VerdictObserved;
  readonly errors: readonly DiscriminativeError[];
}

export type MarkdownParseResult = MarkdownParseOk | MarkdownParseFail;

interface MarkdownCounts {
  totalFenced: number;
  mermaidFenced: number;
  rendererRoots: number;
  htmlTokens: number;
  hasScript: boolean;
  hasOnHandler: boolean;
  hasExternalRef: boolean;
}

/**
 * Walk the marked token tree and tally the surfaces that matter for
 * the Tier 0 verdict: fenced blocks, mermaid blocks, raw HTML blocks,
 * and three structural red flags the verifier must NOT execute (a
 * `<script>` token, an `on*=…` handler, and an external URL in any
 * attribute). The red flags are counted so a hostile source that
 * smuggles executable content surfaces as `status: "error"` even
 * though marked does not interpret it.
 */
function walkTokens(tokens: Token[], counts: MarkdownCounts): void {
  for (const token of tokens) {
    if (token.type === "code") {
      const code = token as Tokens.Code;
      counts.totalFenced += 1;
      const lang = (code.lang ?? "").trim().toLowerCase();
      if (lang === "mermaid") {
        counts.mermaidFenced += 1;
        counts.rendererRoots += 1;
      }
    } else if (token.type === "html") {
      const html = token as Tokens.HTML;
      counts.htmlTokens += 1;
      const raw = html.raw ?? html.text ?? "";
      if (/<script[\s>]/i.test(raw)) counts.hasScript = true;
      if (/\son[a-z]+\s*=/i.test(raw)) counts.hasOnHandler = true;
      if (/\b(?:href|src)\s*=\s*["']https?:/i.test(raw)) counts.hasExternalRef = true;
    }
    // Recurse into containers (paragraph, list, blockquote, table).
    const recurseTokens = (sub: Token[] | undefined): void => {
      if (Array.isArray(sub)) walkTokens(sub, counts);
    };
    const t = token as unknown as Record<string, unknown>;
    recurseTokens(t["tokens"] as Token[] | undefined);
    const header = t["header"] as { tokens?: Token[] } | undefined;
    if (header !== undefined) recurseTokens(header.tokens);
    const rows = t["rows"] as Array<{ tokens?: Token[] }> | undefined;
    if (Array.isArray(rows)) {
      for (const row of rows) recurseTokens(row.tokens);
    }
  }
}

/**
 * Parse the source bytes as markdown. Pure tokenization — no DOM, no
 * render, no script execution. Raw HTML is counted (it must NOT
 * execute, and we surface structural red flags if it tries to smuggle
 * one) but never interpreted.
 */
export function parseMarkdown(bytes: Uint8Array): MarkdownParseResult {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const counts: MarkdownCounts = {
    totalFenced: 0,
    mermaidFenced: 0,
    rendererRoots: 0,
    htmlTokens: 0,
    hasScript: false,
    hasOnHandler: false,
    hasExternalRef: false,
  };
  let lexError: unknown = null;
  let tokens: Token[] = [];
  try {
    const lexer = new Lexer({ gfm: true });
    tokens = lexer.lex(text);
    walkTokens(tokens, counts);
  } catch (error) {
    lexError = error;
  }

  if (lexError !== null) {
    const message = lexError instanceof Error ? lexError.message : String(lexError);
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
        opaqueRegionCount: 0,
      },
      errors: [{ code: "markdown_lex_error", message }],
    };
  }

  // Raw HTML must NEVER execute. A token containing a script, an
  // `on*` handler, or an external URL surfaces as a parser error so a
  // hostile artifact cannot smuggle executable content past Tier 0.
  if (counts.hasScript) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: counts.rendererRoots,
        graphCount: counts.mermaidFenced,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
        opaqueRegionCount: 0,
      },
      errors: [
        {
          code: "html_script_in_markdown",
          message: "Raw HTML in markdown contains a <script> element; Tier 0 rejects it",
        },
      ],
    };
  }
  if (counts.hasOnHandler) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: counts.rendererRoots,
        graphCount: counts.mermaidFenced,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
        opaqueRegionCount: 0,
      },
      errors: [
        {
          code: "html_event_handler_in_markdown",
          message: "Raw HTML in markdown contains an on*= event handler; Tier 0 rejects it",
        },
      ],
    };
  }
  if (counts.hasExternalRef) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: counts.rendererRoots,
        graphCount: counts.mermaidFenced,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
        opaqueRegionCount: 0,
      },
      errors: [
        {
          code: "html_external_reference_in_markdown",
          message: "Raw HTML in markdown contains an external href/src URL; Tier 0 rejects it",
        },
      ],
    };
  }

  return {
    status: "ok",
    observed: {
      rendererRootSvgCount: counts.rendererRoots,
      graphCount: counts.mermaidFenced,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      errorCount: 0,
      opaqueRegionCount: 0,
    },
  };
}
