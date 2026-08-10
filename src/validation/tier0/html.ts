import { parse } from "parse5";

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
  const errors: DiscriminativeError[] = [];
  walk(parse(text), html, errors);
  return errors.length === 0 ? { status: "ok", html } : { status: "error", html, errors };
}
