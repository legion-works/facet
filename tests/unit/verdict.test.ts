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
  VerdictSchema,
} from "../../src/shared/contracts/validation";
import { deriveVerdict } from "../../src/validation/tier1/verdict";

const lex = (overrides: Partial<LexicalCounters> = {}): LexicalCounters =>
  LexicalCountersSchema.parse({
    rendererRootSvgCount: 1,
    mermaidNodeCount: 1,
    visibleSvgCount: 1,
    opaqueRegionCount: 0,
    externalImageCount: 0,
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
  externalImageCount: 0,
  discriminativeErrors: [],
  ...overrides,
});

const shim = (overrides: Partial<PageShim> = {}): PageShim => ({
  rendererRootSvgCount: 1,
  graphCount: 1,
  mermaidNodeCount: 1,
  visibleSvgCount: 1,
  opaqueRegionCount: 0,
  externalImageCount: 0,
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

  test("insecure marker is attached outside deriveVerdict and does not alter observed errors", () => {
    const status = deriveVerdict(lex(), protocol(), protocol(), shim(), lifecycle());
    expect(status).toBe("ok");
    const discriminativeError = { code: "probe_note", message: "protocol evidence retained" };
    const insecure = { level: 1 as const, reason: "trust unavailable" };
    const verdict = VerdictSchema.parse({
      status,
      tier: 1,
      artifactId: "art-1",
      revisionSha: "a".repeat(64),
      observed: { ...protocol(), discriminativeErrors: [discriminativeError] },
      insecure,
    });
    expect(verdict.insecure).toEqual(insecure);
    expect(verdict.observed.discriminativeErrors).toEqual([discriminativeError]);
    expect((verdict.observed as Record<string, unknown>).insecure).toBeUndefined();
    expect(Object.keys(verdict.observed)).not.toContain("insecure");
  });
});

describe("deriveVerdict — tamper detection (page shim is untrusted)", () => {
  test("canonical comparison applies externalImageCount to shim and isolated channels", () => {
    const expected = lex({ externalImageCount: 1 });
    const observed = protocol({ externalImageCount: 1 });

    expect(
      deriveVerdict(expected, observed, observed, shim({ externalImageCount: 0 }), lifecycle()),
    ).toBe("tampered");
    expect(
      deriveVerdict(
        expected,
        observed,
        protocol({ externalImageCount: 0 }),
        shim({ externalImageCount: 1 }),
        lifecycle(),
      ),
    ).toBe("tampered");
  });

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

  test("undeclared-smuggled: expected mismatch wins before opaque partial", () => {
    expect(
      deriveVerdict(
        lex({ opaqueRegionCount: 0 }),
        protocol({ opaqueRegionCount: 1, rendererRootSvgCount: 0, mermaidNodeCount: 0 }),
        protocol({ opaqueRegionCount: 1, rendererRootSvgCount: 0, mermaidNodeCount: 0 }),
        shim({ opaqueRegionCount: 1, rendererRootSvgCount: 0, mermaidNodeCount: 0 }),
        lifecycle(),
      ),
    ).toBe("error");
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

  test("declared-zero-rendered beats degenerate-layout partial → error", () => {
    expect(
      deriveVerdict(
        lex({ opaqueRegionCount: 1 }),
        protocol({ opaqueRegionCount: 0, visibleSvgCount: 0, viewBoxes: [] }),
        protocol({ opaqueRegionCount: 0, visibleSvgCount: 0, viewBoxes: [] }),
        shim({ opaqueRegionCount: 0, visibleSvgCount: 0 }),
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

describe("deriveVerdict — external resources", () => {
  const externalHtml = {
    rendererRootCount: 1,
    headingCount: 0,
    tableCount: 0,
    listCount: 0,
    imageCount: 1,
    canvasCount: 0,
    externalImageCount: 1,
  };

  test("external HTTPS image references → partial:external_resources", () => {
    expect(
      deriveVerdict(
        lex({ externalImageCount: 1, html: externalHtml }),
        protocol({ externalImageCount: 1, html: externalHtml }),
        protocol({ externalImageCount: 1, html: externalHtml }),
        shim({ externalImageCount: 1, html: externalHtml }),
        lifecycle(),
      ),
    ).toBe("partial:external_resources");
  });

  test("markdown path: external images observed top-level without html subfield → partial:external_resources", () => {
    // Type-agnostic disclosure: markdown artifacts carry no html
    // subfield, but their top-level externalImageCount is the verdict's
    // authority for the partial status.
    expect(
      deriveVerdict(
        lex({ externalImageCount: 1 }),
        protocol({ externalImageCount: 1 }),
        protocol({ externalImageCount: 1 }),
        shim({ externalImageCount: 1 }),
        lifecycle(),
      ),
    ).toBe("partial:external_resources");
  });

  test("opaque content outranks external resources", () => {
    expect(
      deriveVerdict(
        lex({ opaqueRegionCount: 1, externalImageCount: 1, html: externalHtml }),
        protocol({ opaqueRegionCount: 1, externalImageCount: 1, html: externalHtml }),
        protocol({ opaqueRegionCount: 1, externalImageCount: 1, html: externalHtml }),
        shim({ opaqueRegionCount: 1, externalImageCount: 1, html: externalHtml }),
        lifecycle(),
      ),
    ).toBe("partial:opaque_content");
  });

  test("external resources outrank layout-unverified", () => {
    expect(
      deriveVerdict(
        lex({ externalImageCount: 1, html: externalHtml }),
        protocol({ externalImageCount: 1, html: externalHtml, visibleSvgCount: 0, viewBoxes: [] }),
        protocol({ externalImageCount: 1, html: externalHtml, visibleSvgCount: 0, viewBoxes: [] }),
        shim({ visibleSvgCount: 0, externalImageCount: 1, html: externalHtml }),
        lifecycle(),
      ),
    ).toBe("partial:external_resources");
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

describe("deriveVerdict — html trust and structural ordering", () => {
  const cleanHtml = {
    rendererRootCount: 1,
    headingCount: 1,
    tableCount: 1,
    listCount: 1,
    imageCount: 0,
    canvasCount: 0,
    externalImageCount: 0,
  };
  const htmlLex = (html = cleanHtml, overrides: Partial<LexicalCounters> = {}) =>
    lex({
      rendererRootSvgCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      html,
      ...overrides,
    });
  const htmlProtocol = (html = cleanHtml, overrides: Partial<ProtocolObservation> = {}) =>
    protocol({
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      viewBoxes: [],
      html,
      ...overrides,
    });
  const htmlShim = (html = cleanHtml, overrides: Partial<PageShim> = {}) =>
    shim({
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      html,
      ...overrides,
    });

  test("shim html divergence is tampered before external partial", () => {
    const external = { ...cleanHtml, imageCount: 1 };
    expect(
      deriveVerdict(
        htmlLex(external, { externalImageCount: 1 }),
        htmlProtocol(external, { externalImageCount: 1 }),
        htmlProtocol(external, { externalImageCount: 1 }),
        htmlShim({ ...external, headingCount: 9 }, { externalImageCount: 1 }),
        lifecycle(),
      ),
    ).toBe("tampered");
  });

  test("isolated html divergence is tampered", () => {
    expect(
      deriveVerdict(
        htmlLex(),
        htmlProtocol(),
        htmlProtocol({ ...cleanHtml, tableCount: 0 }),
        htmlShim(),
        lifecycle(),
      ),
    ).toBe("tampered");
  });

  test("expected and observed html mismatch is error before partial statuses", () => {
    const external = { ...cleanHtml, imageCount: 1 };
    expect(
      deriveVerdict(
        htmlLex(external, { externalImageCount: 1 }),
        htmlProtocol({ ...external, headingCount: 0 }, { externalImageCount: 1 }),
        htmlProtocol({ ...external, headingCount: 0 }, { externalImageCount: 1 }),
        htmlShim({ ...external, headingCount: 0 }, { externalImageCount: 1 }),
        lifecycle(),
      ),
    ).toBe("error");
  });

  test("matching external image is partial external resources", () => {
    const external = { ...cleanHtml, imageCount: 1 };
    expect(
      deriveVerdict(
        htmlLex(external, { externalImageCount: 1 }),
        htmlProtocol(external, { externalImageCount: 1 }),
        htmlProtocol(external, { externalImageCount: 1 }),
        htmlShim(external, { externalImageCount: 1 }),
        lifecycle(),
      ),
    ).toBe("partial:external_resources");
  });

  test("matching canvas plus external image is partial opaque content", () => {
    const both = { ...cleanHtml, imageCount: 1, canvasCount: 1 };
    expect(
      deriveVerdict(
        htmlLex(both, { externalImageCount: 1 }),
        htmlProtocol(both, { opaqueRegionCount: 1, externalImageCount: 1 }),
        htmlProtocol(both, { opaqueRegionCount: 1, externalImageCount: 1 }),
        htmlShim(both, { opaqueRegionCount: 1, externalImageCount: 1 }),
        lifecycle(),
      ),
    ).toBe("partial:opaque_content");
  });

  test("matching plain html is ok without an SVG layout", () => {
    expect(deriveVerdict(htmlLex(), htmlProtocol(), htmlProtocol(), htmlShim(), lifecycle())).toBe(
      "ok",
    );
  });

  test("clean html with zero viewBoxes still verdicts ok (layout axis does not apply)", () => {
    // SHOULD-3 gate documented in the verdict precedence docblock:
    // HTML artifacts have no viewBox axis, so the layout-observability
    // branch is structurally unreachable for them. A clean HTML
    // artifact with visibleSvgCount=0 and viewBoxes=[] returns ok when
    // counts match.
    expect(deriveVerdict(htmlLex(), htmlProtocol(), htmlProtocol(), htmlShim(), lifecycle())).toBe(
      "ok",
    );
  });
});

describe("deriveVerdict — unstable (D11)", () => {
  // D11: a TSX interactive artifact that rendered once at the barrier
  // and rendered a different structure at the stability window earns
  // `partial:unstable`. NOT `tampered` — a legitimately animated or
  // async-loading component also changes structure between
  // observations, and branding it a forgery would manufacture the
  // exact false-verdict class this project has spent three arcs
  // eliminating. `tampered` stays reserved for channel divergence.
  const stable = lifecycle({ structureChanged: false });
  const unstable = lifecycle({ structureChanged: true });

  test("clean counts with changed structure between snapshots → partial:unstable", () => {
    expect(deriveVerdict(lex(), protocol(), protocol(), shim(), unstable)).toBe("partial:unstable");
  });

  test("unstable outranks opaque content when both could apply", () => {
    // Pin the precedence: the verifier cannot honestly claim "this
    // artifact has structure X" when structure is changing between
    // observations. Single-snapshot partial claims (opaque, external,
    // layout) are moot when the structure is unstable.
    expect(
      deriveVerdict(
        lex({ opaqueRegionCount: 1 }),
        protocol({ opaqueRegionCount: 1, visibleSvgCount: 0, viewBoxes: [] }),
        protocol({ opaqueRegionCount: 1, visibleSvgCount: 0, viewBoxes: [] }),
        shim({ opaqueRegionCount: 1, visibleSvgCount: 0 }),
        unstable,
      ),
    ).toBe("partial:unstable");
  });

  test("unstable outranks external resources when both could apply", () => {
    expect(
      deriveVerdict(
        lex({ externalImageCount: 1 }),
        protocol({ externalImageCount: 1 }),
        protocol({ externalImageCount: 1 }),
        shim({ externalImageCount: 1 }),
        unstable,
      ),
    ).toBe("partial:unstable");
  });

  test("unstable outranks layout-unverified when both could apply", () => {
    expect(
      deriveVerdict(
        lex(),
        protocol({ viewBoxes: ["0 0 0 0"], visibleSvgCount: 0 }),
        protocol({ viewBoxes: ["0 0 0 0"], visibleSvgCount: 0 }),
        shim({ visibleSvgCount: 0 }),
        unstable,
      ),
    ).toBe("partial:unstable");
  });

  test("channel divergence + structure change → tampered (channel wins)", () => {
    // Tampered is reserved for channel divergence — the page
    // contradicting protocol authority. Structure change is a
    // different claim class. Channel divergence is the more
    // catastrophic reading of the page's behavior and wins.
    expect(
      deriveVerdict(
        lex(),
        protocol({ rendererRootSvgCount: 0, errorCount: 1 }),
        protocol({ rendererRootSvgCount: 2, errorCount: 0 }),
        shim({ rendererRootSvgCount: 2, errorCount: 0 }),
        unstable,
      ),
    ).toBe("tampered");
  });

  test("lifecycle renderComplete=false still wins with structure change", () => {
    expect(
      deriveVerdict(
        lex(),
        protocol({ rendererRootSvgCount: 0, graphCount: 0, errorCount: 0 }),
        protocol({ rendererRootSvgCount: 0, graphCount: 0, errorCount: 0 }),
        null,
        lifecycle({ renderComplete: false, structureChanged: true }),
      ),
    ).toBe("timeout");
  });

  test("structureChanged defaults to false (back-compat for non-interactive runs)", () => {
    // The lifecycle helper omits `structureChanged` for non-TSX
    // runs. The verdict must report the same status as before:
    // `ok` for clean counts.
    expect(deriveVerdict(lex(), protocol(), protocol(), shim(), lifecycle())).toBe("ok");
  });

  test("structureChanged=false with opaque observed → partial:opaque_content (no change)", () => {
    // Negative space: the new field exists but the value is false.
    // The opaque path must still run, so ad-hoc callers that
    // explicitly opt out of the stability window keep the legacy
    // semantics.
    expect(
      deriveVerdict(
        lex({ opaqueRegionCount: 1 }),
        protocol({ opaqueRegionCount: 1, visibleSvgCount: 0, viewBoxes: [] }),
        protocol({ opaqueRegionCount: 1, visibleSvgCount: 0, viewBoxes: [] }),
        shim({ opaqueRegionCount: 1, visibleSvgCount: 0 }),
        stable,
      ),
    ).toBe("partial:opaque_content");
  });
});
