/**
 * Two-viewport geometry gate.
 *
 * The recorded failure record behind this file: a wide diagram
 * squeezed to an unreadable strip, a tall artifact with no reachable
 * scrollbar, and jail clipping — all found by an operator looking at
 * the actual rendered pixels, none of them caught by a single fixed
 * viewport. One document does not make layout failures impossible;
 * this file is the mandatory viewport-level gate instead — every
 * fixture below is asserted at BOTH 1280x720 and 1920x1080, and the
 * assertions are chosen so a fit-to-container squeeze (scrollWidth
 * collapsing toward clientWidth) or a lost-scrollbar regression fails
 * loudly regardless of which viewport exposed it.
 *
 * ONE browser launch for the whole file (the acceptance-modules launch
 * budget in `tests/unit/acceptance-browser-launch-budget.test.ts`
 * counts `probeAvailability()` calls together with `launch()` calls —
 * this file uses neither more than once).
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient } from "../../src/cli/client";
import { startFacetService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { createTier0RunnerForTests } from "../../src/validation/tier0/runner";
import type { ArtifactType } from "../../src/shared/contracts/artifact-types";
import type { Renderer } from "../../src/shared/contracts/renderers";
import {
  captureGalleryScreenshot,
  clickGalleryControl,
  galleryBrowser,
  navigateToArtifact,
  readArtifactGeometry,
  readShellToolbarRect,
  setGalleryViewport,
  type ArtifactGeometry,
  type GalleryTarget,
} from "../helpers/gallery-live";

const FIXTURES_DIR = join(import.meta.dir, "../fixtures/gallery-geometry");
const SCREENSHOT_DIR = join(import.meta.dir, "../../test-results/gallery-geometry");

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
] as const;

interface GeometryCase {
  readonly key: string;
  readonly artifactType: ArtifactType;
  readonly fixture: string;
  /** Override the default `FIXTURES_DIR` join — for fixtures shared with other test suites (e.g. the templates/ dashboards). */
  readonly fixtureDir?: string;
  readonly execution?: "static" | "interactive";
  readonly renderer?: Renderer;
  readonly assert: (geometry: ArtifactGeometry, width: number) => void;
}

const CASES: readonly GeometryCase[] = [
  {
    key: "wide-flowchart",
    artifactType: "mermaid",
    fixture: "wide-flowchart.mmd",
    assert: (geometry) => {
      // The jail regression this fixture pins: a wide diagram
      // fit-to-container reads scrollWidth \u2248 clientWidth. Natural
      // sizing overflows the stage instead.
      expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
    },
  },
  {
    key: "tall-state",
    artifactType: "mermaid",
    fixture: "tall-state.mmd",
    assert: (geometry) => {
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    },
  },
  {
    key: "long-report",
    artifactType: "markdown",
    fixture: "long-report.md",
    assert: (geometry, width) => {
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
      // Readable-measure contract: the document column is capped at
      // ~92ch regardless of how wide the viewport gets — a wide-open
      // 1920px stage must not stretch markdown to an unreadable line
      // length.
      if (width === 1920) {
        expect(geometry.rootWidth).toBeLessThanOrEqual(1000);
      }
    },
  },
  {
    key: "small-diagram",
    artifactType: "mermaid",
    fixture: "small-diagram.mmd",
    assert: (geometry) => {
      // Centering contract: a diagram small enough to fit the stage
      // sits centered on both axes — equal left/right gutters. `safe
      // center` is the mechanism; this assertion is what would fail if
      // it silently regressed to a plain, unsafe `center`.
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 2);
      expect(Math.abs(geometry.rootLeft - geometry.rootRight)).toBeLessThanOrEqual(2);
    },
  },
  {
    key: "responsive-dashboard",
    artifactType: "tsx",
    fixture: "responsive-dashboard.tsx",
    execution: "interactive",
    assert: (geometry, width) => {
      expect(geometry.columnCount).toBe(width === 1280 ? 2 : 3);
    },
  },
  {
    key: "canvas-chart",
    artifactType: "chart",
    fixture: "canvas-chart.vl.json",
    renderer: "canvas",
    assert: (geometry) => {
      expect(geometry.canvasCount).toBe(1);
    },
  },
  {
    key: "html-dashboard",
    artifactType: "html",
    fixture: "fleet-dashboard.html",
    fixtureDir: join(import.meta.dir, "../../templates"),
    assert: (geometry, width) => {
      // UX-4 centering contract, extended from the mermaid "small-diagram"
      // case to a native html artifact: fleet-dashboard.html's <main> is a
      // fixed ~672px (max-w-2xl) column — narrower than the 1920px stage
      // — so it must sit centered horizontally (equal left/right gutters).
      // `contentLeft`/`contentRight` (not `rootLeft`/`rootRight`) because
      // the html renderer always mounts a full-width wrapper as
      // `#artifact`'s only child — the fixture's own narrow content is a
      // grandchild, one level deeper.
      if (width === 1920) {
        expect(Math.abs(geometry.contentLeft - geometry.contentRight)).toBeLessThanOrEqual(2);
      }
    },
  },
];

/**
 * Every case, regardless of fixture, must satisfy the baseline overflow
 * contract (never smaller than the visible frame) plus the zoom/reset
 * round trip: zooming in grows the artifact's rendered root while the
 * iframe box itself stays fixed (the shell never CSS-transforms the
 * iframe \u2014 see `gallery-shell-start.test.ts`), and reset returns to
 * zoom 1 with the frame document's own scroll position at the origin.
 */
function assertBaselineOverflow(geometry: ArtifactGeometry): void {
  expect(geometry.scrollWidth).toBeGreaterThanOrEqual(geometry.clientWidth);
  expect(geometry.scrollHeight).toBeGreaterThanOrEqual(geometry.clientHeight);
}

async function assertZoomRoundTrip(target: GalleryTarget, before: ArtifactGeometry): Promise<void> {
  await clickGalleryControl(target, "facet-zoom-in");
  await Bun.sleep(150);
  const zoomed = await readArtifactGeometry(target);
  expect(zoomed.rootWidth).toBeGreaterThan(before.rootWidth);
  expect(zoomed.rootHeight).toBeGreaterThan(before.rootHeight);
  // The iframe's own box is shell-owned CSS (width/height: 100%,
  // never transformed) \u2014 zoom must not move it.
  expect(zoomed.iframeWidth).toBeCloseTo(before.iframeWidth, 0);
  expect(zoomed.iframeHeight).toBeCloseTo(before.iframeHeight, 0);

  await clickGalleryControl(target, "facet-zoom-reset");
  await Bun.sleep(150);
  const reset = await readArtifactGeometry(target);
  expect(reset.rootWidth).toBeCloseTo(before.rootWidth, 0);
  expect(reset.rootHeight).toBeCloseTo(before.rootHeight, 0);
  expect(reset.frameScrollLeft).toBe(0);
  expect(reset.frameScrollTop).toBe(0);
}

test("gallery artifact geometry holds at 1280x720 and 1920x1080", async () => {
  const envDir = mkdtempSync(join(tmpdir(), "facet-gallery-viewport-geometry-"));
  const tier0Runner = createTier0RunnerForTests(0, {});
  const service = await startFacetService({
    dbPath: join(envDir, "facet.sqlite"),
    installTokenPath: join(envDir, "install.token"),
    promoteTokenPath: join(envDir, "promote.token"),
    lockPath: join(envDir, "facet.lock"),
    idleTimeoutMs: 30_000,
    logger: createQuietLogger({ component: "gallery-viewport-geometry" }),
    tier0Runner,
  });
  const browser = galleryBrowser();
  let target: GalleryTarget | undefined;
  try {
    const client = new FacetClient({ baseUrl: service.url, installToken: service.installToken });
    target = await browser.launch();

    for (const viewport of VIEWPORTS) {
      await setGalleryViewport(target, viewport.width, viewport.height);
      for (const geometryCase of CASES) {
        await navigateToArtifact(
          target,
          client,
          geometryCase.artifactType,
          readFileSync(join(geometryCase.fixtureDir ?? FIXTURES_DIR, geometryCase.fixture), "utf8"),
          geometryCase.execution,
          {
            slug: `viewport-geometry-${geometryCase.key}-${viewport.width}`,
            ...(geometryCase.renderer === undefined ? {} : { renderer: geometryCase.renderer }),
          },
        );

        const before = await readArtifactGeometry(target);
        assertBaselineOverflow(before);
        geometryCase.assert(before, viewport.width);
        await assertZoomRoundTrip(target, before);

        await captureGalleryScreenshot(
          target,
          join(SCREENSHOT_DIR, `${geometryCase.key}-${viewport.width}x${viewport.height}.png`),
        );
      }
    }

    // Edge-clipping discriminator: a genuinely tiny stage where the
    // diagram overflows BOTH axes. This is the case a plain,
    // `unsafe` `center` gets wrong — it centers the flex line at a
    // NEGATIVE start offset, so the content's left/top edge sits
    // before the container's own origin with no way to scroll
    // backward far enough to reach it (scrollLeft/scrollTop cannot go
    // negative). `safe center` falls back to start alignment instead,
    // so the root's edges stay at or after the container's origin at
    // the default (unscrolled) position — reachable by scrolling
    // forward, never permanently clipped. A prior review caught this
    // exact gap: the CASES above never drove content to overflow both
    // axes against a stage SMALLER than the content, so a mutation to
    // plain `center` stayed green under them.
    await setGalleryViewport(target, 300, 150);
    await navigateToArtifact(
      target,
      client,
      "mermaid",
      readFileSync(join(import.meta.dir, "../../templates/service-topology.mmd"), "utf8"),
      undefined,
      { slug: "viewport-geometry-edge-clip-probe" },
    );
    const clipped = await readArtifactGeometry(target);
    expect(clipped.scrollWidth).toBeGreaterThan(clipped.clientWidth);
    expect(clipped.scrollHeight).toBeGreaterThan(clipped.clientHeight);
    expect(clipped.frameScrollLeft).toBe(0);
    expect(clipped.frameScrollTop).toBe(0);
    expect(clipped.rootLeft).toBeGreaterThanOrEqual(0);
    expect(clipped.rootTop).toBeGreaterThanOrEqual(0);

    // Bug-hunt sol#1 fix proof: at the supported extreme small
    // viewport (400x300), the shell chrome — the pan/zoom, zoom, and
    // fullscreen toolbar — stays part of the visible shell, not pushed
    // below the fold by whatever pushes the document taller than the
    // viewport. The recorded failure: every control landed at
    // y=381.046875 in a 300px-tall viewport, entirely off-screen.
    await setGalleryViewport(target, 400, 300);
    await navigateToArtifact(
      target,
      client,
      "mermaid",
      readFileSync(join(import.meta.dir, "../../templates/service-topology.mmd"), "utf8"),
      undefined,
      { slug: "viewport-geometry-toolbar-400x300" },
    );
    const toolbar = await readShellToolbarRect(target);
    expect(toolbar.top).toBeGreaterThanOrEqual(0);
    expect(toolbar.bottom).toBeLessThanOrEqual(toolbar.innerHeight);
    expect(toolbar.left).toBeGreaterThanOrEqual(0);
    expect(toolbar.right).toBeLessThanOrEqual(toolbar.innerWidth);
  } finally {
    await target?.close();
    await service.stop();
    tier0Runner.close?.();
    rmSync(envDir, { recursive: true, force: true });
  }
}, 180_000);
