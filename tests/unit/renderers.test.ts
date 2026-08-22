/**
 * Frame renderer unit tests — TDD gate for the four structured
 * renderers BEFORE the Tier 1 acceptance path exercises them in a
 * real frame.
 *
 * DOM surface: linkedom provides the structural DOM (DOMParser,
 * elements, importNode). The mermaid RENDER path is not exercised
 * here — it needs a real layout engine and is proven by the Tier 1
 * acceptance gates, which bundle the SAME renderers. These tests pin
 * everything that is pure or structural: the markdown raw-HTML escape,
 * the SVG sanitize-before-import strip set, the chart loader block +
 * zero-mark rule, and the registry dispatch contract.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";

// --- linkedom DOM shim (installed BEFORE the renderer modules load —
// mermaid performs import-time DOM checks) ---------------------------------
const { document: shimDocument, window: shimWindow } = parseHTML(
  "<!DOCTYPE html><html><body><main id='artifact'></main></body></html>",
);
const fakeImpl = {
  createHTMLDocument: (html: string): Document =>
    (parseHTML(html) as unknown as { document: Document }).document,
};
Object.defineProperty(shimDocument, "implementation", { value: fakeImpl, configurable: true });
const globals = globalThis as Record<string, unknown>;
globals["document"] = shimDocument;
globals["window"] = shimWindow;
globals["Element"] = shimWindow.Element;
globals["HTMLElement"] = shimWindow.HTMLElement;
globals["Node"] = shimWindow.Node;
globals["DocumentFragment"] = shimWindow.DocumentFragment;
globals["HTMLTemplateElement"] = shimWindow.HTMLTemplateElement;
const NODE_FILTER = {
  SHOW_ELEMENT: 1,
  SHOW_ATTRIBUTE: 2,
  SHOW_TEXT: 4,
  SHOW_CDATA_SECTION: 8,
  SHOW_ENTITY_REFERENCE: 16,
  SHOW_ENTITY: 32,
  SHOW_PROCESSING_INSTRUCTION: 64,
  SHOW_COMMENT: 128,
  SHOW_DOCUMENT: 256,
  SHOW_DOCUMENT_TYPE: 512,
  SHOW_DOCUMENT_FRAGMENT: 1024,
  SHOW_NOTATION: 2048,
  acceptNode: () => 1,
};
globals["NodeFilter"] = NODE_FILTER;
(shimWindow as unknown as Record<string, unknown>)["NodeFilter"] = NODE_FILTER;
globals["DOMParser"] = (shimWindow as unknown as Record<string, unknown>)["DOMParser"];
globals["MutationObserver"] = (shimWindow as unknown as Record<string, unknown>)[
  "MutationObserver"
];
class ShimCSSStyleSheet {
  cssRules: unknown[] = [];
  insertRule(): number {
    return 0;
  }
  deleteRule(): void {}
  replaceSync(): void {}
}
globals["CSSStyleSheet"] = ShimCSSStyleSheet;
(shimWindow as unknown as Record<string, unknown>)["CSSStyleSheet"] = ShimCSSStyleSheet;

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return new Proxy(
    {
      canvas,
      pixelRatio: 1,
      measureText: () => ({ width: 0 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => null,
      getImageData: () => ({ data: new Uint8ClampedArray() }),
    },
    {
      get(target, key) {
        return key in target ? target[key as keyof typeof target] : () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

Object.defineProperty(Object.getPrototypeOf(shimDocument.createElement("canvas")), "getContext", {
  value(this: HTMLCanvasElement) {
    return canvasContext(this);
  },
  configurable: true,
});

const FIXTURES = {
  rawHtml: `${import.meta.dir}/../fixtures/markdown-raw-html.md`,
  svgClean: `${import.meta.dir}/../fixtures/svg-clean.svg`,
  svgHostile: `${import.meta.dir}/../fixtures/svg-hostile-script.svg`,
  chartBarline: `${import.meta.dir}/../fixtures/chart-barline.vl.json`,
  chartExternal: `${import.meta.dir}/../fixtures/chart-external-data-rejected.vl.json`,
  chartZeroMarks: `${import.meta.dir}/../fixtures/chart-zero-marks.vl.json`,
};

function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function freshContainer(): HTMLElement {
  const el = shimDocument.createElement("div");
  shimDocument.body.appendChild(el);
  return el as unknown as HTMLElement;
}

const NOOP_RENDERER = async (): Promise<void> => {};

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Deferred imports — the shim above must be in place first.
let registry: typeof import("../../src/gallery-web/frame/renderers/registry");
let markdown: typeof import("../../src/gallery-web/frame/renderers/markdown");
let svg: typeof import("../../src/gallery-web/frame/renderers/svg");
let chart: typeof import("../../src/gallery-web/frame/renderers/chart");
let mermaid: typeof import("../../src/gallery-web/frame/renderers/mermaid");

beforeAll(async () => {
  registry = await import("../../src/gallery-web/frame/renderers/registry");
  markdown = await import("../../src/gallery-web/frame/renderers/markdown");
  svg = await import("../../src/gallery-web/frame/renderers/svg");
  chart = await import("../../src/gallery-web/frame/renderers/chart");
  mermaid = await import("../../src/gallery-web/frame/renderers/mermaid");
});

describe("markdown renderer — raw HTML is DATA, never elements", () => {
  test("raw HTML tokens are escaped BEFORE attach (script/img/handler/iframe stay visible text)", async () => {
    const text = new TextDecoder().decode(readBytes(FIXTURES.rawHtml));
    const html = await markdown.markdownToSanitizedHtml(text);
    // No raw-HTML token may survive as markup.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<a href");
    // The escaped forms are present — the raw HTML stays VISIBLE text.
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;iframe");
  });

  test("ordinary markdown still renders (headings, lists, fenced code)", async () => {
    const html = await markdown.markdownToSanitizedHtml(
      ["# Title", "", "- one", "- two", "", "```typescript", "const x = 1;", "```"].join("\n"),
    );
    expect(html).toContain("<h1");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain('class="language-typescript"');
  });

  test("renderMarkdown attaches the escaped document to the container", async () => {
    const container = freshContainer();
    await markdown.renderMarkdown(
      { container, theme: "dark" },
      new TextEncoder().encode("# Hi\n\n<script>alert(1)</script>"),
    );
    expect(container.querySelector("h1")).not.toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("svg renderer — sanitize BEFORE import", () => {
  test("reserved renderer markers are stripped from hostile SVG before the imported root is marked", async () => {
    const container = freshContainer();
    await svg.importSanitizedSvgText(
      container,
      [
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:hostile="urn:hostile" data-facet-renderer-root="true" hostile:data-facet-renderer-graph="true">',
        '<svg hostile:data-facet-renderer-root="true" hostile:data-facet-renderer-graph="true"/>',
        "</svg>",
      ].join(""),
      { settleMs: 0, maxWaitMs: 10 },
    );

    const imported = container.firstElementChild;
    expect(imported?.getAttribute("data-facet-renderer-root")).toBe("true");
    expect(imported?.getAttribute("data-facet-renderer-graph")).toBeNull();
    expect(
      Array.from(imported?.attributes ?? [])
        .filter((attr) => attr.name.includes(":data-facet-renderer-"))
        .map((attr) => ({ localName: attr.localName, name: attr.name })),
    ).toEqual([]);
    expect(imported?.querySelector("svg")?.getAttribute("data-facet-renderer-root")).toBeNull();
    expect(imported?.querySelector("svg")?.getAttribute("data-facet-renderer-graph")).toBeNull();
    expect(
      Array.from(imported?.querySelector("svg")?.attributes ?? [])
        .filter((attr) => attr.name.includes(":data-facet-renderer-"))
        .map((attr) => ({ localName: attr.localName, name: attr.name })),
    ).toEqual([]);
  });

  test("parseSvgData rejects garbage input and non-svg roots", () => {
    // linkedom recovers silently from some malformed XML (real browsers
    // surface parsererror, which parseSvgData also checks); garbage
    // input must still fail closed, and a non-svg root always fails.
    expect(() => svg.parseSvgData("<<<>>>")).toThrow(registry.FacetRenderError);
    expect(() => svg.parseSvgData("<html><body></body></html>")).toThrow(/not <svg>/);
  });

  test("sanitizeSvgDocument strips scripts, on* handlers, external URLs, nested documents", () => {
    const hostile = new TextDecoder().decode(readBytes(FIXTURES.svgHostile));
    const doc = svg.parseSvgData(hostile);
    svg.sanitizeSvgDocument(doc);
    expect(doc.querySelectorAll("script").length).toBe(0);
    const circles = doc.querySelectorAll("circle");
    expect(circles.length).toBe(1);
    expect(circles[0]!.getAttribute("onload")).toBeNull();
    // External href/xlink:href are gone; the anchor keeps its text.
    const anchor = doc.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBeNull();
    expect(anchor!.getAttribute("xlink:href")).toBeNull();
  });

  test("fragment references survive; external schemes do not", () => {
    const doc = svg.parseSvgData(
      [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
        '<defs><linearGradient id="g1"/></defs>',
        '<rect fill="url(#g1)" href="#g1" xlink:href="https://evil.example/x.svg"/>',
        "</svg>",
      ].join(""),
    );
    svg.sanitizeSvgDocument(doc);
    const rect = doc.querySelector("rect");
    expect(rect!.getAttribute("href")).toBe("#g1");
    expect(rect!.getAttribute("xlink:href")).toBeNull();
    expect(rect!.getAttribute("fill")).toBe("url(#g1)");
  });

  test("CSS in <style> and style= attribute is sanitized: @import, expression(), dangerous url() stripped", () => {
    const hostile = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
      "<style>",
      '@import url("http://evil.example/x.css");',
      ".a { fill: url(javascript:alert(1)); }",
      ".b { stroke: url(http://evil.example/x.svg); }",
      ".c { background: expression(alert(1)); }",
      '.d { background-image: url("https://evil.example/x.png"); }',
      ".e { background: url(vbscript:msgbox(1)); }",
      ".f { background: url(//evil.example/x.png); }",
      ".g { background: url(data:text/html,evil); }",
      "</style>",
      '<rect style="fill: url(javascript:alert(1)); background:url(http://x); stroke:url(//y)"/>',
      '<g style="background-image: url(//evil.example/x.png)"/>',
      '<circle fill="url(javascript:alert(1))" stroke="url(http://x.svg)"/>',
      '<path filter="url(javascript:alert(1))" mask="url(http://x.svg)"/>',
      "</svg>",
    ].join("");
    const doc = svg.parseSvgData(hostile);
    svg.sanitizeSvgDocument(doc);

    const styleEl = doc.querySelector("style");
    const styleText = styleEl?.textContent ?? "";
    expect(styleText).not.toMatch(/@import/i);
    expect(styleText).not.toMatch(/javascript:/i);
    expect(styleText).not.toMatch(/vbscript:/i);
    expect(styleText).not.toMatch(/expression\(/i);
    expect(styleText).not.toMatch(/https?:/i);
    expect(styleText).not.toMatch(/url\(\/\//i);
    expect(styleText).not.toMatch(/url\(\s*["']?data:/i);

    const rect = doc.querySelector("rect");
    const rectStyle = rect?.getAttribute("style") ?? "";
    expect(rectStyle).not.toMatch(/javascript:/i);
    expect(rectStyle).not.toMatch(/https?:/i);
    expect(rectStyle).not.toMatch(/url\(\/\//i);

    const g = doc.querySelector("g");
    const gStyle = g?.getAttribute("style") ?? "";
    expect(gStyle).not.toMatch(/url\(\/\//i);
    expect(gStyle).not.toMatch(/https?:/i);

    const circle = doc.querySelector("circle");
    expect(circle?.getAttribute("fill")).toBeNull();
    expect(circle?.getAttribute("stroke")).toBeNull();

    const path = doc.querySelector("path");
    expect(path?.getAttribute("filter")).toBeNull();
    expect(path?.getAttribute("mask")).toBeNull();
  });

  test("CSS canonicalization strips every non-fragment url and legacy executable construct on all surfaces", async () => {
    const hostileValues = [
      "url(java/**/script:alert(1))",
      "url(\\6a avascript:alert(2))",
      "url(\\00006aavascript:alert(3))",
      "JAVASCRIPT:alert(4)",
      "Url( JavaScript : alert(5) )",
      "url(//evil.example/x)",
      'url("data:text/html,evil")',
      "@im\\port url(#g1)",
      "EXPRESSION(alert(6))",
      "progid:DXImageTransform.Microsoft.Alpha(opacity=50)",
      "behavior:url(#g1)",
      "url(url(#x))",
    ];
    const hostile = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
      '<defs><linearGradient id="g1"/></defs>',
      ...hostileValues.flatMap((value, index) => {
        const attrValue = escapeXmlAttribute(value);
        return [
          `<style data-case="${index}">.case-${index} { fill: ${value}; }</style>`,
          `<rect id="style-${index}" style="font-family:serif;fill:${attrValue};stroke:#6f6f6f"/>`,
          `<rect id="fill-${index}" fill="${attrValue}"/>`,
          `<rect id="stroke-${index}" stroke="${attrValue}"/>`,
        ];
      }),
      "</svg>",
    ].join("");
    const container = freshContainer();
    await svg.importSanitizedSvgText(container, hostile, { settleMs: 0, maxWaitMs: 10 });

    for (const [index] of hostileValues.entries()) {
      expect(container.querySelector(`style[data-case="${index}"]`)?.textContent ?? "").not.toMatch(
        /\bfill\s*:/i,
      );

      const style = container.querySelector(`#style-${index}`)?.getAttribute("style") ?? "";
      expect(style).not.toMatch(/\bfill\s*:/i);
      expect(style).toContain("font-family:serif");
      expect(style).toContain("stroke:#6f6f6f");
      expect(style).not.toContain("font-family:none)");

      expect(container.querySelector(`#fill-${index}`)?.getAttribute("fill")).toBeNull();
      expect(container.querySelector(`#stroke-${index}`)?.getAttribute("stroke")).toBeNull();
    }
  });

  test("every CSS-reference presentation attribute allows only local fragment urls", () => {
    const attributes = [
      "fill",
      "stroke",
      "filter",
      "mask",
      "clip-path",
      "marker",
      "marker-start",
      "marker-mid",
      "marker-end",
      "cursor",
      "background",
      "background-image",
      "color-profile",
    ];
    const doc = svg.parseSvgData(
      [
        '<svg xmlns="http://www.w3.org/2000/svg">',
        '<defs><linearGradient id="g1"/></defs>',
        ...attributes.map(
          (attribute, index) => `<rect id="unsafe-${index}" ${attribute}="url(//evil.example/x)"/>`,
        ),
        ...attributes.map(
          (attribute, index) => `<rect id="safe-${index}" ${attribute}="url(#g1)"/>`,
        ),
        "</svg>",
      ].join(""),
    );
    svg.sanitizeSvgDocument(doc);

    for (const [index, attribute] of attributes.entries()) {
      expect(doc.querySelector(`#unsafe-${index}`)?.getAttribute(attribute)).toBeNull();
      expect(doc.querySelector(`#safe-${index}`)?.getAttribute(attribute)).toBe("url(#g1)");
    }
  });

  test("benign mermaid-style <style> with fill:#86E1FC and fragment url() refs survive sanitization", () => {
    const benign = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
      '<defs><linearGradient id="g1"><stop offset="0" stop-color="#86E1FC"/></linearGradient><radialGradient id="gradient"/></defs>',
      "<style>",
      ".node rect { fill: #86E1FC; stroke: #444; stroke-width: 1px; }",
      ".edge path { stroke: #6f6f6f; }",
      ".gradient { fill: url(#gradient); }",
      '.label { font-family: "Helvetica", sans-serif; color: #222; }',
      "</style>",
      '<rect class="node" fill="url(#g1)" stroke="#FF0000"/>',
      '<circle fill="none" stroke="red" style="fill:#86E1FC; stroke:url(#g1)"/>',
      '<path style="stroke:#6f6f6f; fill:none"/>',
      "</svg>",
    ].join("");
    const doc = svg.parseSvgData(benign);
    svg.sanitizeSvgDocument(doc);

    const styleEl = doc.querySelector("style");
    const styleText = styleEl?.textContent ?? "";
    expect(styleText).toContain("#86E1FC");
    expect(styleText).toContain("#444");
    expect(styleText).toContain("#6f6f6f");
    expect(styleText).toContain("#222");
    expect(styleText).toContain("url(#gradient)");

    const rect = doc.querySelector("rect");
    expect(rect?.getAttribute("fill")).toBe("url(#g1)");
    expect(rect?.getAttribute("stroke")).toBe("#FF0000");

    const circle = doc.querySelector("circle");
    expect(circle?.getAttribute("fill")).toBe("none");
    expect(circle?.getAttribute("stroke")).toBe("red");
    const circleStyle = circle?.getAttribute("style") ?? "";
    expect(circleStyle).toContain("#86E1FC");
    expect(circleStyle).toContain("url(#g1)");

    const path = doc.querySelector("path");
    const pathStyle = path?.getAttribute("style") ?? "";
    expect(pathStyle).toContain("#6f6f6f");
    expect(pathStyle).toContain("none");
  });

  test("importSanitizedSvgText: hostile CSS in <style> + style= is neutralized in the imported container", async () => {
    const hostile = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
      '<style>@import url("http://evil.example/x.css"); .x { fill: url(javascript:alert(1)); }</style>',
      '<rect style="background: url(javascript:alert(1))"/>',
      "</svg>",
    ].join("");
    const container = freshContainer();
    await svg.importSanitizedSvgText(container, hostile);

    const styleEl = container.querySelector("style");
    const styleText = styleEl?.textContent ?? "";
    expect(styleText).not.toMatch(/@import/i);
    expect(styleText).not.toMatch(/javascript:/i);

    const rect = container.querySelector("rect");
    expect(rect?.getAttribute("style") ?? "").not.toMatch(/javascript:/i);
  });

  test("foreignObject (nested document) is removed wholesale", () => {
    const doc = svg.parseSvgData(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject>' +
        "<circle r='2'/></svg>",
    );
    svg.sanitizeSvgDocument(doc);
    expect(doc.querySelectorAll("foreignObject").length).toBe(0);
    expect(doc.querySelectorAll("circle").length).toBe(1);
  });

  test("renderSvgDocument imports the clean fixture and strips the hostile one", async () => {
    const container = freshContainer();
    await svg.renderSvgDocument({ container, theme: "dark" }, readBytes(FIXTURES.svgClean));
    expect(container.querySelectorAll("svg").length).toBe(1);
    expect(container.querySelector("circle")).not.toBeNull();

    const hostileContainer = freshContainer();
    await svg.renderSvgDocument(
      { container: hostileContainer, theme: "dark" },
      readBytes(FIXTURES.svgHostile),
    );
    expect(hostileContainer.querySelectorAll("script").length).toBe(0);
    expect(hostileContainer.querySelectorAll("svg").length).toBe(1);
  });

  test("garbage svg surfaces as a facet render error", async () => {
    const container = freshContainer();
    let caught: unknown = null;
    try {
      await svg.renderSvgDocument({ container, theme: "dark" }, new TextEncoder().encode("<<<>>>"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(registry.FacetRenderError);
    expect(["svg_malformed", "svg_bad_root"]).toContain((caught as { code: string }).code);
    expect(container.querySelectorAll("svg").length).toBe(0);
  });
});

describe("Mermaid renderer", () => {
  test("light Mermaid initialization disables dark mode in its fresh frame", () => {
    expect(mermaid.mermaidInitializeConfig("light")).toMatchObject({
      theme: "default",
      darkMode: false,
    });
  });
});

describe("chart renderer — loader disabled, zero marks is an error", () => {
  test("Facet defaults fill missing config while authored config wins", () => {
    const source = {
      mark: "bar",
      data: { values: [{ x: "A", y: 1 }] },
      encoding: { x: { field: "x", type: "nominal" }, y: { field: "y", type: "quantitative" } },
      config: { background: "#f0c" },
    };
    const themed = chart.withFacetChartTheme(source, "light") as {
      readonly config: { readonly background: string; readonly style: Record<string, unknown> };
    };

    expect(source.config.background).toBe("#f0c");
    expect(themed.config.background).toBe("#f0c");
    expect(themed.config.style["guide-label"]).toEqual({ fill: "#172033" });

    const defaults = chart.withFacetChartTheme(
      {
        mark: "bar",
        data: { values: [{ x: "A", y: 1 }] },
        encoding: { x: { field: "x", type: "nominal" }, y: { field: "y", type: "quantitative" } },
      },
      "dark",
    ) as {
      readonly config: { readonly background: string; readonly style: Record<string, unknown> };
    };
    expect(defaults.config.background).toBe("#151823");
    expect(defaults.config.style["guide-label"]).toEqual({ fill: "#c8d3f5" });
  });

  test("countVegaMarks counts role-mark data groups, not axes", () => {
    expect(chart.countVegaMarks('<g class="mark-rect role-mark">')).toBe(1);
    expect(
      chart.countVegaMarks(
        '<g class="mark-rect role-mark"/><g class="mark-line role-mark"/><g class="mark-rule role-axis"/>',
      ),
    ).toBe(2);
    expect(
      chart.countVegaMarks('<g class="mark-rule role-axis"/><g class="mark-text role-axis"/>'),
    ).toBe(0);
    expect(chart.countVegaMarks("<svg></svg>")).toBe(0);
  });

  test("explicit svg renderer preserves the sanitized SVG import path", async () => {
    const container = freshContainer();
    await chart.renderChart({ container, theme: "dark" }, readBytes(FIXTURES.chartBarline), "svg");
    expect(container.querySelectorAll("svg").length).toBe(1);
    expect(container.querySelectorAll("canvas").length).toBe(0);
    const svgText = container.innerHTML;
    expect(svgText).toMatch(/role-mark/);
  }, 20_000);

  test("canvas renderer attaches one canvas to the artifact container", async () => {
    const container = freshContainer();
    await chart.renderChart(
      { container, theme: "dark" },
      readBytes(FIXTURES.chartBarline),
      "canvas",
    );
    expect(container.querySelectorAll("canvas").length).toBe(1);
    expect(container.querySelectorAll("svg").length).toBe(0);
  }, 20_000);

  test("external data url is rejected by the blocked loader", async () => {
    const container = freshContainer();
    let caught: unknown = null;
    try {
      await chart.renderChart({ container, theme: "dark" }, readBytes(FIXTURES.chartExternal));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(registry.FacetRenderError);
    expect((caught as { code: string }).code).toBe("chart_external_data");
    expect(container.querySelectorAll("svg").length).toBe(0);
  }, 20_000);

  test("zero-mark spec is an error, not an ok render", async () => {
    const container = freshContainer();
    let caught: unknown = null;
    try {
      await chart.renderChart({ container, theme: "dark" }, readBytes(FIXTURES.chartZeroMarks));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(registry.FacetRenderError);
    expect((caught as { code: string }).code).toBe("chart_zero_marks");
    expect(container.querySelectorAll("svg").length).toBe(0);
  }, 20_000);

  test("invalid JSON is a typed chart error", async () => {
    const container = freshContainer();
    let caught: unknown = null;
    try {
      await chart.renderChart({ container, theme: "dark" }, new TextEncoder().encode("{not json"));
    } catch (error) {
      caught = error;
    }
    expect((caught as { code: string }).code).toBe("chart_invalid_json");
  });
});

describe("renderer registry — dispatch contract", () => {
  test("page shim reports marker-scoped counts without inflating nested SVGs or creating canvas contexts", () => {
    shimDocument.body.replaceChildren();
    const container = freshContainer();
    container.innerHTML = [
      '<svg data-facet-renderer-root="true" data-facet-renderer-graph="true" viewBox="0 0 100 100">',
      '<g class="node"/><g class="node"/>',
      '<svg data-facet-renderer-root="true" data-facet-renderer-graph="true" viewBox="0 0 100 100"/>',
      "<canvas></canvas>",
      '<facet-error data-facet-error="true"></facet-error>',
      "</svg>",
    ].join("");

    expect(registry.countPageShim()).toEqual({
      rendererRootSvgCount: 1,
      graphCount: 1,
      mermaidNodeCount: 2,
      visibleSvgCount: 1,
      opaqueRegionCount: 1,
      externalImageCount: 0,
      errorCount: 1,
    });
  });

  test("registry resolves the five implemented types", () => {
    const reg = registry.createRendererRegistry(
      registry.ARTIFACT_TYPES.map((type) => [type, NOOP_RENDERER] as const),
    );
    for (const type of registry.ARTIFACT_TYPES) {
      expect(reg.get(type)).toBeDefined();
    }
  });

  test("html dispatch is the typed unsupported_reserved_type error", async () => {
    const reg = registry.createRendererRegistry([]);
    let caught: unknown = null;
    try {
      await registry.dispatchRender(
        reg,
        { container: freshContainer(), theme: "dark" },
        { artifactType: "html", renderer: "svg", bytes: new Uint8Array(), theme: "dark" },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(registry.FacetRenderError);
    expect((caught as { code: string }).code).toBe("unsupported_reserved_type");
  });

  test("unknown renderers are rejected before the renderer callable runs", async () => {
    const calls: string[] = [];
    const reg = registry.createRendererRegistry([
      [
        "chart",
        async (_ctx, _bytes, renderer) => {
          calls.push(renderer);
        },
      ] as const,
    ]);
    await expect(
      registry.dispatchRender(
        reg,
        { container: freshContainer(), theme: "dark" },
        {
          artifactType: "chart",
          renderer: "webgl" as never,
          bytes: new Uint8Array(),
          theme: "dark",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toEqual([]);
  });

  test("appendRenderError marks the element for every observation channel", () => {
    const container = freshContainer();
    registry.appendRenderError(container, "boom");
    const marker = container.querySelector("[data-facet-error]");
    expect(marker).not.toBeNull();
    expect(marker!.textContent).toBe("boom");
  });
});

describe("page shim wire compatibility", () => {
  test("SVG render-complete JSON remains byte-identical without an html key", () => {
    while (shimDocument.body.firstChild !== null) {
      shimDocument.body.firstChild.remove();
    }
    const root = shimDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    root.setAttribute("data-facet-renderer-root", "true");
    root.setAttribute("data-facet-renderer-graph", "true");
    root.setAttribute("viewBox", "0 0 100 100");
    shimDocument.body.appendChild(root);

    const message = JSON.stringify({ type: "render-complete", observed: registry.countPageShim() });
    expect(message).toBe(
      '{"type":"render-complete","observed":{"rendererRootSvgCount":1,"graphCount":1,"mermaidNodeCount":0,"visibleSvgCount":1,"opaqueRegionCount":0,"externalImageCount":0,"errorCount":0}}',
    );
    root.remove();
  });
});
