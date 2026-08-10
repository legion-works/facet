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
import { parseHtml } from "../../src/validation/tier0/html";
import { deriveVerdict } from "../../src/validation/tier1/verdict";

export const stubTier0Runner = async (input: Tier0Input): Promise<Tier0Result> => {
  if (input.artifactType === "html") {
    const result = parseHtml(input.source);
    const html = result.html;
    const expected = { ...input.lexical, externalImageCount: html.externalImageCount, html };
    const observed = {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: html.canvasCount,
      externalImageCount: html.externalImageCount,
      html,
      errorCount: result.status === "error" ? result.errors.length : 0,
      ...(result.status === "error" ? { discriminativeErrors: [...result.errors] } : {}),
    };
    const status = result.status === "error" ? "error" : deriveStatus(observed, expected);
    return {
      tier: 0,
      status,
      artifactId: "",
      revisionSha: input.revisionSha,
      expected,
      observed,
    };
  }
  if (input.artifactType === "markdown") {
    const { parseMarkdown } = await import("../../src/validation/tier0/markdown");
    const result = parseMarkdown(input.source);
    if (result.status === "error") {
      return {
        tier: 0,
        status: "error",
        artifactId: "",
        revisionSha: input.revisionSha,
        expected: input.lexical,
        observed: {
          ...result.observed,
          discriminativeErrors: [...result.errors],
        },
      };
    }
    const observed = result.observed;
    const expected = { ...input.lexical, externalImageCount: result.observed.externalImageCount };
    const status = deriveStatus(observed, expected);
    return {
      tier: 0,
      status,
      artifactId: "",
      revisionSha: input.revisionSha,
      expected,
      observed,
    };
  }
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
      externalImageCount: input.lexical.externalImageCount,
      errorCount: 0,
    },
  };
};

// Compute the verdict status the real pipeline would emit for a clean
// Tier 0 observation. Mirrors the type-agnostic rules in
// `src/validation/tier1/verdict.ts` — the stub does not run a real
// browser, but it must surface `partial:external_resources` when the
// lexical expectation or the observation carries an external image
// count, so read-back reflects what production would say.
function deriveStatus(
  observed: Tier0Result["observed"],
  expected: Tier0Result["expected"],
): Tier0Result["status"] {
  const protocolObservation = {
    rendererRootSvgCount: 0,
    graphCount: 0,
    mermaidNodeCount: 0,
    visibleSvgCount: observed.visibleSvgCount,
    viewBoxes: [],
    errorCount: observed.errorCount,
    opaqueRegionCount: observed.opaqueRegionCount,
    externalImageCount: observed.externalImageCount,
    ...(observed.html === undefined ? {} : { html: observed.html }),
    discriminativeErrors: observed.discriminativeErrors ?? [],
  };
  // The stub does not run a browser, so neither the page-shim nor the
  // isolated channel exists. Pass shim/isolated as protocol-mirroring
  // stand-ins so the verdict layer can reach the partial branches
  // (external_resources / opaque_content) instead of falling through
  // to `probe_only` for the absence of those channels.
  return deriveVerdict(
    expected,
    protocolObservation,
    protocolObservation,
    {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: observed.visibleSvgCount,
      opaqueRegionCount: observed.opaqueRegionCount,
      externalImageCount: observed.externalImageCount,
      errorCount: observed.errorCount,
      ...(observed.html === undefined ? {} : { html: observed.html }),
    },
    { bootReady: true, renderComplete: true },
  );
}

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
      externalImageCount: 0,
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
