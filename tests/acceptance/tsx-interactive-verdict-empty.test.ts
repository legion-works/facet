import { expect, test } from "bun:test";

import { readBackFixture, publishFixture } from "../helpers/facet-testkit";

const EMPTY_FIXTURE = `${import.meta.dir}/../fixtures/tsx/empty-source.tsx`;

test("interactive TSX component returning null remains an honest ok verdict", async () => {
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

  // A null component cannot distinguish an honest empty render from a missed mount;
  // the stable-counter row's headingCount=1 is the mount discriminator.
  expect({
    status: published.tier1Status,
    execution: verdict.execution,
    observed: verdict.observed,
  }).toEqual({
    status: "ok",
    execution: "interactive",
    observed: {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 0,
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
