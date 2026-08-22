import { beforeAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

const { document: shimDocument, window: shimWindow } = parseHTML(
  "<!doctype html><html><body></body></html>",
);
const globals = globalThis as Record<string, unknown>;
globals["document"] = shimDocument;
globals["window"] = shimWindow;
globals["Element"] = shimWindow.Element;
globals["HTMLElement"] = shimWindow.HTMLElement;
globals["Node"] = shimWindow.Node;
globals["DocumentFragment"] = shimWindow.DocumentFragment;
globals["DOMParser"] = (shimWindow as unknown as Record<string, unknown>)["DOMParser"];
Object.defineProperty(shimDocument, "adoptNode", {
  configurable: true,
  value: <T extends Node>(node: T): T => node,
});

function freshContainer(): HTMLElement {
  const container = shimDocument.createElement("main");
  shimDocument.body.appendChild(container);
  return container as unknown as HTMLElement;
}

let html: typeof import("../../src/gallery-web/frame/renderers/html");
let vocabulary: typeof import("../../src/shared/html/style-vocabulary");

beforeAll(async () => {
  html = await import("../../src/gallery-web/frame/renderers/html");
  vocabulary = await import("../../src/shared/html/style-vocabulary");
});

describe("HTML frame renderer", () => {
  test("creates the frame-owned root", () => {
    const root = html.createHtmlRendererRoot(freshContainer().ownerDocument);
    expect(root?.getAttribute("data-facet-renderer-root")).toBe("true");
    expect(root?.className).toBe("facet-html-root");
  });

  test("keeps safe HTML beneath the frame-owned root while stripping executable markup", async () => {
    const container = freshContainer();
    await html.renderHtml(
      { container, theme: "dark" },
      new TextEncoder().encode(`
        <!doctype html><html><body>
        <script id="denied-script">window.facetCompromised = true;</script>
        <iframe id="denied-frame" src="https://outside.invalid/"></iframe>
        <section id="safe-section" onclick="window.facetCompromised = true" style="color: red">
          <a id="safe-link" href="https://example.com/report">report</a>
          <a id="unsafe-link" href="javascript:window.facetCompromised = true">unsafe</a>
          <img id="safe-image" src="data:image/png;base64,AA==">
          <img id="unsafe-image" src="https://["><div id="misplaced-url" href="https://outside.invalid/">text</div>
        </section>
        </body></html>
      `),
    );

    const root = container.firstElementChild;
    expect(root?.getAttribute("data-facet-renderer-root")).toBe("true");
    expect(root?.className).toBe("facet-html-root");
    expect(root?.querySelector("#denied-script")).toBeNull();
    expect(root?.querySelector("#denied-frame")).toBeNull();
    expect(root?.querySelector("#safe-section")?.getAttribute("onclick")).toBeNull();
    expect(root?.querySelector("#safe-section")?.getAttribute("style")).toBeNull();
    expect(root?.querySelector("#safe-link")?.getAttribute("href")).toBe(
      "https://example.com/report",
    );
    expect(root?.querySelector("#unsafe-link")?.getAttribute("href")).toBeNull();
    expect(root?.querySelector("#safe-image")?.getAttribute("src")).toBe(
      "data:image/png;base64,AA==",
    );
    expect(root?.querySelector("#unsafe-image")?.getAttribute("src")).toBeNull();
    expect(root?.querySelector("#misplaced-url")?.getAttribute("href")).toBeNull();
  });

  test("publishes the starter classes in the canonical style vocabulary", () => {
    expect(vocabulary.HTML_TAILWIND_CLASSES).toEqual(
      expect.arrayContaining(["flex", "gap-4", "text-xl", "border", "table"]),
    );
    expect(vocabulary.HTML_DAISY_COMPONENTS).toEqual(
      expect.arrayContaining(["alert", "badge", "btn", "card", "stat", "table"]),
    );
  });
});
