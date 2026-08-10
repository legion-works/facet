import { describe, expect, test } from "bun:test";

import {
  FACET_SCHEMA_VERSION,
  FacetEnvelopeSchema,
  FacetErrorBodySchema,
  errEnvelope,
  okEnvelope,
  parseEnvelope,
  type FacetEnvelope,
  type FacetErrorBody,
} from "../../src/shared/contracts/envelope";
import {
  ExportSidecarSchema,
  ReadBackResultSchema,
} from "../../src/shared/contracts/commands/results";
import {
  LexicalCountersSchema,
  ProtocolObservationSchema,
  Tier0ResultSchema,
  Tier1ResultSchema,
  VerdictSchema,
  VerdictObservedSchema,
  type HtmlStructureCounts,
} from "../../src/shared/contracts/validation";
import {
  HTML_DENIED_ELEMENTS,
  HTML_STRUCTURAL_GROUPS,
  isAllowedHtmlUrl,
  isHtmlDeniedElement,
  isHtmlEventHandlerAttribute,
  isHtmlInlineStyleAttribute,
  isHtmlUrlBearingAttribute,
} from "../../src/shared/html/policy";

const REQUEST_ID = "req-0001";

const HTML_COUNTS: HtmlStructureCounts = {
  rendererRootCount: 1,
  headingCount: 2,
  tableCount: 1,
  listCount: 1,
  imageCount: 3,
  canvasCount: 0,
  externalImageCount: 2,
};

describe("FACET_SCHEMA_VERSION", () => {
  test("is the literal facet.v1 string", () => {
    expect(FACET_SCHEMA_VERSION).toBe("facet.v1");
  });
});

describe("FacetErrorBody", () => {
  test("accepts primitive details values", () => {
    const body = {
      code: "x",
      message: "y",
      retryable: false,
      details: { a: 1, b: "two", c: true, d: null },
    };
    expect(FacetErrorBodySchema.safeParse(body).success).toBe(true);
  });

  test("rejects non-primitive details values", () => {
    const nested = {
      code: "x",
      message: "y",
      retryable: false,
      details: { a: { nested: "obj" } },
    };
    expect(FacetErrorBodySchema.safeParse(nested).success).toBe(false);
  });

  test("rejects undefined values inside details", () => {
    const undef = {
      code: "x",
      message: "y",
      retryable: false,
      details: { a: undefined },
    };
    expect(FacetErrorBodySchema.safeParse(undef).success).toBe(false);
  });
});

describe("FacetEnvelope (strict discrimination)", () => {
  test("ok:true envelope round-trips with the data payload intact", () => {
    const envelope: FacetEnvelope<{ value: number }> = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { value: 7 },
    };
    const parsed = FacetEnvelopeSchema.parse(envelope);
    expect(parsed).toEqual(envelope);
  });

  test("ok:false envelope round-trips with the error body intact", () => {
    const body: FacetErrorBody = {
      code: "reserved_not_implemented",
      message: "not yet",
      retryable: false,
    };
    const envelope: FacetEnvelope<never> = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: false,
      error: body,
    };
    const parsed = FacetEnvelopeSchema.parse(envelope);
    expect(parsed).toEqual(envelope);
  });

  test("okEnvelope/errEnvelope helpers produce schema-valid envelopes", () => {
    const ok = okEnvelope(REQUEST_ID, { hello: "world" });
    const err = errEnvelope(REQUEST_ID, { code: "x", message: "y", retryable: false });
    expect(FacetEnvelopeSchema.parse(ok).ok).toBe(true);
    expect(FacetEnvelopeSchema.parse(err).ok).toBe(false);
  });

  test("ok:true with an `error` key is REJECTED (strict discrimination)", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { hello: "world" },
      error: { code: "x", message: "y", retryable: false },
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
  });

  test("ok:false with a `data` key is REJECTED (strict discrimination)", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: false,
      error: { code: "x", message: "y", retryable: false },
      data: { hello: "world" },
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
  });

  test("extra top-level key on ok:true is REJECTED", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { hello: "world" },
      extra: "not allowed",
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
  });

  test("extra top-level key on ok:false is REJECTED", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: false,
      error: { code: "x", message: "y", retryable: false },
      debug: "should not survive",
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
  });

  test("missing requestId is REJECTED on ok:true", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      ok: true,
      data: { hello: "world" },
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
  });

  test("missing requestId is REJECTED on ok:false", () => {
    const forged = {
      schemaVersion: FACET_SCHEMA_VERSION,
      ok: false,
      error: { code: "x", message: "y", retryable: false },
    };
    expect(FacetEnvelopeSchema.safeParse(forged).success).toBe(false);
  });
});

describe("parseEnvelope", () => {
  test("unknown schemaVersion 'facet.v2' returns unknown_schema_version", () => {
    const result = parseEnvelope({
      schemaVersion: "facet.v2",
      requestId: REQUEST_ID,
      ok: true,
      data: { hello: "world" },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.body.code).toBe("unknown_schema_version");
      expect(result.body.retryable).toBe(false);
    }
  });

  test("non-object input returns invalid_envelope", () => {
    const result = parseEnvelope("not an envelope");
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.body.code).toBe("invalid_envelope");
    }
  });

  test("valid ok:true envelope round-trips through parseEnvelope", () => {
    const result = parseEnvelope({
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { hello: "world" },
    });
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.envelope).toEqual({
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        ok: true,
        data: { hello: "world" },
      });
    }
  });

  test("valid ok:false envelope round-trips through parseEnvelope", () => {
    const result = parseEnvelope({
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: false,
      error: { code: "x", message: "y", retryable: false },
    });
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.envelope.ok).toBe(false);
    }
  });

  test("forged ok:true+error envelope is rejected by parseEnvelope", () => {
    const result = parseEnvelope({
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { hello: "world" },
      error: { code: "x", message: "y", retryable: false },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.body.code).toBe("invalid_envelope");
    }
  });

  test("stdout serialization purity: JSON.stringify of an envelope is exactly one JSON object with no undefined or functions", () => {
    const envelope: FacetEnvelope<{ count: number; nested: { name: string } }> = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      ok: true,
      data: { count: 3, nested: { name: "x" } },
    };
    const json = JSON.stringify(envelope);
    expect(json).not.toContain("undefined");
    expect(json).not.toContain("[object Object]");
    expect(json).not.toMatch(/function\s/);
    // exactly one top-level object — count of leading `{` must equal one
    expect(json.startsWith("{")).toBe(true);
    const round = JSON.parse(json);
    expect(round).toEqual(envelope);
  });
});

describe("HTML validation observables", () => {
  test("policy centralizes structural tags and rejects dangerous element and attribute forms", () => {
    expect(HTML_STRUCTURAL_GROUPS).toEqual({
      headings: ["h1", "h2", "h3", "h4", "h5", "h6"],
      tables: ["table"],
      lists: ["ul", "ol"],
      images: ["img"],
      canvases: ["canvas"],
    });
    expect(HTML_DENIED_ELEMENTS).toContain("style");
    expect(isHtmlDeniedElement("ScRiPt")).toBe(true);
    expect(isHtmlEventHandlerAttribute("oNcLiCk")).toBe(true);
    expect(isHtmlInlineStyleAttribute("STYLE")).toBe(true);
    expect(isHtmlUrlBearingAttribute("img", "srcset")).toBe(true);
    expect(isHtmlUrlBearingAttribute("a", "href")).toBe(true);
    expect(isHtmlUrlBearingAttribute("div", "href")).toBe(false);
    expect(isAllowedHtmlUrl("img", "src", "https://cdn.example/image.png")).toBe(true);
    expect(isAllowedHtmlUrl("img", "src", "data:image/png;base64,AA==")).toBe(true);
    expect(isAllowedHtmlUrl("img", "src", "../image.png")).toBe(true);
    expect(isAllowedHtmlUrl("img", "src", "//cdn.example/image.png")).toBe(false);
    expect(isAllowedHtmlUrl("a", "href", "mailto:ops@example.test")).toBe(true);
    expect(isAllowedHtmlUrl("a", "href", "#details")).toBe(true);
    expect(isAllowedHtmlUrl("a", "href", "./details")).toBe(true);
    expect(isAllowedHtmlUrl("a", "href", "javascript:alert(1)")).toBe(false);
    expect(isAllowedHtmlUrl("img", "src", "https://[")).toBe(false);
  });

  test("HTML counts round-trip through tier results, read-back, and export sidecars", () => {
    const expected = {
      rendererRootSvgCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      html: HTML_COUNTS,
    };
    const observed = {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      errorCount: 0,
      html: HTML_COUNTS,
    };
    const protocol = {
      ...observed,
      viewBoxes: [],
      discriminativeErrors: [],
    };
    const tier0 = Tier0ResultSchema.parse({
      status: "partial:external_resources",
      tier: 0,
      artifactId: "art-html",
      revisionSha: "a".repeat(64),
      expected,
      observed,
    });
    const tier1 = Tier1ResultSchema.parse({
      ...tier0,
      tier: 1,
      screenshotPath: "/tmp/html.png",
      consolePath: null,
    });

    expect(LexicalCountersSchema.parse(expected).html).toEqual(HTML_COUNTS);
    expect(VerdictObservedSchema.parse(observed).html).toEqual(HTML_COUNTS);
    expect(ProtocolObservationSchema.parse(protocol).html).toEqual(HTML_COUNTS);
    expect(
      ReadBackResultSchema.parse({
        command: "readBack",
        requestId: REQUEST_ID,
        renderer: "svg",
        verdict: tier1,
      }).verdict.observed.html,
    ).toEqual(HTML_COUNTS);
    expect(
      ExportSidecarSchema.parse({
        artifactId: "art-html",
        slug: "html-artifact",
        revisionSha: "a".repeat(64),
        artifactType: "html",
        renderer: "svg",
        verdict: tier1,
        format: "source",
        exportedAt: "2026-08-10T00:00:00.000Z",
      }).verdict.observed.html,
    ).toEqual(HTML_COUNTS);
  });

  test("markdown contract surfaces retain their exact old wire form without html keys", () => {
    const verdictBaseline = {
      status: "ok",
      tier: 1,
      artifactId: "art-markdown",
      revisionSha: "b".repeat(64),
      observed: {
        rendererRootSvgCount: 1,
        graphCount: 1,
        mermaidNodeCount: 2,
        visibleSvgCount: 1,
        opaqueRegionCount: 0,
        errorCount: 0,
      },
    };
    const tier0Baseline = {
      ...verdictBaseline,
      tier: 0,
      expected: {
        rendererRootSvgCount: 1,
        mermaidNodeCount: 2,
        visibleSvgCount: 1,
        opaqueRegionCount: 0,
      },
    };
    const tier1Baseline = {
      ...tier0Baseline,
      tier: 1,
      screenshotPath: null,
      consolePath: null,
    };
    const readBackBaseline = {
      requestId: REQUEST_ID,
      command: "readBack" as const,
      renderer: "svg" as const,
      verdict: verdictBaseline,
    };
    const exportSidecarBaseline = {
      artifactId: "art-markdown",
      slug: "markdown-artifact",
      revisionSha: "b".repeat(64),
      artifactType: "markdown" as const,
      renderer: "svg" as const,
      verdict: verdictBaseline,
      format: "source" as const,
      exportedAt: "2026-08-10T00:00:00.000Z",
    };
    const surfaces = [
      ["VerdictSchema", VerdictSchema.parse(verdictBaseline), verdictBaseline],
      ["Tier0ResultSchema", Tier0ResultSchema.parse(tier0Baseline), tier0Baseline],
      ["Tier1ResultSchema", Tier1ResultSchema.parse(tier1Baseline), tier1Baseline],
      ["ReadBackResultSchema", ReadBackResultSchema.parse(readBackBaseline), readBackBaseline],
      [
        "ExportSidecarSchema",
        ExportSidecarSchema.parse(exportSidecarBaseline),
        exportSidecarBaseline,
      ],
    ] as const;

    for (const [name, actual, baseline] of surfaces) {
      expect(JSON.stringify(actual), name).toBe(JSON.stringify(baseline));
      expect(JSON.stringify(actual), name).not.toContain('"html"');
    }
  });
});
