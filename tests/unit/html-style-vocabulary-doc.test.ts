/**
 * Vocabulary drift guard for `docs/reference/html.md`.
 *
 * The reference doc publishes the exact Tailwind utility and daisyUI
 * component vocabulary the HTML frame renders. The single source of
 * truth is `src/shared/html/style-vocabulary.ts`; this test generates
 * the expected markdown for the doc's vocabulary block from that file
 * and asserts the doc matches it byte-for-byte.
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
    "### Tailwind utilities",
    "",
    `${tailwind}.`,
    "",
    `${twCount} utilities in total.`,
    "",
    "### daisyUI components",
    "",
    `${daisy}.`,
    "",
    `${dzCount} components in total · ${total} classes shipped across both arrays.`,
  ].join("\n");
}

test("docs/reference/html.md vocabulary matches src/shared/html/style-vocabulary.ts", () => {
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
      `docs/reference/html.md vocabulary block drifted from src/shared/html/style-vocabulary.ts.\n` +
        `Replace the block between the VOCABULARY markers with:\n\n${expected}`,
    );
  }
});

test("vocabulary dedup pins the exact duplicate set (catches second-duplicate regressions)", () => {
  // A guard that only checks `totalCount ≤ tailwindCount + daisyCount`
  // is a tautology — it is ALWAYS true and cannot catch a second
  // duplicate. The durable guard is the actual set of classes that
  // appear in BOTH arrays: that set must equal exactly the known
  // duplicates. Adding a second class to both arrays (e.g.
  // duplicating `border`) makes this test fail BEFORE any doc
  // regeneration, catching the regression at the source.
  const tailwindSet = new Set<string>(HTML_TAILWIND_CLASSES);
  const daisySet = new Set<string>(HTML_DAISY_COMPONENTS);
  const duplicates: string[] = [];
  for (const name of tailwindSet) {
    if (daisySet.has(name)) duplicates.push(name);
  }
  duplicates.sort();
  expect(duplicates).toEqual(["table"]);
});

test("vocabulary contains at least one class per shipped family", () => {
  // Sanity checks — a vocabulary with zero classes would be vacuous
  // and a vocabulary with only one family would be incomplete.
  const tailwindCount: number = HTML_TAILWIND_CLASSES.length;
  const daisyCount: number = HTML_DAISY_COMPONENTS.length;
  expect(tailwindCount).toBeGreaterThan(20);
  expect(daisyCount).toBeGreaterThanOrEqual(3);
});
