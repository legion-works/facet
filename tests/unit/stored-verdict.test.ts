/**
 * Unit tests for verdict reconstruction from a stored render run.
 *
 * `verdictFromStoredRun` is the boundary the read-back / export /
 * gallery-source routes cross to turn a SQL row into a typed
 * `Verdict`. The trait we care about for Task 3 is the D10
 * execution marker: it is reconstructed from the revision's
 * declared mode, NOT carried on the render_run row, and is emitted
 * only when the revision is TSX.
 *
 * The pre-arc integration tests already cover the negative case
 * (markdown rows have no execution field on the wire). This file
 * covers the positive case at unit resolution so the
 * reconstruction is pinned independent of the service surface.
 */

import { describe, expect, test } from "bun:test";

import type { Revision, RenderRun } from "../../src/shared/contracts/artifact";
import { verdictFromStoredRun } from "../../src/service/stored-verdict";

const SHA = "a".repeat(64);

function makeRevision(overrides: Partial<Revision> = {}): Revision {
  return {
    id: "rev-1",
    artifactId: "art-1",
    revisionNumber: 1,
    parentRevisionId: null,
    artifactType: "tsx",
    renderer: "svg",
    source: new Uint8Array([1, 2, 3]),
    sha256: SHA,
    note: null,
    pinned: false,
    createdAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<RenderRun> = {}): RenderRun {
  return {
    id: "run-1",
    revisionId: "rev-1",
    tier: 1,
    status: "ok",
    expectedJson: "{}",
    observedJson: JSON.stringify({
      rendererRootSvgCount: 1,
      graphCount: 1,
      mermaidNodeCount: 1,
      visibleSvgCount: 1,
      opaqueRegionCount: 0,
      externalImageCount: 0,
      errorCount: 0,
    }),
    screenshotPath: null,
    consolePath: null,
    screenshotErrorJson: null,
    insecureJson: null,
    retained: false,
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("verdictFromStoredRun — D10 execution marker reconstruction", () => {
  test("tsx revision with execution: static re-emits the marker on read-back", () => {
    const verdict = verdictFromStoredRun(
      makeRevision({ artifactType: "tsx", execution: "static" }),
      makeRun(),
    );
    expect(verdict.execution).toBe("static");
  });

  test("tsx revision with execution: interactive re-emits the marker on read-back", () => {
    const verdict = verdictFromStoredRun(
      makeRevision({ artifactType: "tsx", execution: "interactive" }),
      makeRun({ status: "partial:unstable" }),
    );
    expect(verdict.execution).toBe("interactive");
    expect(verdict.status).toBe("partial:unstable");
  });

  test("non-tsx revisions read back WITHOUT the execution field on the wire", () => {
    // The marker is conditional-spread on artifactType === "tsx".
    // Every other type reads back with the field absent, so the
    // wire form for non-TSX stays byte-identical to the pre-arc
    // shape. The JSON serialization must not contain the string
    // "execution" anywhere.
    for (const artifactType of ["markdown", "mermaid", "svg", "chart", "html"] as const) {
      const verdict = verdictFromStoredRun(makeRevision({ artifactType }), makeRun());
      expect(verdict).not.toHaveProperty("execution");
      expect(JSON.stringify(verdict)).not.toContain('"execution"');
    }
  });

  test("tsx revision with no execution field on the schema still parses (no execution emitted)", () => {
    // Defensive: a TSX revision without an execution column (e.g.
    // a future runtime that forgets to backfill) still parses; the
    // marker is absent rather than a default. The path is exercised
    // by the v8 backfill, which sets `execution: 'static'` for
    // every pre-arc row, so this branch is only reachable under a
    // schema drift.
    const verdict = verdictFromStoredRun(
      makeRevision({ artifactType: "tsx", execution: undefined }),
      makeRun(),
    );
    expect(verdict).not.toHaveProperty("execution");
  });
});
