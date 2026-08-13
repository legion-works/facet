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
 *
 * External-image disclosure: the frozen CSP widens `img-src` to
 * `https:` for every artifact type, so a markdown artifact carrying a
 * native `![](https://…)` image loads that image at display time.
 * `parseMarkdown` walks Marked's token tree (NOT a regex over the
 * source) and tallies every image whose resolved `href` is `https:`.
 * Marked resolves inline, reference-style, and autolink forms into the
 * same `Tokens.Image` shape with the final `href` already populated,
 * so a single walker pass is sufficient. The count surfaces as
 * `observed.externalImageCount` so the verdict can downgrade the
 * artifact to `partial:external_resources`. Raw-HTML smuggling of an
 * `href`/`src` to `https:` remains a hard Tier 0 rejection — that
 * pattern is hostile, not authored.
 */

import { Lexer, type Token, type Tokens } from "marked";

import type { DiscriminativeError, VerdictObserved } from "../../shared/contracts/validation";
import { countMermaidNodeDeclarations } from "../../shared/util/mermaid-nodes";

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
  mermaidNodeCount: number | null;
  rendererRoots: number;
  htmlTokens: number;
  externalImageCount: number;
  hasScript: boolean;
  hasOnHandler: boolean;
  hasExternalRef: boolean;
}

function isExternalHttpsUrl(value: string): boolean {
  // The URL constructor canonicalizes the protocol; malformed URLs
  // (e.g. `https://[`) return false here rather than throwing, so the
  // token walk surfaces a typed zero instead of crashing Tier 0.
  try {
    return new URL(value.trim()).protocol.toLowerCase() === "https:";
  } catch {
    return false;
  }
}

/**
 * Walk the marked token tree and tally the surfaces that matter for
 * the Tier 0 verdict: fenced blocks, mermaid blocks, raw HTML blocks,
 * native-markdown external-image references, and three structural
 * red flags the verifier must NOT execute (a `<script>` token, an
 * `on*=…` handler, and an external URL in any raw-HTML attribute).
 *
 * Marked resolves every image form (inline `![](https://…)`,
 * reference-style `![alt][ref]` whose `[ref]: https://…`, autolink
 * `![<https://…>]()`) into the same `Tokens.Image` shape with the
 * final `href` already populated — the walker counts one `https:`
 * image per token regardless of which authoring form produced it.
 * Raw-HTML `src="https://…"` is the smuggling pattern and is rejected
 * below.
 *
 * Container recursion enumerates every shape Marked actually emits
 * with children: `tokens[]` (blockquote, paragraph, heading, list_item,
 * em, strong, link, image, del, tableCell), `items[]` (list carries
 * ListItem tokens; each item has its own `tokens[]`), `header[]`
 * (table header cells; each cell carries its own `tokens[]`), and
 * `rows[][]` (table body rows of cells; each cell carries its own
 * `tokens[]`). Missing any of these silently misses every image a real
 * status report places in a list or table — see the per-container
 * shape table in the regression report. The walker ALSO recurses the
 * raw-HTML red flags into the same containers: a `<script>` or `on*=`
 * smuggled into a list item or table cell must still reject the
 * document, the same as a top-level smuggled reference.
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
        const nodes = countMermaidNodeDeclarations(code.text);
        counts.mermaidNodeCount =
          counts.mermaidNodeCount === null || nodes === null
            ? null
            : counts.mermaidNodeCount + nodes;
      }
    } else if (token.type === "html") {
      const html = token as Tokens.HTML;
      counts.htmlTokens += 1;
      const raw = html.raw ?? html.text ?? "";
      if (/<script[\s>]/i.test(raw)) counts.hasScript = true;
      if (/\son[a-z]+\s*=/i.test(raw)) counts.hasOnHandler = true;
      if (/\b(?:href|src)\s*=\s*["']https?:/i.test(raw)) counts.hasExternalRef = true;
    } else if (token.type === "image") {
      const image = token as Tokens.Image;
      if (isExternalHttpsUrl(image.href ?? "")) counts.externalImageCount += 1;
    }
    // Recurse every container Marked actually emits with children.
    const recurseTokens = (sub: Token[] | undefined): void => {
      if (Array.isArray(sub)) walkTokens(sub, counts);
    };
    const t = token as unknown as Record<string, unknown>;
    // tokens[] — blockquote, paragraph, heading, list_item, em,
    // strong, link, image (inline children), del, tableCell.
    recurseTokens(t["tokens"] as Token[] | undefined);
    // items[] — list carries ListItem tokens (each with its own
    // tokens[] walked above when we visit them).
    const items = t["items"] as Token[] | undefined;
    if (Array.isArray(items)) walkTokens(items, counts);
    // header[] — table header cells. Each cell carries its own
    // tokens[] walked when we visit the cell token below.
    const headerCells = t["header"] as Array<{ tokens?: Token[] }> | undefined;
    if (Array.isArray(headerCells)) {
      for (const cell of headerCells) {
        if (cell !== null && typeof cell === "object") {
          recurseTokens(cell.tokens as Token[] | undefined);
        }
      }
    }
    // rows[][] — table body rows, each row is an array of cells,
    // each cell carries its own tokens[].
    const rows = t["rows"] as Array<Array<{ tokens?: Token[] } | null>> | undefined;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (Array.isArray(row)) {
          for (const cell of row) {
            if (cell !== null && typeof cell === "object") {
              recurseTokens(cell.tokens as Token[] | undefined);
            }
          }
        }
      }
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
    mermaidNodeCount: 0,
    rendererRoots: 0,
    htmlTokens: 0,
    externalImageCount: 0,
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
        mermaidNodeCount: counts.mermaidNodeCount ?? 0,
        visibleSvgCount: 0,
        externalImageCount: 0,
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
        mermaidNodeCount: counts.mermaidNodeCount ?? 0,
        visibleSvgCount: 0,
        externalImageCount: counts.externalImageCount,
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
        mermaidNodeCount: counts.mermaidNodeCount ?? 0,
        visibleSvgCount: 0,
        externalImageCount: counts.externalImageCount,
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
        mermaidNodeCount: counts.mermaidNodeCount ?? 0,
        visibleSvgCount: 0,
        externalImageCount: counts.externalImageCount,
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
      mermaidNodeCount: counts.mermaidNodeCount ?? 0,
      visibleSvgCount: 0,
      externalImageCount: counts.externalImageCount,
      errorCount: 0,
      opaqueRegionCount: 0,
    },
  };
}
