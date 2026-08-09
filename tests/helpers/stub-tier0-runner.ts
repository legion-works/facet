/**
 * Shared stub Tier 0 runner for integration tests.
 *
 * The real runner lives in `src/validation/tier0/runner.ts` and
 * spawns a netns'd Bun subprocess. Integration tests inject this
 * stub via `startFacetService({ tier0Runner })` so they can exercise
 * the publish path without paying the subprocess cost per test. The
 * stub records what a successful parse would record; tests that
 * specifically need a Tier-0 failure should swap it for a custom
 * runner.
 */

import type { Tier0Input, Tier0Result } from "../../src/shared/contracts/validation";

export const stubTier0Runner = async (input: Tier0Input): Promise<Tier0Result> => {
  return {
    tier: 0,
    status: "ok",
    artifactId: "",
    revisionSha: input.revisionSha,
    expected: input.lexical,
    observed: {
      rendererRootSvgCount: input.lexical.rendererRootSvgCount,
      graphCount: 0,
      mermaidNodeCount: input.lexical.mermaidNodeCount,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      errorCount: 0,
    },
  };
};

export const errorTier0Runner = async (input: Tier0Input): Promise<Tier0Result> => {
  return {
    tier: 0,
    status: "error",
    artifactId: "",
    revisionSha: input.revisionSha,
    expected: input.lexical,
    observed: {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      errorCount: 1,
      discriminativeErrors: [
        {
          code: "test_stub_error",
          message: "stub Tier 0 runner: forced error",
        },
      ],
    },
  };
};
