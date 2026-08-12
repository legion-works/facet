/**
 * FAIL-CLOSED TSX renderer tests.
 *
 * The stub at `src/gallery-web/frame/renderers/tsx.ts` exists because
 * Tasks 5-7 are not yet implemented. It must THROW before any read
 * of artifact bytes — running `TextDecoder` over user-controlled
 * content before rejecting is the failure mode this file pins
 * against. A bare test that checks the error message would pass
 * even when the decoder ran (the byte length, not the content,
 * appears in the message), so the vacuity-proof tests here assert
 * behavior that REDdens against the bug: the bytes must never be
 * passed to a decoder, and a sentinel string baked into the source
 * must never appear in any side effect of the call.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

// --- linkedom DOM shim. The stub now throws before touching the
// container, but the shim stays in case the harness ever changes
// and the stub is permitted to leave a typed marker (the harness
// itself owns the marker today, see `bootstrap.ts` and
// `harness-entry.ts`).
const { document: shimDocument, window: shimWindow } = parseHTML(
  "<!DOCTYPE html><html><body><main id='artifact'></main></body></html>",
);
const globals = globalThis as Record<string, unknown>;
globals["document"] = shimDocument;
globals["window"] = shimWindow;
globals["Element"] = shimWindow.Element;
globals["HTMLElement"] = shimWindow.HTMLElement;
globals["Node"] = shimWindow.Node;

let tsx: typeof import("../../src/gallery-web/frame/renderers/tsx");
let registry: typeof import("../../src/gallery-web/frame/renderers/registry");

beforeAll(async () => {
  tsx = await import("../../src/gallery-web/frame/renderers/tsx");
  registry = await import("../../src/gallery-web/frame/renderers/registry");
});

function freshContainer(): HTMLElement {
  const el = shimDocument.createElement("main");
  shimDocument.body.appendChild(el);
  return el as unknown as HTMLElement;
}

const SENTINEL = "__FACET_SENTINEL_NEVER_DECODE_ME__";

describe("tsx renderer stub — fail-closed contract (Must 1)", () => {
  test("throws a typed FacetRenderError on entry, before any DOM mutation", async () => {
    const container = freshContainer();
    const bytes = new TextEncoder().encode(`export default function App(){return null;}`);
    let caught: unknown = null;
    try {
      await tsx.renderTsx({ container }, bytes);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(registry.FacetRenderError);
    expect((caught as InstanceType<typeof registry.FacetRenderError>).code).toBe("tsx_unavailable");
    // The harness owns the error marker (see gallery bootstrap.ts and
    // tier1 harness-entry.ts — both wrap renderer throws with
    // appendRenderError). The renderer must NOT pre-mutate the
    // container: that path has been used to rationalize reading
    // bytes to surface a "length" in the marker.
    expect(container.childNodes.length).toBe(0);
  });

  test("does not call decodeArtifactBytes on the artifact bytes", async () => {
    // Vacuity-proof via TextDecoder creation tracking. The current
    // bug calls `decodeArtifactBytes(_bytes)` which constructs a
    // new TextDecoder and reads the buffer. We count every TextDecoder
    // construction via a spy on the global constructor; if any
    // construction is observed between entering and leaving the
    // stub, the test reddens. After the fix the count is unchanged.
    const OriginalTextDecoder = globalThis.TextDecoder;
    const constructionCalls: Array<unknown[]> = [];
    class CountingTextDecoder extends OriginalTextDecoder {
      constructor(...args: ConstructorParameters<typeof OriginalTextDecoder>) {
        constructionCalls.push(args);
        super(...args);
      }
    }
    Object.defineProperty(globalThis, "TextDecoder", {
      configurable: true,
      writable: true,
      value: CountingTextDecoder,
    });
    try {
      const dispatch = (await import("../../src/gallery-web/frame/renderers/registry"))
        .dispatchRender;
      const container = freshContainer();
      let caught: unknown = null;
      try {
        await dispatch(
          {
            get: (type: string) => (type === "tsx" ? tsx.renderTsx : undefined),
          } as never,
          { container },
          {
            artifactType: "tsx",
            renderer: "svg",
            bytes: new TextEncoder().encode(`export default function App(){return null;}`),
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(registry.FacetRenderError);
      // No TextDecoder construction in the stub path. The harness
      // itself may build one for the artifact payload decode, but
      // it sits OUTSIDE the renderer invocation we exercise here.
      // The exact assertion is: count is zero for the
      // TextDecoder("utf-8", { fatal: false }) signature the
      // decodeArtifactBytes helper uses.
      const failClosedDecodeCalls = constructionCalls.filter((args: unknown[]) => {
        const first = args[0];
        const second = args[1] as { fatal?: boolean } | undefined;
        return first === "utf-8" && (second === undefined || second.fatal === false);
      });
      expect(failClosedDecodeCalls.length).toBe(0);
    } finally {
      Object.defineProperty(globalThis, "TextDecoder", {
        configurable: true,
        writable: true,
        value: OriginalTextDecoder,
      });
    }
  });

  test("sentinel in source bytes never reaches the error text or the DOM", async () => {
    const container = freshContainer();
    const source = `export default function App(){return <div>${SENTINEL}</div>;}`;
    const bytes = new TextEncoder().encode(source);
    let caught: unknown = null;
    try {
      await tsx.renderTsx({ container }, bytes);
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message.includes(SENTINEL)).toBe(false);
    expect(container.textContent?.includes(SENTINEL) ?? false).toBe(false);
    expect(container.innerHTML.includes(SENTINEL)).toBe(false);
  });

  test("the BUILT bundle never invokes TextDecoder on the artifact path", async () => {
    // The stub's runtime contract is a build artifact. This test
    // inspects the bundle so a regression that re-introduces the
    // decode cannot hide behind the linkedom shim's permissive
    // TextDecoder mock.
    const result = await Bun.build({
      entrypoints: ["/home/icetea/projects/facet/src/gallery-web/frame/renderers/tsx.ts"],
      target: "browser",
      format: "esm",
    });
    if (!result.success)
      throw new Error(`build failed: ${result.logs.map((l) => l.message).join("\n")}`);
    const outputs = result.outputs;
    const jsOutput = outputs.find((o) => o.path.endsWith(".js"));
    if (jsOutput === undefined) throw new Error("no js output");
    const code = await jsOutput.text();
    // The bundle must NOT call `decodeArtifactBytes` (the TextDecoder
    // pathway) on the artifact bytes. A `TextDecoder` reference
    // inside the bundle is allowed only if it is provably dead code
    // — the simplest durable check is the absence of the call site.
    expect(code.includes("decodeArtifactBytes")).toBe(false);
    expect(code.includes("new TextDecoder")).toBe(false);
  });
});
