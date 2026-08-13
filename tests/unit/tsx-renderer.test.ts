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
globals["DOMParser"] = shimWindow.DOMParser;

let tsx: typeof import("../../src/gallery-web/frame/renderers/tsx");
let html: typeof import("../../src/gallery-web/frame/renderers/html");

beforeAll(async () => {
  tsx = await import("../../src/gallery-web/frame/renderers/tsx");
  html = await import("../../src/gallery-web/frame/renderers/html");
});

function freshContainer(): HTMLElement {
  const container = shimDocument.createElement("main");
  shimDocument.body.appendChild(container);
  return container as unknown as HTMLElement;
}

describe("TSX renderer", () => {
  test("static TSX delegates to the HTML renderer's marked and sanitized root", async () => {
    const bytes = new TextEncoder().encode("<p>safe</p><script>blocked()</script>");
    const actual = freshContainer();
    const expected = freshContainer();

    await html.renderHtml({ container: expected }, bytes);
    await tsx.renderTsx({ container: actual, nonce: "n-static" }, bytes, "svg", "static");

    expect(actual.innerHTML).toBe(expected.innerHTML);
    expect(actual.querySelectorAll("[data-facet-renderer-root='true']")).toHaveLength(1);
    expect(actual.querySelector("script")).toBeNull();
  });

  test("interactive TSX replaces the outer document with one opaque nested frame", async () => {
    const source = 'document.getElementById("facet-tsx-mount").textContent="mounted";';
    const bytes = new TextEncoder().encode(source);
    const container = freshContainer();

    await tsx.renderTsx({ container, nonce: "n-interactive" }, bytes, "svg", "interactive");

    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(container.children).toHaveLength(1);
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("allow")).toBe("");
    expect(frame?.getAttribute("data-facet-tsx-frame")).toBe("true");
    const srcdoc = frame?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain('<main id="facet-tsx-mount" data-facet-renderer-root="true"></main>');
    expect(srcdoc.match(/<script type="module" nonce="n-interactive">/g)).toHaveLength(1);
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
  });

  test("interactive presentation escapes closing script text without mutating compiled bytes", async () => {
    const source = 'const value = "</script><p>escaped</p>";';
    const bytes = new TextEncoder().encode(source);
    const before = bytes.slice();
    const container = freshContainer();

    await tsx.renderTsx({ container, nonce: "n-escape" }, bytes, "svg", "interactive");

    const srcdoc = container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("<\\/script><p>escaped</p>");
    expect(srcdoc).not.toContain('"</script><p>escaped</p>"');
    expect(bytes).toEqual(before);
  });

  test("interactive iframe fills the container and drops the default UA border", async () => {
    const bytes = new TextEncoder().encode("// mounted");
    const container = freshContainer();

    await tsx.renderTsx({ container, nonce: "n-fill" }, bytes, "svg", "interactive");

    const frame = container.querySelector("iframe") as HTMLElement;
    expect(frame).not.toBeNull();
    // The nested frame must inherit the artifact container's full size
    // and its own UA-default border would render a small white-bordered
    // box inside the stage — the size + border must be set so the
    // interactive TSX receives the same stage as every other artifact.
    expect(frame.style.width).toBe("100%");
    expect(frame.style.height).toBe("100%");
    expect(frame.style.border).toBe("0");
  });
});
