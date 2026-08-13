/**
 * Per-consumer characterization of the five shipped types under the
 * unchanged frozen CSP. Exact projected payloads are the regression net
 * for any future directive edit.
 */
import { expect, test } from "bun:test";

import {
  publishFixture,
  projectToAcceptanceVerdict,
  readBackFixtureRaw,
} from "../helpers/facet-testkit";

const fixture = (name: string): string => `${import.meta.dir}/../fixtures/${name}`;

const CONSUMERS = [
  // Markdown headings and links do not move the observed renderer counters;
  // this row is dominated by its Mermaid fence. Independent markdown proof
  // would require a markdown-specific observable beyond the current shape.
  {
    key: "markdown",
    artifactType: "markdown" as const,
    fixture: "markdown-heading-link.md",
    slug: "csp-md",
  },
  {
    key: "mermaid",
    artifactType: "mermaid" as const,
    fixture: "mermaid-flowchart.md",
    slug: "csp-mermaid",
  },
  { key: "svg", artifactType: "svg" as const, fixture: "svg-clean.svg", slug: "csp-svg" },
  {
    key: "chart",
    artifactType: "chart" as const,
    fixture: "chart-barline.vl.json",
    slug: "csp-chart",
  },
  { key: "html", artifactType: "html" as const, fixture: "html-clean.html", slug: "csp-html" },
  {
    key: "html-external",
    artifactType: "html" as const,
    fixture: "html-csp-external-image.html",
    slug: "csp-html-external",
  },
] as const;

function projectConsumer(verdict: ReturnType<typeof projectToAcceptanceVerdict>) {
  return {
    status: verdict.status,
    execution: verdict.execution,
    observed: {
      rendererRootSvgCount: verdict.observed.rendererRootSvgCount,
      graphCount: verdict.observed.graphCount,
      mermaidNodeCount: verdict.observed.mermaidNodeCount,
      visibleSvgCount: verdict.observed.visibleSvgCount,
      opaqueRegionCount: verdict.observed.opaqueRegionCount,
      externalImageCount: verdict.observed.externalImageCount,
      html: verdict.observed.html,
      viewBoxes: verdict.observed.viewBoxes,
      discriminativeErrors: verdict.observed.discriminativeErrors,
    },
  };
}

const CONSUMER_BASELINE: Record<string, ReturnType<typeof projectConsumer>> = {
  markdown: {
    status: "ok",
    execution: undefined,
    observed: {
      rendererRootSvgCount: 1,
      graphCount: 1,
      mermaidNodeCount: 2,
      visibleSvgCount: 1,
      opaqueRegionCount: 0,
      externalImageCount: 0,
      html: undefined,
      viewBoxes: ["0 0 114.3515625 160"],
      discriminativeErrors: [],
    },
  },
  mermaid: {
    status: "ok",
    execution: undefined,
    observed: {
      rendererRootSvgCount: 1,
      graphCount: 1,
      mermaidNodeCount: 2,
      visibleSvgCount: 1,
      opaqueRegionCount: 0,
      externalImageCount: 0,
      html: undefined,
      viewBoxes: ["0 0 114.3515625 160"],
      discriminativeErrors: [],
    },
  },
  svg: {
    status: "ok",
    execution: undefined,
    observed: {
      rendererRootSvgCount: 1,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 1,
      opaqueRegionCount: 0,
      externalImageCount: 0,
      html: undefined,
      viewBoxes: ["0 0 10 10"],
      discriminativeErrors: [],
    },
  },
  chart: {
    status: "ok",
    execution: undefined,
    observed: {
      rendererRootSvgCount: 1,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 1,
      opaqueRegionCount: 0,
      externalImageCount: 0,
      html: undefined,
      viewBoxes: ["0 0 169 345"],
      discriminativeErrors: [],
    },
  },
  html: {
    status: "ok",
    execution: undefined,
    observed: {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 0,
      html: {
        rendererRootCount: 1,
        headingCount: 2,
        tableCount: 1,
        listCount: 1,
        imageCount: 0,
        canvasCount: 0,
        externalImageCount: 0,
      },
      viewBoxes: [],
      discriminativeErrors: [],
    },
  },
  "html-external": {
    status: "partial:external_resources",
    execution: undefined,
    observed: {
      rendererRootSvgCount: 0,
      graphCount: 0,
      mermaidNodeCount: 0,
      visibleSvgCount: 0,
      opaqueRegionCount: 0,
      externalImageCount: 1,
      html: {
        rendererRootCount: 1,
        headingCount: 1,
        tableCount: 1,
        listCount: 0,
        imageCount: 1,
        canvasCount: 0,
        externalImageCount: 1,
      },
      viewBoxes: [],
      discriminativeErrors: [],
    },
  },
};

test("existing artifact consumers keep their projected payload under the unchanged frozen CSP", async () => {
  const rows: Record<string, ReturnType<typeof projectConsumer>> = {};
  for (const consumer of CONSUMERS) {
    const published = await publishFixture({
      fixturePath: fixture(consumer.fixture),
      artifactType: consumer.artifactType,
      slug: consumer.slug,
      productionTier0: true,
    });
    const raw = await readBackFixtureRaw({
      artifactId: published.artifactId,
      revisionSha: published.revisionSha,
      tier: 1,
      productionTier0: true,
    });
    expect("compiled" in raw.verdict, `${consumer.key} read-back compiled payload`).toBe(false);
    rows[consumer.key] = projectConsumer(projectToAcceptanceVerdict(raw));
  }
  for (const [type, row] of Object.entries(rows)) {
    expect(row.execution, type).toBeUndefined();
    const counts = [
      row.observed.rendererRootSvgCount,
      row.observed.graphCount,
      row.observed.mermaidNodeCount,
      row.observed.visibleSvgCount,
      row.observed.opaqueRegionCount,
      row.observed.externalImageCount,
      row.observed.html?.headingCount ?? 0,
      row.observed.html?.tableCount ?? 0,
    ];
    expect(
      counts.some((count) => count > 0),
      `${type} has a meaningful count`,
    ).toBe(true);
  }
  expect(rows).toEqual(CONSUMER_BASELINE);
}, 180_000);
