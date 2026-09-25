import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBackFixture, publishFixture } from "../helpers/facet-testkit";

const EMPTY_FIXTURE = `${import.meta.dir}/../fixtures/tsx/empty-source.tsx`;

test("interactive TSX component returning null reports an empty render", async () => {
  const published = await publishFixture({
    fixturePath: EMPTY_FIXTURE,
    artifactType: "tsx",
    execution: "interactive",
    slug: "tsx-interactive-empty",
    productionTier0: true,
  });
  const verdict = await readBackFixture({
    artifactId: published.artifactId,
    revisionSha: published.revisionSha,
    tier: 1,
  });

  expect({
    status: published.tier1Status,
    execution: verdict.execution,
    observed: verdict.observed,
  }).toEqual({
    status: "partial:empty_render",
    execution: "interactive",
    observed: {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 0,
      emptyRendererRoot: true,
      html: {
        rendererRootCount: 1,
        headingCount: 0,
        tableCount: 0,
        listCount: 0,
        imageCount: 0,
        canvasCount: 0,
        externalImageCount: 0,
      },
      viewBoxes: [],
      errorCount: 0,
      discriminativeErrors: [],
    },
  });
}, 90_000);

test("TSX whitespace-only roots are empty in both modes, visible text and elements are not", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "facet-tsx-content-"));
  try {
    for (const [mode, content, status, empty] of [
      ["interactive", "'   '", "partial:empty_render", true],
      ["interactive", "'Visible text'", "ok", false],
      ["interactive", "<h1>Visible heading</h1>", "ok", false],
      ["static", "null", "partial:empty_render", true],
      ["static", "'   '", "partial:empty_render", true],
      ["static", "'Visible text'", "ok", false],
    ] as const) {
      const fixturePath = join(
        scratch,
        `${mode}-${empty ? "empty" : "content"}-${content.length}.tsx`,
      );
      writeFileSync(
        fixturePath,
        `import React from "react"; export default function Content() { return ${content}; }`,
      );
      const published = await publishFixture({
        fixturePath,
        artifactType: "tsx",
        execution: mode,
        slug: `tsx-content-${mode}-${content.length}`,
        productionTier0: true,
      });
      const verdict = await readBackFixture({
        artifactId: published.artifactId,
        revisionSha: published.revisionSha,
        tier: 1,
      });
      expect({ status: verdict.status, empty: verdict.observed.emptyRendererRoot }).toEqual({
        status,
        empty,
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
