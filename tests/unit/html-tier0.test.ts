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

  test("rejects denied elements nested inside template contents", () => {
    expect(errorCodes("<template><script>alert(1)</script></template>")).toContain(
      "html_denied_element",
    );
  });

  test("inspects template contents without counting their unrendered structure", () => {
    expect(parseHtml(bytes('<template><img src="x.png"><h1>t</h1></template>'))).toEqual({
      status: "ok",
      html: {
        rendererRootCount: 1,
        headingCount: 0,
        tableCount: 0,
        listCount: 0,
        imageCount: 0,
        canvasCount: 0,
        externalImageCount: 0,
      },
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

  test.each([
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "java\rscript:alert(1)",
    " \tJaVa\nScRiPt:alert(1)\r ",
    "java&#10;script:alert(1)",
  ])("rejects canonicalized executable href schemes: %s", (href) => {
    expect(errorCodes(`<a href="${href}">bad</a>`)).toContain("html_denied_url_scheme");
  });

  test("permits picture source srcset candidates and counts external image candidates", () => {
    expect(
      parseHtml(
        bytes(
          '<picture><source srcset="images/local.png 1x, https://cdn.example/two.png 2x"><img src="fallback.png"></picture>',
        ),
      ),
    ).toEqual({
      status: "ok",
      html: {
        rendererRootCount: 1,
        headingCount: 0,
        tableCount: 0,
        listCount: 0,
        imageCount: 1,
        canvasCount: 0,
        externalImageCount: 1,
      },
    });
  });

  test("rejects non-image data media types", () => {
    expect(errorCodes('<img src="data:text/html;base64,PHNjcmlwdD4=">')).toContain(
      "html_denied_url_scheme",
    );
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

  test("returns a typed verdict before parsing documents beyond the nesting budget", () => {
    const depth = 10_001;
    const source = `${"<div>".repeat(depth)}safe${"</div>".repeat(depth)}`;

    expect(parseHtml(bytes(source))).toMatchObject({
      status: "error",
      errors: [{ code: "html_nesting_depth_exceeded" }],
    });
  });

  test("rejects <select> containing table-scoped markup as an unrecoverable family", () => {
    const source =
      "<select><option>a</option>" +
      "<table><tbody><tr><td>b</td></tr></tbody></table>" +
      "</select>";
    expect(errorCodes(source)).toContain("html_recovery_unsupported");
  });

  test("permits bare <select> without table-scoped markup (no divergence to recover)", () => {
    const source = "<select><option>a</option><option>b</option></select>";
    expect(errorCodes(source)).toEqual([]);
  });

  test("parses <noscript> content as elements under scriptingEnabled=false", () => {
    // Chromium's DOMParser parses noscript content as elements (scripting
    // disabled). parse5 must do the same or the prediction diverges from
    // observation — which is exactly D11's false-tampered risk.
    const source = "<noscript><h1>fallback heading</h1><p>fallback body</p></noscript>";
    const result = parseHtml(bytes(source));
    expect(result.status).toBe("ok");
    expect(result.html.headingCount).toBe(1);
  });

  // The 9 reviewer's cases for the tokenizer-based <select> detector.
  // Each must REJECT (case 1) or ACCEPT (cases 2-9) per the reviewer's
  // measured behavior in production. A regression to the lexical scan
  // fails cases 1, 4, 5 (false negatives) or 6, 7, 8, 9 (false positives).

  test("REJECTS two-selects with table markup inside the second select", () => {
    const source =
      "<select><option>a</option></select><select><table><tr><td>x</td></tr></table></select>";
    expect(errorCodes(source)).toContain("html_recovery_unsupported");
  });

  test("ACCEPTS <select> inside an HTML comment (text, not a tag)", () => {
    const source = "<p><!-- <select><table>x</table></select> --></p>";
    expect(errorCodes(source)).toEqual([]);
  });

  test("ACCEPTS <select> inside a double-quoted attribute value", () => {
    const source = '<div data-x="<select><table>x</table></select>">safe</div>';
    expect(errorCodes(source)).toEqual([]);
  });

  test("ACCEPTS <select> inside a single-quoted attribute value", () => {
    const source = "<div data-x='<select><table>x</table></select>'>safe</div>";
    expect(errorCodes(source)).toEqual([]);
  });

  test("ACCEPTS <select> inside <textarea> RCDATA content", () => {
    const source = "<textarea><select><table><tr><td>x</td></tr></table></select></textarea>";
    expect(errorCodes(source)).toEqual([]);
  });

  test("ACCEPTS <select> inside <title> RCDATA content", () => {
    const source =
      "<head><title><select><table><tr><td>x</td></tr></table></select></title></head>";
    expect(errorCodes(source)).toEqual([]);
  });

  test("ACCEPTS <select> inside <xmp> RAWTEXT content", () => {
    const source = "<xmp><select><table><tr><td>x</td></tr></table></select></xmp>";
    expect(errorCodes(source)).toEqual([]);
  });

  test("REJECTS <select> with table markup inside <noscript> (scripting disabled)", () => {
    // Under `scriptingEnabled: false` a <noscript> body is normal markup, not
    // raw text, so the divergent select recovery is reachable inside it.
    const source = "<noscript><select><table><tr><td>x</td></tr></table></select></noscript>";
    expect(errorCodes(source)).toEqual(["html_recovery_unsupported"]);
  });

  test("ACCEPTS a clean <select> inside <noscript>", () => {
    const source = "<noscript><select><option>a</option></select></noscript>";
    expect(errorCodes(source)).toEqual([]);
  });

  test("ACCEPTS a table inside <noscript> with no <select>", () => {
    const source = "<noscript><table><tr><td>x</td></tr></table></noscript>";
    expect(errorCodes(source)).toEqual([]);
  });
});
