import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  computeLexicalExpectations,
  countFencedBlocks,
  countMermaidBlocks,
} from "../../src/service/lexical/expectations";

const FIXTURES = {
  adversarial: `${import.meta.dir}/../fixtures/adversarial-md-mermaid.md`,
  hostileSvg: `${import.meta.dir}/../fixtures/hostile-svg-label.md`,
  rawHtml: `${import.meta.dir}/../fixtures/markdown-raw-html.md`,
};

function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

describe("countFencedBlocks — real fixtures", () => {
  test("adversarial-md-mermaid.md has exactly two ```mermaid fenced blocks", () => {
    const bytes = readBytes(FIXTURES.adversarial);
    expect(countFencedBlocks(bytes).total).toBe(2);
    expect(countMermaidBlocks(bytes)).toBe(2);
  });

  test("hostile-svg-label.md has exactly one ```mermaid fenced block", () => {
    const bytes = readBytes(FIXTURES.hostileSvg);
    expect(countFencedBlocks(bytes).total).toBe(1);
    expect(countMermaidBlocks(bytes)).toBe(1);
  });

  test("markdown-raw-html.md has zero fenced blocks", () => {
    const bytes = readBytes(FIXTURES.rawHtml);
    expect(countFencedBlocks(bytes).total).toBe(0);
    expect(countMermaidBlocks(bytes)).toBe(0);
  });
});

describe("countFencedBlocks — language exact-match semantics", () => {
  test("info string is trimmed and matched case-sensitively against 'mermaid'", () => {
    const bytes = new TextEncoder().encode(
      [
        "```mermaid",
        "graph TD",
        "  A --> B",
        "```",
        "",
        "```   Mermaid   ",
        "graph TD",
        "  C --> D",
        "```",
        "",
        "```MERMAID",
        "graph TD",
        "  E --> F",
        "```",
      ].join("\n"),
    );
    // only the first block is a mermaid block — "   Mermaid   " is case-sensitive trimmed,
    // and the third is uppercase and not counted
    expect(countFencedBlocks(bytes).total).toBe(3);
    expect(countMermaidBlocks(bytes)).toBe(1);
  });

  test("non-mermaid languages are counted as fenced blocks but not as mermaid", () => {
    const bytes = new TextEncoder().encode(
      ["```typescript", "const x = 1;", "```", "", "```json", '{ "a": 1 }', "```"].join("\n"),
    );
    expect(countFencedBlocks(bytes).total).toBe(2);
    expect(countMermaidBlocks(bytes)).toBe(0);
  });
});

describe("countFencedBlocks — tilde fence support", () => {
  test("~~~ fenced mermaid blocks are counted the same as ``` fenced ones", () => {
    const bytes = new TextEncoder().encode(
      [
        "~~~mermaid",
        "graph TD",
        "  A --> B",
        "~~~",
        "",
        "```mermaid",
        "graph TD",
        "  C --> D",
        "```",
      ].join("\n"),
    );
    expect(countFencedBlocks(bytes).total).toBe(2);
    expect(countMermaidBlocks(bytes)).toBe(2);
  });

  test("~~~ info strings are trimmed and matched case-sensitively", () => {
    const bytes = new TextEncoder().encode(
      [
        "~~~  mermaid  ",
        "graph TD",
        "  A --> B",
        "~~~",
        "",
        "~~~MERMAID",
        "graph TD",
        "  C --> D",
        "~~~",
      ].join("\n"),
    );
    expect(countMermaidBlocks(bytes)).toBe(1);
  });
});

describe("countFencedBlocks — non-fence edge cases", () => {
  test("four-space-indented ``` is an indented code block, not a fence", () => {
    const bytes = new TextEncoder().encode(
      ["    ```mermaid", "    graph TD", "      A --> B", "    ```"].join("\n"),
    );
    expect(countFencedBlocks(bytes).total).toBe(0);
    expect(countMermaidBlocks(bytes)).toBe(0);
  });

  test("unterminated fence is not counted", () => {
    const bytes = new TextEncoder().encode(["```mermaid", "graph TD", "  A --> B"].join("\n"));
    expect(countFencedBlocks(bytes).total).toBe(0);
    expect(countMermaidBlocks(bytes)).toBe(0);
  });

  test("text that contains backticks but is not a fence is ignored", () => {
    const bytes = new TextEncoder().encode(
      [
        "Inline code: `not a fence`",
        "",
        "Single line: ``` no closing fence on this line",
        "Continuation of paragraph text.",
      ].join("\n"),
    );
    expect(countFencedBlocks(bytes).total).toBe(0);
    expect(countMermaidBlocks(bytes)).toBe(0);
  });

  test("a fence whose body contains backticks is still recognized", () => {
    const bytes = new TextEncoder().encode(
      [
        "```markdown",
        "The body of this block contains ``` nested backticks.",
        "Still in the fence.",
        "```",
      ].join("\n"),
    );
    // The inner ``` is bare (no info string), so it is body content of
    // the outer fence (not a closer) and the outer fence is closed by
    // the final bare ```.
    const { total, byLanguage } = countFencedBlocks(bytes);
    expect(total).toBe(1);
    expect(byLanguage.get("markdown")).toBe(1);
  });
});

describe("countFencedBlocks — CommonMark closer semantics", () => {
  test("fence-in-fence: an inner ```mermaid line inside an outer ```mermaid body does NOT close the outer fence (one block, not two)", () => {
    const bytes = new TextEncoder().encode(
      ["```mermaid", "graph TD", "  A --> B", "```mermaid", "graph TD", "  C --> D", "```"].join(
        "\n",
      ),
    );
    // The inner ```mermaid carries an info string, so it is not a
    // valid closer per CommonMark. The outer fence stays open and is
    // closed by the final bare ```. Exactly one closed mermaid block.
    expect(countFencedBlocks(bytes).total).toBe(1);
    expect(countMermaidBlocks(bytes)).toBe(1);
  });

  test("a closer that carries an info string is treated as content, not as a closer", () => {
    const bytes = new TextEncoder().encode(
      ["```mermaid", "graph TD", "  A --> B", "```mermaid"].join("\n"),
    );
    // The only ```mermaid line after the opener is the closer — but
    // it has an info string and is not a valid closer per CommonMark.
    // No closer exists, so the fence is unterminated and counts as 0.
    expect(countFencedBlocks(bytes).total).toBe(0);
    expect(countMermaidBlocks(bytes)).toBe(0);
  });

  test("a bare ``` line inside a ```mermaid body DOES close the outer fence (closer is whitespace-only)", () => {
    const bytes = new TextEncoder().encode(
      ["```mermaid", "graph TD", "  A --> B", "```"].join("\n"),
    );
    expect(countFencedBlocks(bytes).total).toBe(1);
    expect(countMermaidBlocks(bytes)).toBe(1);
  });

  test("a closer with trailing whitespace (no info string) IS a valid closer", () => {
    const bytes = new TextEncoder().encode(
      ["```mermaid", "graph TD", "  A --> B", "```   "].join("\n"),
    );
    expect(countFencedBlocks(bytes).total).toBe(1);
    expect(countMermaidBlocks(bytes)).toBe(1);
  });
});

describe("computeLexicalExpectations — public shape", () => {
  test("returns total + per-language + expected renderer root count for mermaid", () => {
    const bytes = readBytes(FIXTURES.adversarial);
    const expectations = computeLexicalExpectations(bytes);
    expect(expectations.totalFencedBlocks).toBe(2);
    expect(expectations.mermaidBlocks).toBe(2);
    expect(expectations.fencedBlocksByLanguage.get("mermaid")).toBe(2);
    // each mermaid block in adversarial fixture should produce one renderer root
    expect(expectations.expectedRendererRoots).toBe(2);
  });

  test("expected renderer root count is zero for fixture with no mermaid blocks", () => {
    const bytes = readBytes(FIXTURES.rawHtml);
    const expectations = computeLexicalExpectations(bytes);
    expect(expectations.totalFencedBlocks).toBe(0);
    expect(expectations.mermaidBlocks).toBe(0);
    expect(expectations.expectedRendererRoots).toBe(0);
  });
});
