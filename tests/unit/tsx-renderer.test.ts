import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

const { document: shimDocument, window: shimWindow } = parseHTML(
  "<!doctype html><html><body></body></html>",
);
const globals = globalThis as Record<string, unknown>;
const priorDocument = globals["document"];
const priorWindow = globals["window"];
globals["document"] = shimDocument;
globals["window"] = shimWindow;
globals["Element"] = shimWindow.Element;
globals["HTMLElement"] = shimWindow.HTMLElement;
globals["Node"] = shimWindow.Node;
globals["DOMParser"] = shimWindow.DOMParser;

afterAll(() => {
  globals["document"] = priorDocument;
  globals["window"] = priorWindow;
});

let tsx: typeof import("../../src/gallery-web/frame/renderers/tsx");
let html: typeof import("../../src/gallery-web/frame/renderers/html");
let registry: typeof import("../../src/gallery-web/frame/renderers/registry");

interface TsxModuleRuntime {
  readonly createObjectURL: (blob: Blob) => string;
  readonly importModule: (url: string) => Promise<unknown>;
  readonly revokeObjectURL: (url: string) => void;
}

type TsxRendererWithTestRuntime = typeof import("../../src/gallery-web/frame/renderers/tsx") & {
  setTsxModuleRuntimeForTests?: (runtime: TsxModuleRuntime | undefined) => void;
};

beforeAll(async () => {
  tsx = await import("../../src/gallery-web/frame/renderers/tsx");
  html = await import("../../src/gallery-web/frame/renderers/html");
  registry = await import("../../src/gallery-web/frame/renderers/registry");
});

afterEach(() => {
  (tsx as TsxRendererWithTestRuntime).setTsxModuleRuntimeForTests?.(undefined);
});

function freshContainer(): HTMLElement {
  const container = shimDocument.createElement("main");
  shimDocument.body.appendChild(container);
  return container as unknown as HTMLElement;
}

describe("TSX renderer", () => {
  test("renderer error marker preserves a supplied message", () => {
    const container = freshContainer();

    registry.appendRenderError(container, "renderer failure");

    expect(container.querySelector("[data-facet-error='true']")?.textContent).toBe(
      "renderer failure",
    );
  });

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

  test("interactive TSX mounts one renderer root directly in the artifact document", async () => {
    const bytes = new TextEncoder().encode("export default {};");
    const container = freshContainer();
    const imported: string[] = [];
    const revoked: string[] = [];
    const runtime: TsxModuleRuntime = {
      createObjectURL: (_blob) => {
        return "blob:facet-test-module";
      },
      importModule: async (url) => {
        imported.push(url);
      },
      revokeObjectURL: (url) => {
        revoked.push(url);
      },
    };
    (tsx as TsxRendererWithTestRuntime).setTsxModuleRuntimeForTests?.(runtime);

    await tsx.renderTsx({ container, nonce: "n-interactive" }, bytes, "svg", "interactive");

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.children).toHaveLength(1);
    expect(container.querySelector("#facet-tsx-mount")).not.toBeNull();
    expect(container.querySelectorAll("[data-facet-renderer-root='true']")).toHaveLength(1);
    expect(imported).toEqual(["blob:facet-test-module"]);
    expect(revoked).toEqual(["blob:facet-test-module"]);
  });

  test("interactive TSX revokes its module URL when module evaluation fails", async () => {
    const bytes = new TextEncoder().encode("export default {};");
    const container = freshContainer();
    const revoked: string[] = [];
    const runtime: TsxModuleRuntime = {
      createObjectURL: () => "blob:facet-failing-module",
      importModule: async () => {
        throw new Error("module evaluation failed");
      },
      revokeObjectURL: (url) => {
        revoked.push(url);
      },
    };
    (tsx as TsxRendererWithTestRuntime).setTsxModuleRuntimeForTests?.(runtime);

    await expect(
      tsx.renderTsx({ container, nonce: "n-failing" }, bytes, "svg", "interactive"),
    ).rejects.toThrow("module evaluation failed");
    expect(revoked).toEqual(["blob:facet-failing-module"]);
    expect(container.querySelector("[data-facet-error='true']")?.textContent).toBe(
      "module evaluation failed",
    );
  });

  test("interactive TSX reports browser errors once through the renderer marker", async () => {
    const container = freshContainer();
    (tsx as TsxRendererWithTestRuntime).setTsxModuleRuntimeForTests?.({
      createObjectURL: () => "blob:facet-events-module",
      importModule: async () => {},
      revokeObjectURL: () => {},
    });

    await tsx.renderTsx(
      { container, nonce: "n-events" },
      new TextEncoder().encode("export default {};"),
      "svg",
      "interactive",
    );
    shimWindow.dispatchEvent(new shimWindow.Event("error"));
    shimWindow.dispatchEvent(new shimWindow.Event("unhandledrejection"));

    expect(container.querySelectorAll("[data-facet-error='true']")).toHaveLength(1);
    expect(container.querySelector("[data-facet-error='true']")?.textContent).toBe(
      "interactive TSX runtime error",
    );
  });

  test("interactive TSX falls back to the browser module runtime when no test runtime is injected", async () => {
    const container = freshContainer();
    (tsx as TsxRendererWithTestRuntime).setTsxModuleRuntimeForTests?.(undefined);

    await tsx.renderTsx(
      { container, nonce: "n-browser-runtime" },
      new TextEncoder().encode("export default {};"),
      "svg",
      "interactive",
    );
    expect(container.querySelector("#facet-tsx-mount")).not.toBeNull();
  });
});
