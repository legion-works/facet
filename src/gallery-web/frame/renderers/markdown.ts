/**
 * Markdown renderer — Marked with raw HTML treated as DATA.
 *
 * Marked passes raw HTML tokens through to the output BY DEFAULT. The
 * renderer override escapes them at TOKEN level — before any HTML is
 * attached to the DOM — so raw `<script>`, `<img onerror=…>`, inline
 * handlers, and iframes remain VISIBLE TEXT. Sanitize-after-insert is
 * too late (the parser already ran); the frame CSP is the backstop.
 *
 * Fenced ```mermaid blocks are delegated to the real mermaid renderer
 * and their `<pre>` is replaced by the sanitized SVG; the markdown
 * render only resolves after every embedded diagram promise settles.
 */

import { Marked } from "marked";

import { type RenderContext, decodeArtifactBytes } from "./registry";
import { renderMermaidInto } from "./mermaid";

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES.get(char) ?? char);
}

/**
 * Instance-scoped Marked: the html-token override escapes raw HTML
 * (block AND inline) so no raw-HTML token can ever create an element.
 */
const marked = new Marked({
  gfm: true,
  renderer: {
    html(token) {
      return escapeHtml(token.text);
    },
  },
});

/**
 * Pure stage: markdown text → HTML string with raw-HTML tokens
 * escaped at TOKEN level. No DOM — testable without a browser.
 */
export async function markdownToSanitizedHtml(text: string): Promise<string> {
  return await Promise.resolve(marked.parse(text));
}

/**
 * Render a markdown artifact. The HTML is assembled in a detached
 * `<template>`, every mermaid fence is awaited and replaced by its
 * sanitized SVG, and only then does the fragment cross into the live
 * container — one attach, after all diagram promises settle.
 */
export async function renderMarkdown(ctx: RenderContext, bytes: Uint8Array): Promise<void> {
  const text = decodeArtifactBytes(bytes);
  const html = await markdownToSanitizedHtml(text);
  const template = document.createElement("template");
  template.innerHTML = html;
  const mermaidBlocks = Array.from(
    template.content.querySelectorAll("pre > code.language-mermaid"),
  );
  for (const code of mermaidBlocks) {
    const source = code.textContent ?? "";
    const pre = code.parentElement;
    if (pre === null) continue;
    // Render into a scratch holder so the SVG lands where the <pre>
    // was, then move it into the template fragment.
    const scratch = document.createElement("div");
    await renderMermaidInto(scratch, source);
    const svg = scratch.firstElementChild;
    if (svg !== null) pre.replaceWith(svg);
    else pre.remove();
  }
  ctx.container.appendChild(template.content);
}
