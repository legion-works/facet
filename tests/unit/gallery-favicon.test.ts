import { afterEach, describe, expect, test } from "bun:test";

import { FAVICON_TINT_BY_STATUS, faviconTint, renderFavicon } from "../../src/gallery-web/favicon";
import { RenderStatusSchema } from "../../src/shared/contracts/validation";

const globals = globalThis as Record<string, unknown>;
const originalDocument = globals.document;

afterEach(() => {
  if (originalDocument === undefined) delete globals.document;
  else globals.document = originalDocument;
});

describe("gallery favicon", () => {
  test("maps every closed render status to an explicit tint", () => {
    for (const status of RenderStatusSchema.options) {
      expect(Object.hasOwn(FAVICON_TINT_BY_STATUS, status)).toBe(true);
    }

    expect(faviconTint("ok")).toBe("teal");
    expect(faviconTint("partial:layout_unverified")).toBe("amber");
    expect(faviconTint("partial:opaque_content")).toBe("amber");
    expect(faviconTint("partial:external_resources")).toBe("amber");
    expect(faviconTint("partial:unstable")).toBe("amber");
    expect(faviconTint("error")).toBe("red");
    expect(faviconTint("tampered")).toBe("red");
    expect(faviconTint("timeout")).toBe("red");
    expect(faviconTint("insecure:unvalidated")).toBe("amber-red");
    expect(faviconTint("shim_only")).toBe("grey");
    expect(faviconTint("probe_only")).toBe("grey");
    expect(faviconTint("idle")).toBe("grey");
    expect(faviconTint("expired")).toBe("grey");
    expect(faviconTint("unverified")).toBe("grey");
  });

  test("renders the Legion mark to a 32 pixel data URL", () => {
    const calls: Record<string, unknown>[] = [];
    const context = {
      fillStyle: "",
      font: "",
      textAlign: "",
      textBaseline: "",
      fillText: (...args: unknown[]) => calls.push({ args }),
    };
    let width = 0;
    let height = 0;
    globals.document = {
      createElement: (tag: string) => {
        expect(tag).toBe("canvas");
        return {
          get width() {
            return width;
          },
          set width(value: number) {
            width = value;
          },
          get height() {
            return height;
          },
          set height(value: number) {
            height = value;
          },
          getContext: (kind: string) => (kind === "2d" ? context : null),
          toDataURL: (kind: string) => {
            expect(kind).toBe("image/png");
            return "data:image/png;base64,sentinel";
          },
        };
      },
    };

    expect(renderFavicon("teal")).toBe("data:image/png;base64,sentinel");
    expect(width).toBe(32);
    expect(height).toBe(32);
    expect(calls).toEqual([{ args: ["◆", 16, 16] }]);
    expect(context.font).toBe("24px sans-serif");
    expect(context.textAlign).toBe("center");
    expect(context.textBaseline).toBe("middle");
  });

  test("returns null when canvas rendering is unavailable", () => {
    delete globals.document;
    expect(renderFavicon("grey")).toBeNull();

    globals.document = { createElement: () => ({ getContext: () => null }) };
    expect(renderFavicon("grey")).toBeNull();

    globals.document = {
      createElement: () => ({
        getContext: () => ({ fillText() {} }),
        toDataURL: () => {
          throw new Error("canvas unavailable");
        },
      }),
    };
    expect(renderFavicon("grey")).toBeNull();
  });
});
