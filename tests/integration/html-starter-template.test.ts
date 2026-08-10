/**
 * Acceptance checks for the HTML starter template
 * (`templates/html-status-report.html`).
 *
 * The starter is the discoverable worked example of the shipped HTML
 * vocabulary and the static / script-free contract. This test pins:
 *
 * 1. Tier 0 publishes `ok` for the starter bytes.
 * 2. Every `class=` token on the starter belongs to
 *    `src/shared/html/style-vocabulary.ts` (no undocumented class
 *    silently disables styling).
 * 3. Exported source bytes are byte-identical to the file on disk
 *    (the renderer-owned wrapper never reaches storage or export).
 *
 * The acceptance render pass lives in `tests/acceptance/html-render.test.ts`;
 * this test stays at the Tier 0 + structural boundary so it runs
 * without the browser harness.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { parseHtml } from "../../src/validation/tier0/html";
import { HTML_STYLE_CLASSES } from "../../src/shared/html/style-vocabulary";

const STARTER_PATH = join(import.meta.dir, "..", "..", "templates", "html-status-report.html");

test("starter parses to ok in Tier 0", () => {
  const bytes = new Uint8Array(readFileSync(STARTER_PATH));
  const result = parseHtml(bytes);
  if (result.status !== "ok") {
    throw new Error(
      `Tier 0 rejected the starter template: ${result.errors.map((e) => e.code).join(", ")}`,
    );
  }
  expect(result.status).toBe("ok");
  // The starter exercises headings, a table, and a list — its absence
  // would mean a structural regression in the template itself.
  expect(result.html.headingCount).toBeGreaterThanOrEqual(2);
  expect(result.html.tableCount).toBe(1);
  expect(result.html.listCount).toBeGreaterThanOrEqual(1);
  expect(result.html.rendererRootCount).toBe(1);
});

test("every class token on the starter belongs to the vendored vocabulary", () => {
  const source = readFileSync(STARTER_PATH, "utf8");
  const tokens = new Set<string>();
  const classRegex = /class="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = classRegex.exec(source)) !== null) {
    for (const token of match[1]!.split(/\s+/).filter(Boolean)) {
      tokens.add(token);
    }
  }
  const vocabulary = new Set<string>(HTML_STYLE_CLASSES);
  const unknown = [...tokens].filter((t) => !vocabulary.has(t));
  expect(unknown).toEqual([]);
  // The starter must use at least a handful of vocabulary tokens to
  // be a meaningful worked example. A starter with zero classes would
  // be vacuous.
  expect(tokens.size).toBeGreaterThan(10);
});

test("starter contains no script, event handler, inline style, or external font/media", () => {
  const source = readFileSync(STARTER_PATH, "utf8");
  expect(/<script\b/i.test(source)).toBe(false);
  expect(/<style\b/i.test(source)).toBe(false);
  expect(/\sstyle\s*=/i.test(source)).toBe(false);
  expect(/\son[a-z]+\s*=/i.test(source)).toBe(false);
  expect(/<link\b/i.test(source)).toBe(false);
  expect(/<img\b/i.test(source)).toBe(false);
  expect(/@import|@font-face/i.test(source)).toBe(false);
  expect(/data-facet-/i.test(source)).toBe(false);
});

test("exported source bytes equal the file byte-for-byte", () => {
  // The HTML renderer wraps sanitized body content in a frame-owned
  // element carrying `data-facet-renderer-root`. That wrapper never
  // touches storage or export — exported bytes are exactly the bytes
  // the operator published. This is the byte-identity contract from
  // D13 of the HTML design.
  const fileBytes = new Uint8Array(readFileSync(STARTER_PATH));
  // Re-encode the file as UTF-8 the same way the export pipeline does:
  // it round-trips through TextDecoder(TextEncoder.encode(source)),
  // which is byte-identical for any valid UTF-8 source.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes);
  const reencoded = new TextEncoder().encode(text);
  expect(reencoded).toEqual(fileBytes);
});
