/**
 * Vocabulary drift guard for `docs/reference/html.md`.
 *
 * The reference doc publishes recommended Tailwind utilities and daisyUI
 * components. The vendored stylesheet is broader: all daisyUI components
 * plus a deterministic Tailwind utility corpus ship offline.
 *
 * Why generated, not hand-maintained: a hand-copied second list drifts.
 * This repo has hit that drift three times across separate passes
 * (the SVG sanitizer, the mermaid block counter, and the chart theme).
 * Every class addition or removal in the source MUST update the doc.
 *
 * To update the doc after editing `style-vocabulary.ts`, copy the
 * `expectedVocabularyMarkdown` string from this test's failure
 * message into the `<!-- VOCABULARY:START --> ... <!-- VOCABULARY:END -->`
 * block in `docs/reference/html.md`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  HTML_DAISY_COMPONENTS,
  HTML_STYLE_CLASSES_DISTINCT,
  HTML_TAILWIND_BUILD_CLASSES,
  HTML_TAILWIND_CLASSES,
} from "../../src/shared/html/style-vocabulary";

const DOC_PATH = join(import.meta.dir, "..", "..", "docs", "reference", "html.md");

const VOCABULARY_MARKER_START = "<!-- VOCABULARY:START -->";
const VOCABULARY_MARKER_END = "<!-- VOCABULARY:END -->";

function renderVocabularyMarkdown(): string {
  const tailwind = [...HTML_TAILWIND_CLASSES].map((name) => `\`${name}\``).join(", ");
  const daisy = [...HTML_DAISY_COMPONENTS].map((name) => `\`${name}\``).join(", ");
  // Use the DISTINCT set so the published count reflects unique classes
  // shipped, not the concatenation. `table` is in both arrays — counting
  // it twice would mis-publish a count that disagrees with the actual
  // ship.
  const total = HTML_STYLE_CLASSES_DISTINCT.length;
  const twCount = HTML_TAILWIND_CLASSES.length;
  const dzCount = HTML_DAISY_COMPONENTS.length;
  return [
    "### Recommended Tailwind utilities",
    "",
    `${tailwind}.`,
    "",
    `${twCount} recommended utilities.`,
    "",
    "### Recommended daisyUI components",
    "",
    `${daisy}.`,
    "",
    `${dzCount} recommended components · ${total} documented recommendations.`,
  ].join("\n");
}

test("docs/reference/html.md recommendations match src/shared/html/style-vocabulary.ts", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const startIndex = doc.indexOf(VOCABULARY_MARKER_START);
  const endIndex = doc.indexOf(VOCABULARY_MARKER_END);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);

  const expected = renderVocabularyMarkdown();
  const rawBlock = doc.slice(startIndex + VOCABULARY_MARKER_START.length, endIndex);
  // The formatter may insert blank lines after the markers; normalize
  // by trimming leading and trailing whitespace plus any immediately
  // adjacent blank lines that the formatter introduced.
  const block = rawBlock.replace(/^\s*\n/, "").replace(/\n\s*$/, "");
  if (block !== expected) {
    throw new Error(
      `docs/reference/html.md recommendation block drifted from src/shared/html/style-vocabulary.ts.\n` +
        `Replace the block between the VOCABULARY markers with:\n\n${expected}`,
    );
  }
});

test("Tailwind build corpus contains every documented utility", () => {
  const buildClasses = new Set<string>(HTML_TAILWIND_BUILD_CLASSES);
  for (const name of HTML_TAILWIND_CLASSES) expect(buildClasses.has(name)).toBe(true);
  expect(buildClasses.size).toBeGreaterThan(200);
});

test("recommendations contain both documented families", () => {
  const tailwindCount: number = HTML_TAILWIND_CLASSES.length;
  const daisyCount: number = HTML_DAISY_COMPONENTS.length;
  expect(tailwindCount).toBeGreaterThan(20);
  expect(daisyCount).toBeGreaterThanOrEqual(3);
});
