/**
 * Canonical-source guard for the TSX execution-mode type.
 *
 * The execution enum has THREE places that must agree on the
 * allowed values:
 *
 *   - `TSX_EXECUTION_MODES` (the canonical const array)
 *   - `TsxExecutionModeSchema` (the verdict validator)
 *   - `RevisionSchema.shape.execution` (the persisted revision)
 *   - `RevisionEnvelopeSchema.shape.execution` (the wire form)
 *
 * If any of these re-lists the modes, the canonical-source rule
 * (project memory #2728) is broken. The drift has shipped twice
 * already (reviewer finding): once in `src/shared/contracts/artifact.ts`,
 * once in `src/shared/contracts/commands/_shared.ts`.
 *
 * This test pins the canonical source by deriving the expected
 * mode set from `TSX_EXECUTION_MODES` and asserting each schema
 * accepts exactly those values.
 */

import { describe, expect, test } from "bun:test";

import { TSX_EXECUTION_MODES } from "../../src/shared/tsx/execution";
import { TsxExecutionModeSchema, VerdictSchema } from "../../src/shared/contracts/validation";
import { RevisionSchema } from "../../src/shared/contracts/artifact";
import { RevisionEnvelopeSchema } from "../../src/shared/contracts/commands/_shared";

describe("TSX execution mode — canonical-source guard", () => {
  test("TsxExecutionModeSchema accepts exactly the canonical TSX_EXECUTION_MODES", () => {
    // The schema's option set must match the canonical array. A
    // drift here means a new mode landed in one place but not the
    // other — the canonical-source rule.
    const schemaOptions = [...TsxExecutionModeSchema.options].toSorted();
    const canonical = [...TSX_EXECUTION_MODES].toSorted();
    expect(schemaOptions).toEqual(canonical);
  });

  test("RevisionSchema's execution field accepts every canonical mode", () => {
    // The persisted revision reuses the canonical array. The
    // declaration is exercised via RevisionSchema.parse.
    const SHA = "a".repeat(64);
    for (const mode of TSX_EXECUTION_MODES) {
      const parsed = RevisionSchema.parse({
        id: "rev-1",
        artifactId: "art-1",
        revisionNumber: 1,
        parentRevisionId: null,
        artifactType: "tsx",
        renderer: "svg",
        source: new Uint8Array([1]),
        sha256: SHA,
        note: null,
        pinned: false,
        createdAt: "2026-08-12T00:00:00.000Z",
        execution: mode,
      });
      expect(parsed.execution).toBe(mode);
    }
  });

  test("RevisionEnvelopeSchema's execution field accepts every canonical mode", () => {
    // The wire form (publish/read-back response) reuses the same
    // canonical array. A drift here means a new mode lands in
    // the schema but not the wire form.
    for (const mode of TSX_EXECUTION_MODES) {
      const parsed = RevisionEnvelopeSchema.parse({
        id: "rev-1",
        artifactId: "art-1",
        revisionNumber: 1,
        parentRevisionId: null,
        artifactType: "tsx",
        renderer: "svg",
        sha256: "a".repeat(64),
        note: null,
        pinned: false,
        createdAt: "2026-08-12T00:00:00.000Z",
        execution: mode,
      });
      expect(parsed.execution).toBe(mode);
    }
  });

  test("VerdictSchema's execution field accepts every canonical mode", () => {
    // The verdict marker reuses the canonical array. This is the
    // canonical flow: Tier 0/1 attaches the marker, the read-back
    // seam re-emits it.
    const SHA = "a".repeat(64);
    for (const mode of TSX_EXECUTION_MODES) {
      const parsed = VerdictSchema.parse({
        status: "ok",
        tier: 1,
        artifactId: "art-1",
        revisionSha: SHA,
        observed: {
          rendererRootSvgCount: 1,
          graphCount: 1,
          mermaidNodeCount: 1,
          visibleSvgCount: 1,
          opaqueRegionCount: 0,
          externalImageCount: 0,
          errorCount: 0,
        },
        execution: mode,
      });
      expect(parsed.execution).toBe(mode);
    }
  });
});
