/**
 * Tier 1 verdict unit tests.
 *
 * The verdict taxonomy lives in `src/validation/tier1/verdict.ts` and
 * is the SOLE component that decides a `RenderStatus` from the
 * raw probe surface (expected lexical counts, protocol observation,
 * isolated-world observation, page-shim self-report, and lifecycle
 * completion). Because the decision is pure and bounded, the unit
 * matrix is the only place the taxonomy has to be exhaustively
 * covered — every other layer depends on this contract.
 *
 * Page-shim is UNTRUSTED. Protocol authority wins. Discriminative
 * errors observed by the protocol beat zero discriminative errors
 * observed by the shim, even when their counts match.
 */

import { describe, expect, test } from "bun:test";

import {
  type ChannelSummary,
  type LifecycleSummary,
  type PageShim,
} from "../../src/validation/tier1/verdict";
import {
  type ProtocolObservation,
  LexicalCountersSchema,
  type LexicalCounters,
} from "../../src/shared/contracts/validation";
import { deriveVerdict } from "../../src/validation/tier1/verdict";

const lex = (overrides: Partial<LexicalCounters> = {}): LexicalCounters =>
  LexicalCountersSchema.parse({
    rendererRootSvgCount: 1,
    mermaidNodeCount: 1,
    visibleSvgCount: 1,
    opaqueRegionCount: 0,
    ...overrides,
  });

const protocol = (overrides: Partial<ProtocolObservation> = {}): ProtocolObservation => ({
  rendererRootSvgCount: 1,
  graphCount: 1,
  mermaidNodeCount: 1,
  visibleSvgCount: 1,
  viewBoxes: ["0 0 100 100"],
  errorCount: 0,
  opaqueRegionCount: 0,
  discriminativeErrors: [],
  ...overrides,
});

const shim = (overrides: Partial<PageShim> = {}): PageShim => ({
  rendererRootSvgCount: 1,
  graphCount: 1,
  mermaidNodeCount: 1,
  visibleSvgCount: 1,
  opaqueRegionCount: 0,
  errorCount: 0,
  ...overrides,
});

const channels = (overrides: Partial<ChannelSummary> = {}): ChannelSummary => ({
  shim: true,
  isolated: true,
  ...overrides,
});
void channels;

const lifecycle = (overrides: Partial<LifecycleSummary> = {}): LifecycleSummary => ({
  bootReady: true,
  renderComplete: true,
  ...overrides,
});

describe("deriveVerdict — happy path", () => {
  test("matches counts on every channel → ok", () => {
    expect(deriveVerdict(lex(), protocol(), protocol(), shim(), lifecycle())).toBe("ok");
  });
});

describe("deriveVerdict — tamper detection (page shim is untrusted)", () => {
  test("isolated opaque-region count differs from protocol → tampered", () => {
    const status = deriveVerdict(
      lex(),
      protocol({ opaqueRegionCount: 1 }),
      protocol({ opaqueRegionCount: 0 }),
      shim({ opaqueRegionCount: 1 }),
      lifecycle(),
    );
    expect(status).toBe("tampered");
  });

  test("shim reports 2 SVGs / 0 errors but protocol truth shows 0 / 1 → tampered", () => {
    const status = deriveVerdict(
      lex({ rendererRootSvgCount: 1, mermaidNodeCount: 1, visibleSvgCount: 1 }),
      protocol({
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
        opaqueRegionCount: 0,
        discriminativeErrors: [{ code: "facet_error", message: "broken" }],
      }),
      protocol({ rendererRootSvgCount: 0, graphCount: 0, errorCount: 1 }),
      shim({ rendererRootSvgCount: 2, graphCount: 2, errorCount: 0 }),
      lifecycle(),
    );
    expect(status).toBe("tampered");
  });

  test("shim claims the rendered graph but protocol missed the root → tampered", () => {
    const status = deriveVerdict(
      lex({ rendererRootSvgCount: 1 }),
      protocol({ rendererRootSvgCount: 0, graphCount: 0, errorCount: 1 }),
      protocol({ rendererRootSvgCount: 0, graphCount: 0, errorCount: 1 }),
      shim({ rendererRootSvgCount: 1, graphCount: 1 }),
      lifecycle(),
    );
    expect(status).toBe("tampered");
  });

  test("isolated world agrees with shim but protocol differs → still tampered (protocol wins)", () => {
    const status = deriveVerdict(
      lex(),
      protocol({ rendererRootSvgCount: 0, errorCount: 1 }),
      protocol({ rendererRootSvgCount: 2, errorCount: 0 }),
      shim({ rendererRootSvgCount: 2, errorCount: 0 }),
      lifecycle(),
    );
    expect(status).toBe("tampered");
  });
});

describe("deriveVerdict — nested-SVG forgery probe", () => {
  test("nested <svg id=forged> does NOT inflate rendererRootSvgCount when protocol says 1", () => {
    // Shim tries to inflate by counting descendant svgs (forge → 2);
    // protocol authority correctly counts renderer-owned roots only (1).
    const status = deriveVerdict(
      lex({ rendererRootSvgCount: 1 }),
      protocol({ rendererRootSvgCount: 1, graphCount: 1, mermaidNodeCount: 1 }),
      protocol({ rendererRootSvgCount: 1, graphCount: 1 }),
      shim({ rendererRootSvgCount: 2, graphCount: 2 }), // shim naive-counts descendants
      lifecycle(),
    );
    expect(status).toBe("tampered");
  });

  test("clean nested-SVG run: protocol=1 root, shim=1 root (renderer-OWNED) → ok", () => {
    const status = deriveVerdict(
      lex({ rendererRootSvgCount: 1 }),
      protocol({ rendererRootSvgCount: 1, graphCount: 1 }),
      protocol({ rendererRootSvgCount: 1, graphCount: 1 }),
      shim({ rendererRootSvgCount: 1, graphCount: 1 }),
      lifecycle(),
    );
    expect(status).toBe("ok");
  });
});

describe("deriveVerdict — partial channel failures", () => {
  test("shim never produced a report but isolated + protocol agree → probe_only", () => {
    const status = deriveVerdict(lex(), protocol(), protocol(), null, lifecycle());
    expect(status).toBe("probe_only");
  });

  test("isolated world unavailable but shim and protocol agree → shim_only", () => {
    const status = deriveVerdict(lex(), protocol(), null, shim(), lifecycle());
    expect(status).toBe("shim_only");
  });

  test("all channels unavailable → probe_only (least-authoritative label)", () => {
    const status = deriveVerdict(lex(), protocol(), null, null, lifecycle());
    expect(status).toBe("probe_only");
  });

  test("channel-missing statuses still win over opaque-content cap", () => {
    expect(
      deriveVerdict(
        lex(),
        protocol({ opaqueRegionCount: 1 }),
        null,
        shim({ opaqueRegionCount: 1 }),
        lifecycle(),
      ),
    ).toBe("shim_only");
    expect(deriveVerdict(lex(), protocol({ opaqueRegionCount: 1 }), null, null, lifecycle())).toBe(
      "probe_only",
    );
  });
});

describe("deriveVerdict — opaque content", () => {
  test("declared-canvas-healthy: expected opaque 1 and observed opaque 1 → partial:opaque_content", () => {
    expect(
      deriveVerdict(
        lex({ opaqueRegionCount: 1 }),
        protocol({ opaqueRegionCount: 1, visibleSvgCount: 0, viewBoxes: [] }),
        protocol({ opaqueRegionCount: 1, visibleSvgCount: 0, viewBoxes: [] }),
        shim({ opaqueRegionCount: 1, visibleSvgCount: 0 }),
        lifecycle(),
      ),
    ).toBe("partial:opaque_content");
  });

  test("undeclared-smuggled: observed opaque 1 caps mismatched ordinary counts → partial:opaque_content", () => {
    expect(
      deriveVerdict(
        lex({ opaqueRegionCount: 0 }),
        protocol({ opaqueRegionCount: 1, rendererRootSvgCount: 0, mermaidNodeCount: 0 }),
        protocol({ opaqueRegionCount: 1, rendererRootSvgCount: 0, mermaidNodeCount: 0 }),
        shim({ opaqueRegionCount: 1, rendererRootSvgCount: 0, mermaidNodeCount: 0 }),
        lifecycle(),
      ),
    ).toBe("partial:opaque_content");
  });

  test("declared-canvas-zero-rendered: expected opaque 1 and observed opaque 0 → error", () => {
    expect(
      deriveVerdict(
        lex({ opaqueRegionCount: 1 }),
        protocol({ opaqueRegionCount: 0 }),
        protocol({ opaqueRegionCount: 0 }),
        shim({ opaqueRegionCount: 0 }),
        lifecycle(),
      ),
    ).toBe("error");
  });

  test("opaque shim divergence → tampered", () => {
    expect(
      deriveVerdict(
        lex(),
        protocol({ opaqueRegionCount: 1 }),
        protocol({ opaqueRegionCount: 1 }),
        shim({ opaqueRegionCount: 0 }),
        lifecycle(),
      ),
    ).toBe("tampered");
  });

  test("isolated opaque divergence → tampered", () => {
    expect(
      deriveVerdict(
        lex(),
        protocol({ opaqueRegionCount: 1 }),
        protocol({ opaqueRegionCount: 0 }),
        shim({ opaqueRegionCount: 1 }),
        lifecycle(),
      ),
    ).toBe("tampered");
  });

  test("timeout still wins with opaque observed", () => {
    expect(
      deriveVerdict(
        lex({ opaqueRegionCount: 1 }),
        protocol({ opaqueRegionCount: 1 }),
        protocol({ opaqueRegionCount: 1 }),
        shim({ opaqueRegionCount: 1 }),
        lifecycle({ renderComplete: false }),
      ),
    ).toBe("timeout");
  });
});

describe("deriveVerdict — lifecycle and timing", () => {
  test("render-complete never arrived → timeout", () => {
    const status = deriveVerdict(
      lex(),
      protocol({ rendererRootSvgCount: 0, graphCount: 0, errorCount: 0 }),
      protocol({ rendererRootSvgCount: 0, graphCount: 0, errorCount: 0 }),
      null,
      lifecycle({ renderComplete: false }),
    );
    expect(status).toBe("timeout");
  });

  test("geometry not measurable (zeroed viewBoxes, no errors) → partial:layout_unverified", () => {
    const status = deriveVerdict(
      lex(),
      protocol({ viewBoxes: ["0 0 0 0"], visibleSvgCount: 0 }),
      protocol({ viewBoxes: ["0 0 0 0"], visibleSvgCount: 0 }),
      shim({ visibleSvgCount: 0 }),
      lifecycle(),
    );
    expect(status).toBe("partial:layout_unverified");
  });

  test("render-error from protocol with non-empty discriminativeErrors → error", () => {
    const status = deriveVerdict(
      lex(),
      protocol({
        errorCount: 1,
        opaqueRegionCount: 0,
        discriminativeErrors: [{ code: "mermaid_parse_error", message: "bad graph" }],
      }),
      protocol({ errorCount: 1 }),
      shim({ errorCount: 1 }),
      lifecycle(),
    );
    expect(status).toBe("error");
  });
});

describe("deriveVerdict — expected/observed mismatch", () => {
  test("expected 2 mermaid blocks but protocol observed 1 → error", () => {
    const status = deriveVerdict(
      lex({ rendererRootSvgCount: 2, mermaidNodeCount: 4 }),
      protocol({ rendererRootSvgCount: 1, graphCount: 1, mermaidNodeCount: 2 }),
      protocol({ rendererRootSvgCount: 1, graphCount: 1, mermaidNodeCount: 2 }),
      shim({ rendererRootSvgCount: 1, graphCount: 1, mermaidNodeCount: 2 }),
      lifecycle(),
    );
    expect(status).toBe("error");
  });
});
