/**
 * Unit tests for verdict enrichment.
 *
 * `enrichVerdict` is the on-write path that binds a worker result
 * to its (artifactId, revisionSha) pair and attaches the optional
 * `insecure` and `execution` markers. The traits we care about for
 * Task 3 are:
 *
 *   - the execution marker is conditional-spread so non-TSX
 *     verdicts stay BYTE-IDENTICAL to the pre-arc wire shape
 *     (the field is absent, not null),
 *   - the execution marker is preserved through the enrichment
 *     for TSX static and interactive verdicts.
 *
 * The dispatcher tests cover the marshaling path; this file pins
 * the enrichment helper at unit resolution so a future regression
 * in the helper is caught before it propagates.
 */

import { describe, expect, test } from "bun:test";

import { enrichVerdict } from "../../src/service/verdict-enrichment";

const SHA = "a".repeat(64);

const baseObserved = {
  rendererRootSvgCount: 1,
  graphCount: 1,
  mermaidNodeCount: 1,
  visibleSvgCount: 1,
  opaqueRegionCount: 0,
  externalImageCount: 0,
  errorCount: 0,
};

const baseExpected = {
  rendererRootSvgCount: 1,
  mermaidNodeCount: 1,
  visibleSvgCount: 1,
  opaqueRegionCount: 0,
  externalImageCount: 0,
};

describe("enrichVerdict — D10 execution marker", () => {
  test("attaches execution when provided", () => {
    const enriched = enrichVerdict(
      { tier: 0, status: "ok", expected: baseExpected, observed: baseObserved },
      "art-1",
      SHA,
      undefined,
      "static",
    );
    expect(enriched.execution).toBe("static");
  });

  test("omits execution when not provided (non-TSX / pre-arc wire shape)", () => {
    const enriched = enrichVerdict(
      { tier: 0, status: "ok", expected: baseExpected, observed: baseObserved },
      "art-1",
      SHA,
    );
    expect(enriched).not.toHaveProperty("execution");
    expect(JSON.stringify(enriched)).not.toContain('"execution"');
  });

  test("preserves insecure marker when both insecure and execution are set", () => {
    const enriched = enrichVerdict(
      { tier: 0, status: "insecure:unvalidated", expected: baseExpected, observed: baseObserved },
      "art-1",
      SHA,
      { level: 3, reason: "manual" },
      "interactive",
    );
    expect(enriched.insecure).toEqual({ level: 3, reason: "manual" });
    expect(enriched.execution).toBe("interactive");
  });

  test("preserves the artifactId / revisionSha binding even when markers are omitted", () => {
    const enriched = enrichVerdict(
      { tier: 0, status: "ok", expected: baseExpected, observed: baseObserved },
      "art-1",
      SHA,
    );
    expect(enriched.artifactId).toBe("art-1");
    expect(enriched.revisionSha).toBe(SHA);
  });
});
