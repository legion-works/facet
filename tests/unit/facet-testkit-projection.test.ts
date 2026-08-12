/**
 * Schema-derived key-set guard for the acceptance-test harness.
 *
 * The test harness's `readBackFixture` projects a canonical `Verdict`
 * (parsed from the wire) down to the acceptance surface
 * (`AcceptanceVerdict`). The projection is the same field-by-field
 * class the production client fix eliminated — every field added
 * since the helper was written was silently dropped:
 *
 *   - `externalImageCount` and `viewBoxes` (HTML arc)
 *   - `discriminativeErrors` (declared in the interface but not
 *     filled by the projection)
 *   - `execution` (Task 3)
 *   - `mermaidNodeCount`, `visibleSvgCount` (HTML/visualization)
 *
 * This guard derives the expected key set from the canonical schema
 * and asserts the projection carries every one. A new
 * `VerdictObservedSchema` field that fails to surface in the
 * acceptance harness now hard-fails the test — the same class the
 * production client fix pinned, but pointed at the test harness.
 *
 * The harness is what SEVEN acceptance tests observe verdicts
 * through (adversarial-render, gate-forgery, harness-recovery,
 * canvas-chart-tier1, screenshot-evidence-failure, insecure-sandbox,
 * html-tier1-status). If the harness drops a field, an acceptance
 * test cannot assert on it, so a whole class of regression becomes
 * structurally invisible to the gates that exist to catch it.
 * `externalImageCount` is the disclosure channel — no acceptance
 * test can currently check it end-to-end.
 */

import { describe, expect, test } from "bun:test";

import { projectToAcceptanceVerdict } from "../helpers/facet-testkit";
import {
  VerdictObservedSchema,
  VerdictSchema,
  type Verdict,
} from "../../src/shared/contracts/validation";

const SHA = "a".repeat(64);

function makeVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return VerdictSchema.parse({
    status: "partial:external_resources",
    tier: 1,
    artifactId: "art-1",
    revisionSha: SHA,
    observed: {
      rendererRootSvgCount: 1,
      graphCount: 1,
      mermaidNodeCount: 1,
      visibleSvgCount: 1,
      opaqueRegionCount: 0,
      externalImageCount: 3,
      viewBoxes: ["0 0 100 100"],
      errorCount: 0,
      html: {
        rendererRootCount: 1,
        headingCount: 0,
        tableCount: 0,
        listCount: 0,
        imageCount: 0,
        canvasCount: 0,
        externalImageCount: 0,
      },
      discriminativeErrors: [],
    },
    execution: "static",
    ...overrides,
  });
}

describe("projectToAcceptanceVerdict — schema-derived key-set guard", () => {
  test("the projection carries every VerdictObservedSchema key", () => {
    // The verdict is fully populated (every observed field present
    // on the wire). The projection must pass every one through.
    const verdict = makeVerdict();
    const projected = projectToAcceptanceVerdict({
      renderer: "svg",
      verdict,
    });
    const expectedObservedKeys = Object.keys(VerdictObservedSchema.shape).toSorted();
    const actualObservedKeys = Object.keys(projected.observed).toSorted();
    expect(actualObservedKeys).toEqual(expectedObservedKeys);
  });

  test("the projection carries the execution marker for TSX rows", () => {
    // Tasks 6-9 will need this. The pre-fix interface dropped
    // `execution` entirely, so no acceptance test could assert on
    // it. After the projection passes through, the top-level
    // marker is on the surface.
    const verdict = makeVerdict({ execution: "interactive" });
    const projected = projectToAcceptanceVerdict({
      renderer: "svg",
      verdict,
    });
    expect(projected.execution).toBe("interactive");
  });

  test("the projection carries the previously-dropped fields end-to-end", () => {
    // Pin each previously-dropped field individually. A regression
    // that drops ONE of them now hard-fails even if the rest
    // round-trip cleanly.
    const verdict = makeVerdict();
    const projected = projectToAcceptanceVerdict({
      renderer: "svg",
      verdict,
    });
    expect(projected.observed.externalImageCount).toBe(3);
    expect(projected.observed.viewBoxes).toEqual(["0 0 100 100"]);
    expect(projected.observed.discriminativeErrors).toEqual([]);
    expect(projected.observed.html).toBeDefined();
    expect(projected.observed.mermaidNodeCount).toBe(1);
    expect(projected.observed.visibleSvgCount).toBe(1);
  });

  test("the projection carries the top-level optional markers (insecure, screenshotError)", () => {
    // The verdict may carry `insecure` and `screenshotError` markers;
    // the projection must pass them through.
    const verdict = makeVerdict({
      insecure: { level: 1, reason: "manual insecure level 1" },
      screenshotError: { code: "screenshot_unavailable", message: "capture failed" },
    });
    const projected = projectToAcceptanceVerdict({
      renderer: "svg",
      verdict,
    });
    expect(projected.insecure).toEqual({
      level: 1,
      reason: "manual insecure level 1",
    });
    expect(projected.screenshotError).toEqual({
      code: "screenshot_unavailable",
      message: "capture failed",
    });
  });

  test("the projection does not synthesize fields the verdict does not carry", () => {
    // A verdict without `execution` (non-TSX) must NOT have a
    // synthesized marker on the projection. A verdict without
    // `insecure` must NOT have one. The projection is faithful.
    const verdict = makeVerdict({ execution: undefined });
    const projected = projectToAcceptanceVerdict({
      renderer: "svg",
      verdict,
    });
    expect(projected).not.toHaveProperty("execution");
    expect(projected.insecure).toBeUndefined();
    expect(projected.screenshotError).toBeUndefined();
  });
});
