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

  test("publishes the starter classes in the canonical style vocabulary", () => {
    expect(vocabulary.HTML_TAILWIND_CLASSES).toEqual(
      expect.arrayContaining(["flex", "gap-4", "text-xl", "border", "table"]),
    );
    expect(vocabulary.HTML_DAISY_COMPONENTS).toEqual(
      expect.arrayContaining(["alert", "badge", "btn", "card", "stat", "table"]),
    );
  });
});
