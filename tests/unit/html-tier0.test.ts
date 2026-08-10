import { describe, expect, test } from "bun:test";

import { parseHtml } from "../../src/validation/tier0/html";

function bytes(source: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(source));
}

function errorCodes(source: string): readonly string[] {
  const result = parseHtml(bytes(source));
  return result.status === "error" ? result.errors.map((error) => error.code) : [];
}

describe("HTML Tier 0 parser", () => {
  test("predicts structural counts after document and fragment recovery", () => {
    const source = [
      "<!doctype html><title>Recovered</title>",
      "<h1>one<h2>two",
      "<table><div>fostered</div><tr><td>cell<table><tr><td>nested</table>",
      "<ul><li>one<li>two</ul><ol><li>three</ol>",
      '<img src="/local.png"><img src="https://cdn.example/image.png">',
      "<canvas></canvas>",
    ].join("");

    expect(parseHtml(bytes(source))).toEqual({
      status: "ok",
      html: {
        rendererRootCount: 1,
        headingCount: 2,
        tableCount: 2,
        listCount: 2,
        imageCount: 2,
        canvasCount: 1,
        externalImageCount: 1,
      },
    });
  });

  test("permits semantic HTML that is not in the structural count groups", () => {
    const result = parseHtml(
      bytes(
        "<details><summary>More</summary><figure><figcaption>Caption</figcaption><mark>mark</mark><time>now</time><abbr>HTML</abbr></figure></details>",
      ),
    );

    expect(result.status).toBe("ok");
    expect(result.html).toMatchObject({
      rendererRootCount: 1,
      headingCount: 0,
      tableCount: 0,
      listCount: 0,
      imageCount: 0,
      canvasCount: 0,
      externalImageCount: 0,
    });
  });

  test.each(["script", "iframe", "object", "embed", "form", "link", "meta", "base", "style"])(
    "rejects %s elements",
    (element) => {
      expect(errorCodes(`<${element}></${element}>`)).toContain("html_denied_element");
    },
  );

  test.each(["onclick", "ONCLICK", "onClick", "style"])(
    "rejects %s attributes regardless of source casing",
    (attribute) => {
      expect(errorCodes(`<button ${attribute}="x">button</button>`)).toContain(
        "html_denied_attribute",
      );
    },
  );

  test("allows data, relative, and HTTPS image URLs while counting HTTPS candidates", () => {
    const result = parseHtml(
      bytes(
        '<img src="data:image/png;base64,AAA"><img src="images/local.png"><img srcset="https://cdn.example/one.png 1x, https://cdn.example/two.png 2x">',
      ),
    );

    expect(result).toEqual({
      status: "ok",
      html: {
        rendererRootCount: 1,
        headingCount: 0,
        tableCount: 0,
        listCount: 0,
        imageCount: 3,
        canvasCount: 0,
        externalImageCount: 2,
      },
    });
  });

  test.each([
    '<img src="http://example.test/image.png">',
    '<img src="//example.test/image.png">',
    '<img src="javascript:alert(1)">',
    '<a href="javascript:alert(1)">bad</a>',
    '<video src="https://example.test/movie.mp4"></video>',
  ])("rejects disallowed URL-bearing markup: %s", (source) => {
    expect(errorCodes(source)).toContain("html_denied_url_scheme");
  });

  test("checks every srcset candidate rather than accepting a safe prefix", () => {
    expect(
      errorCodes('<img srcset="data:image/png;base64,AAA 1x, javascript:alert(1) 2x">'),
    ).toContain("html_denied_url_scheme");
  });

  test("returns a typed encoding error for invalid UTF-8 without modifying the artifact bytes", () => {
    const source = new Uint8Array([0x3c, 0x68, 0x31, 0x3e, 0xff, 0x3c, 0x2f, 0x68, 0x31, 0x3e]);
    const before = Array.from(source);

    expect(parseHtml(source)).toMatchObject({
      status: "error",
      errors: [{ code: "html_encoding_unsupported" }],
    });
    expect(Array.from(source)).toEqual(before);
  });
});
