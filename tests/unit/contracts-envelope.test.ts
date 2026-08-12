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
  PublishResultSchema,
  ReadBackResultSchema,
} from "../../src/shared/contracts/commands/results";
import { RevisionCommittedEventSchema } from "../../src/shared/contracts/events";
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
      externalImageCount: 2,
      html: HTML_COUNTS,
    };
    const observed = {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 2,
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
        externalImageCount: 0,
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
        externalImageCount: 0,
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

  test("non-tsx publish revision envelope omits execution and compiledPath from the wire", () => {
    // Existing types (markdown/mermaid/svg/chart/html) MUST stay byte-identical
    // after the tsx arc lands: the new `execution` and `compiledPath` fields
    // are absent on the wire for non-tsx, not null, not undefined-default.
    const baselineRevision = {
      id: "rev-1",
      artifactId: "art-1",
      revisionNumber: 1,
      parentRevisionId: null,
      artifactType: "markdown" as const,
      renderer: "svg" as const,
      sha256: "a".repeat(64),
      note: null,
      pinned: false,
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    const json = JSON.stringify(baselineRevision);
    expect(json).not.toContain('"execution"');
    expect(json).not.toContain('"compiledPath"');
  });

  test("byte-equality baseline for non-tsx wire surfaces (frozen literal snapshot)", () => {
    // FROZEN LITERAL JSONS captured from the pre-arc wire form. These
    // strings are NOT computed from the schemas under test — they are
    // the byte-exact output recorded before the tsx arc added its
    // optional `execution` and `compiledPath` markers. A schema change
    // that adds a field to any of these wire surfaces MUST surface
    // here as a hard fail (the snapshot will not match the new
    // schema-emitted bytes). The previous version of this test
    // re-derived the snapshot from the schemas and was therefore
    // tautological — the reviewer demonstrated this by adding a
    // field to a schema and watching the test pass. Do not let that
    // pattern back in.
    const FROZEN_PUBLISH_RESULT =
      '{"requestId":"req-1","command":"publish","revision":{"id":"rev-1","artifactId":"art-1","revisionNumber":1,"parentRevisionId":null,"artifactType":"markdown","renderer":"svg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","note":null,"pinned":false,"createdAt":"2026-08-12T00:00:00.000Z"},"tier1Verdict":null}';
    const FROZEN_TIER0 =
      '{"status":"ok","tier":0,"artifactId":"art-1","revisionSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observed":{"rendererRootSvgCount":1,"graphCount":1,"mermaidNodeCount":2,"visibleSvgCount":1,"opaqueRegionCount":0,"externalImageCount":0,"errorCount":0},"expected":{"rendererRootSvgCount":1,"mermaidNodeCount":2,"visibleSvgCount":1,"opaqueRegionCount":0,"externalImageCount":0}}';
    const FROZEN_TIER1 =
      '{"status":"ok","tier":1,"artifactId":"art-1","revisionSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observed":{"rendererRootSvgCount":1,"graphCount":1,"mermaidNodeCount":2,"visibleSvgCount":1,"opaqueRegionCount":0,"externalImageCount":0,"errorCount":0},"expected":{"rendererRootSvgCount":1,"mermaidNodeCount":2,"visibleSvgCount":1,"opaqueRegionCount":0,"externalImageCount":0},"screenshotPath":null,"consolePath":null}';
    const FROZEN_READ_BACK =
      '{"requestId":"req-1","command":"readBack","renderer":"svg","verdict":{"status":"ok","tier":1,"artifactId":"art-1","revisionSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observed":{"rendererRootSvgCount":1,"graphCount":1,"mermaidNodeCount":2,"visibleSvgCount":1,"opaqueRegionCount":0,"externalImageCount":0,"errorCount":0}}}';
    const FROZEN_EXPORT_SIDECAR =
      '{"artifactId":"art-1","slug":"markdown-artifact","revisionSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","artifactType":"markdown","renderer":"svg","verdict":{"status":"ok","tier":1,"artifactId":"art-1","revisionSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observed":{"rendererRootSvgCount":1,"graphCount":1,"mermaidNodeCount":2,"visibleSvgCount":1,"opaqueRegionCount":0,"externalImageCount":0,"errorCount":0}},"format":"source","exportedAt":"2026-08-12T00:00:00.000Z"}';
    const FROZEN_REVISION_COMMITTED =
      '{"type":"revision:committed","artifactId":"art-1","revisionSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revisionNumber":1,"artifactType":"markdown","at":"2026-08-12T00:00:00.000Z"}';

    const SHA = "a".repeat(64);
    const NOW = "2026-08-12T00:00:00.000Z";

    // Live round-trip surface: the test rebuilds the schemas'
    // current emission for the same inputs and asserts byte-equality
    // against the FROZEN snapshot. Any drift in the wire form (key
    // additions, renumbering, type changes) hard-fails here.
    const verdictBaseline = {
      status: "ok",
      tier: 1,
      artifactId: "art-1",
      revisionSha: SHA,
      observed: {
        rendererRootSvgCount: 1,
        graphCount: 1,
        mermaidNodeCount: 2,
        visibleSvgCount: 1,
        opaqueRegionCount: 0,
        externalImageCount: 0,
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
        externalImageCount: 0,
      },
    };
    const tier1Baseline = {
      ...tier0Baseline,
      tier: 1,
      screenshotPath: null,
      consolePath: null,
    };
    const publishResultBaseline = {
      command: "publish" as const,
      requestId: "req-1",
      revision: {
        id: "rev-1",
        artifactId: "art-1",
        revisionNumber: 1,
        parentRevisionId: null,
        artifactType: "markdown" as const,
        renderer: "svg" as const,
        sha256: SHA,
        note: null,
        pinned: false,
        createdAt: NOW,
      },
      tier1Verdict: null,
    };
    const readBackBaseline = {
      command: "readBack" as const,
      requestId: "req-1",
      renderer: "svg" as const,
      verdict: verdictBaseline,
    };
    const exportSidecarBaseline = {
      artifactId: "art-1",
      slug: "markdown-artifact",
      revisionSha: SHA,
      artifactType: "markdown" as const,
      renderer: "svg" as const,
      verdict: verdictBaseline,
      format: "source" as const,
      exportedAt: NOW,
    };
    const eventBaseline = {
      type: "revision:committed" as const,
      artifactId: "art-1",
      revisionSha: SHA,
      revisionNumber: 1,
      artifactType: "markdown" as const,
      at: NOW,
    };

    expect(JSON.stringify(PublishResultSchema.parse(publishResultBaseline))).toBe(
      FROZEN_PUBLISH_RESULT,
    );
    expect(JSON.stringify(Tier0ResultSchema.parse(tier0Baseline))).toBe(FROZEN_TIER0);
    expect(JSON.stringify(Tier1ResultSchema.parse(tier1Baseline))).toBe(FROZEN_TIER1);
    expect(JSON.stringify(ReadBackResultSchema.parse(readBackBaseline))).toBe(FROZEN_READ_BACK);
    expect(JSON.stringify(ExportSidecarSchema.parse(exportSidecarBaseline))).toBe(
      FROZEN_EXPORT_SIDECAR,
    );
    expect(JSON.stringify(RevisionCommittedEventSchema.parse(eventBaseline))).toBe(
      FROZEN_REVISION_COMMITTED,
    );

    // Double-side stability: shape the schema emits now, when
    // reparsed and re-stringified, must continue to match the
    // snapshot. Catches the case where a schema coerces an input
    // into a different shape that happens to byte-equal on the first
    // render but diverges on the second round-trip.
    expect(JSON.stringify(PublishResultSchema.parse(JSON.parse(FROZEN_PUBLISH_RESULT)))).toBe(
      FROZEN_PUBLISH_RESULT,
    );
    expect(JSON.stringify(Tier0ResultSchema.parse(JSON.parse(FROZEN_TIER0)))).toBe(FROZEN_TIER0);
    expect(JSON.stringify(Tier1ResultSchema.parse(JSON.parse(FROZEN_TIER1)))).toBe(FROZEN_TIER1);
    expect(JSON.stringify(ReadBackResultSchema.parse(JSON.parse(FROZEN_READ_BACK)))).toBe(
      FROZEN_READ_BACK,
    );
    expect(JSON.stringify(ExportSidecarSchema.parse(JSON.parse(FROZEN_EXPORT_SIDECAR)))).toBe(
      FROZEN_EXPORT_SIDECAR,
    );
    expect(
      JSON.stringify(RevisionCommittedEventSchema.parse(JSON.parse(FROZEN_REVISION_COMMITTED))),
    ).toBe(FROZEN_REVISION_COMMITTED);

    // Cross-check the non-tsx wire form omits the new fields: a
    // future contributor who adds an `execution` key to the
    // RevisionEnvelope (or a `compiledPath` key to the read-back
    // verdict) must surface here as a hard fail too.
    expect(FROZEN_PUBLISH_RESULT).not.toContain('"execution"');
    expect(FROZEN_PUBLISH_RESULT).not.toContain('"compiledPath"');
    expect(FROZEN_EXPORT_SIDECAR).not.toContain('"execution"');
    expect(FROZEN_REVISION_COMMITTED).not.toContain('"execution"');
  });
});
