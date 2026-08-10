import { parse, Tokenizer, type TokenHandler } from "parse5";

import { MAX_HTML_NESTING_DEPTH } from "../../shared/config/limits";
import type { DiscriminativeError, HtmlStructureCounts } from "../../shared/contracts/validation";
import {
  HTML_STRUCTURAL_GROUPS,
  isAllowedHtmlUrl,
  isHtmlDeniedElement,
  isHtmlEventHandlerAttribute,
  isHtmlInlineStyleAttribute,
  isHtmlUrlAttributeName,
  isHtmlUrlBearingAttribute,
} from "../../shared/html/policy";

export interface HtmlParseOk {
  readonly status: "ok";
  readonly html: HtmlStructureCounts;
}

export interface HtmlParseFail {
  readonly status: "error";
  readonly html: HtmlStructureCounts;
  readonly errors: readonly DiscriminativeError[];
}

export type HtmlParseResult = HtmlParseOk | HtmlParseFail;

interface HtmlAttribute {
  readonly name: string;
  readonly value: string;
}

const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function exceedsHtmlNestingDepth(text: string): boolean {
  const openTags: string[] = [];
  const positionsByTag = new Map<string, number[]>();
  let exceeded = false;
  let tokenizer: Tokenizer;
  const handler: TokenHandler = {
    onComment: () => {},
    onDoctype: () => {},
    onStartTag: (token) => {
      if (token.selfClosing || HTML_VOID_ELEMENTS.has(token.tagName)) return;
      const position = openTags.length;
      openTags.push(token.tagName);
      const positions = positionsByTag.get(token.tagName) ?? [];
      positions.push(position);
      positionsByTag.set(token.tagName, positions);
      if (openTags.length > MAX_HTML_NESTING_DEPTH) {
        exceeded = true;
        tokenizer.pause();
      }
    },
    onEndTag: (token) => {
      const positions = positionsByTag.get(token.tagName);
      const position = positions?.at(-1);
      if (position === undefined) return;
      while (openTags.length > position) {
        const name = openTags.pop()!;
        const entries = positionsByTag.get(name)!;
        entries.pop();
        if (entries.length === 0) positionsByTag.delete(name);
      }
    },
    onEof: () => {},
    onCharacter: () => {},
    onNullCharacter: () => {},
    onWhitespaceCharacter: () => {},
  };
  tokenizer = new Tokenizer({}, handler);
  tokenizer.write(text, true);
  return exceeded;
}

function initialCounts(): HtmlStructureCounts {
  return {
    rendererRootCount: 1,
    headingCount: 0,
    tableCount: 0,
    listCount: 0,
    imageCount: 0,
    canvasCount: 0,
    externalImageCount: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function elementDetails(
  node: unknown,
): { readonly tagName: string; readonly attrs: readonly HtmlAttribute[] } | null {
  if (!isRecord(node) || typeof node.tagName !== "string" || !Array.isArray(node.attrs))
    return null;
  const attrs: HtmlAttribute[] = [];
  for (const attribute of node.attrs) {
    if (
      !isRecord(attribute) ||
      typeof attribute.name !== "string" ||
      typeof attribute.value !== "string"
    ) {
      continue;
    }
    attrs.push({ name: attribute.name, value: attribute.value });
  }
  return { tagName: node.tagName.toLowerCase(), attrs };
}

function childNodes(node: unknown): readonly unknown[] {
  return isRecord(node) && Array.isArray(node.childNodes) ? node.childNodes : [];
}

function templateContent(node: unknown): unknown | null {
  return isRecord(node) && isRecord(node.content) ? node.content : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol.toLowerCase() === "https:";
  } catch {
    return false;
  }
}

function isWhitespace(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r" ||
    character === "\f"
  );
}

function srcsetCandidates(value: string): readonly string[] {
  const candidates: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && (value[index] === "," || isWhitespace(value[index]!)))
      index += 1;
    if (index >= value.length) break;
    const start = index;
    while (index < value.length && !isWhitespace(value[index]!)) index += 1;
    let candidate = value.slice(start, index);
    while (candidate.endsWith(",")) candidate = candidate.slice(0, -1);
    if (candidate.length > 0) candidates.push(candidate);
    while (index < value.length && isWhitespace(value[index]!)) index += 1;
    while (index < value.length && value[index] !== ",") index += 1;
    if (value[index] === ",") index += 1;
  }
  return candidates;
}

function addError(errors: DiscriminativeError[], code: string, message: string): void {
  errors.push({ code, message });
}

function validateUrl(
  tagName: string,
  attributeName: string,
  value: string,
  counts: HtmlStructureCounts,
  errors: DiscriminativeError[],
  countStructure: boolean,
): void {
  const candidates = attributeName === "srcset" ? srcsetCandidates(value) : [value];
  for (const candidate of candidates) {
    if (!isAllowedHtmlUrl(tagName, attributeName, candidate)) {
      addError(
        errors,
        "html_denied_url_scheme",
        `HTML <${tagName}> ${attributeName} contains a denied URL: ${candidate}`,
      );
      continue;
    }
    if (countStructure && (tagName === "img" || tagName === "source") && isHttpsUrl(candidate)) {
      counts.externalImageCount += 1;
    }
  }
}

function walk(root: unknown, counts: HtmlStructureCounts, errors: DiscriminativeError[]): void {
  const stack: Array<{ readonly node: unknown; readonly countStructure: boolean }> = [
    { node: root, countStructure: true },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const element = elementDetails(current.node);
    if (element !== null) {
      const { tagName, attrs } = element;
      if (isHtmlDeniedElement(tagName)) {
        addError(errors, "html_denied_element", `HTML contains denied <${tagName}> element`);
      }
      if (
        current.countStructure &&
        (HTML_STRUCTURAL_GROUPS.headings as readonly string[]).includes(tagName)
      )
        counts.headingCount += 1;
      if (
        current.countStructure &&
        (HTML_STRUCTURAL_GROUPS.tables as readonly string[]).includes(tagName)
      )
        counts.tableCount += 1;
      if (
        current.countStructure &&
        (HTML_STRUCTURAL_GROUPS.lists as readonly string[]).includes(tagName)
      )
        counts.listCount += 1;
      if (
        current.countStructure &&
        (HTML_STRUCTURAL_GROUPS.images as readonly string[]).includes(tagName)
      )
        counts.imageCount += 1;
      if (
        current.countStructure &&
        (HTML_STRUCTURAL_GROUPS.canvases as readonly string[]).includes(tagName)
      )
        counts.canvasCount += 1;
      for (const attribute of attrs) {
        const name = attribute.name.toLowerCase();
        if (isHtmlEventHandlerAttribute(name) || isHtmlInlineStyleAttribute(name)) {
          addError(
            errors,
            "html_denied_attribute",
            `HTML <${tagName}> contains denied ${name} attribute`,
          );
          continue;
        }
        if (isHtmlUrlBearingAttribute(tagName, name)) {
          validateUrl(tagName, name, attribute.value, counts, errors, current.countStructure);
          continue;
        }
        if (isHtmlUrlAttributeName(name)) {
          addError(
            errors,
            "html_denied_url_scheme",
            `HTML <${tagName}> ${name} is not an allowed URL-bearing attribute`,
          );
        }
      }
      if (tagName === "template") {
        const content = templateContent(current.node);
        if (content !== null) stack.push({ node: content, countStructure: false });
      }
    }
    const children = childNodes(current.node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], countStructure: current.countStructure });
    }
  }
}

export function parseHtml(bytes: Uint8Array): HtmlParseResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const html = initialCounts();
    return {
      status: "error",
      html,
      errors: [
        {
          code: "html_encoding_unsupported",
          message: "HTML bytes are not valid UTF-8",
        },
      ],
    };
  }
  const html = initialCounts();
  if (exceedsHtmlNestingDepth(text)) {
    return {
      status: "error",
      html,
      errors: [
        {
          code: "html_nesting_depth_exceeded",
          message: `HTML nesting exceeds the ${MAX_HTML_NESTING_DEPTH} element limit`,
        },
      ],
    };
  }
  const recovery = detectUnsupportedRecoveryFamilies(text);
  if (recovery !== null) {
    return {
      status: "error",
      html,
      errors: [
        {
          code: "html_recovery_unsupported",
          message: recovery,
        },
      ],
    };
  }
  const errors: DiscriminativeError[] = [];
  walk(parse(text, { scriptingEnabled: false }), html, errors);
  return errors.length === 0 ? { status: "ok", html } : { status: "error", html, errors };
}

/**
 * Lexical probe for constructs whose recovery behaviour the parse5 prediction
 * cannot guarantee against Chromium's DOMParser. Returns the rejection message
 * for the FIRST unsupported construct found, or null if the bytes survive.
 *
 * Today the only sanctioned reject is the `<select>` family: parse5 drops
 * table-scoped markup inside select (the WHATWG "in select in table" mode
 * keeps it on Chromium). Shrinking the accepted input set here is cheaper
 * than guaranteeing agreement on a niche construct static HTML reports do
 * not actually need.
 */
function detectUnsupportedRecoveryFamilies(text: string): string | null {
  const lower = text.toLowerCase();
  const selectAt = lower.indexOf("<select");
  if (selectAt >= 0 && !textContainsUnrecoverableSelect(lower, selectAt)) {
    // A bare <select> with no table-scoped markup inside is fine; we
    // only reject the family when it would actually trigger the
    // divergent recovery branch.
    return null;
  }
  if (selectAt >= 0) {
    return "HTML <select> with table-scoped markup diverges from Chromium DOMParser";
  }
  return null;
}

const TABLE_INSIDE_SELECT_TAGS = [
  "<table",
  "<tr",
  "<td",
  "<th",
  "<tbody",
  "<thead",
  "<tfoot",
  "<caption",
  "<colgroup",
  "<col ",
  "<col>",
] as const;

function textContainsUnrecoverableSelect(lower: string, selectAt: number): boolean {
  const closeAt = lower.indexOf("</select", selectAt);
  const end = closeAt < 0 ? lower.length : closeAt;
  for (const tag of TABLE_INSIDE_SELECT_TAGS) {
    if (lower.indexOf(tag, selectAt) >= 0 && lower.indexOf(tag, selectAt) < end) return true;
  }
  return false;
}
