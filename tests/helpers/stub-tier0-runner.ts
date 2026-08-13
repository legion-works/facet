/**
 * Shared stub Tier 0 runner for integration tests.
 *
 * The real runner lives in `src/validation/tier0/runner.ts` and
 * spawns a netns'd Bun subprocess. Integration tests inject this
 * stub via `startFacetService({ tier0Runner })` so they can exercise
 * the publish path without paying the subprocess cost per test. The
 * stub records what a successful parse would record for the
 * html shape (which is the common case most tests need); tests that
 * need real Tier 0 derivation — specifically the markdown external-
 * image disclosure downgrade — inject the production runner via
 * `createTier0Runner(level)` instead so the verdict sees the real
 * external-image count, not a stub-supplied zero.
 *
 * Two integration tests in this suite require the production
 * pipeline end-to-end (see
 * tests/integration/markdown-external-resource-verdict.test.ts);
 * every other test is happy with this stub.
 */

import type { Tier0Input, Tier0Result } from "../../src/shared/contracts/validation";
import { parseHtml } from "../../src/validation/tier0/html";

export const stubTier0Runner = async (input: Tier0Input): Promise<Tier0Result> => {
  if (input.artifactType === "html") {
    const result = parseHtml(input.source);
    const html = result.html;
    return {
      tier: 0,
      status: result.status,
      artifactId: "",
      revisionSha: input.revisionSha,
      expected: {
        ...input.lexical,
        externalImageCount: html.externalImageCount,
        html,
      },
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        opaqueRegionCount: html.canvasCount,
        externalImageCount: html.externalImageCount,
        html,
        errorCount: result.status === "error" ? result.errors.length : 0,
        ...(result.status === "error" ? { discriminativeErrors: [...result.errors] } : {}),
      },
    };
  }
  return {
    tier: 0,
    status: "ok",
    artifactId: "",
    revisionSha: input.revisionSha,
    expected: {
      ...input.lexical,
      externalImageCount: input.lexical.externalImageCount,
    },
    observed: {
      rendererRootSvgCount: input.lexical.rendererRootSvgCount,
      graphCount: 0,
      mermaidNodeCount: input.lexical.mermaidNodeCount ?? 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: input.lexical.externalImageCount,
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
    expected: {
      ...input.lexical,
      externalImageCount: input.lexical.externalImageCount,
    },
    observed: {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: input.lexical.externalImageCount,
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
