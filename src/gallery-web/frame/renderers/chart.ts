/**
 * Chart renderer — validated Vega-Lite spec → SVG via the vendored
 * Vega runtime in SVG mode.
 *
 * The data loader is DISABLED: inline/named data only. Every loader
 * entry point (`load`, `http`, `file`) rejects, so a spec carrying
 * `data.url` fails closed with a facet-error instead of fetching —
 * the frame CSP (`connect-src 'none'`) is the backstop.
 *
 * A spec that renders ZERO marks is an error, not an ok render: an
 * empty SVG root would tell the verifier "one renderer root" while
 * showing the operator nothing.
 */

import { compile } from "vega-lite";
import { View, loader, parse, type Loader } from "vega";
import { expressionInterpreter } from "vega-interpreter";

import type { Renderer } from "../../../shared/contracts/renderers";
import { FacetRenderError, type RenderContext, decodeArtifactBytes } from "./registry";
import { importSanitizedSvgText } from "./svg";

/** Every fetch path on the blocked loader rejects with the same typed error. */
const denyBlockedFetch = (): Promise<never> =>
  Promise.reject(
    new FacetRenderError("external chart data is not permitted", "chart_external_data"),
  );

/** A loader whose every fetch path rejects — inline data only. */
export function createBlockedLoader(): Loader {
  const blocked = loader();
  blocked.load = denyBlockedFetch;
  blocked.http = denyBlockedFetch;
  blocked.file = denyBlockedFetch;
  return blocked;
}

/**
 * Count vega data-mark groups in rendered SVG text. Vega wraps each
 * DATA mark set in a group carrying `role-mark` (axes/legends are
 * `role-axis`/`role-legend` and do NOT count). Vega emits the group
 * even when it holds zero items, so the zero-marks gate counts the
 * tuples in the view's data sets instead (`countDataTuples`).
 */
export function countVegaMarks(svgText: string): number {
  return (svgText.match(/class="[^"]*\bmark-[a-z]+[^"]*role-mark/g) ?? []).length;
}

/**
 * Total tuples across the compiled spec's named data sets — the mark
 * items the renderer will actually draw. A spec whose pipeline yields
 * zero tuples renders axes-only: an empty chart the gate must reject.
 * Reads through the public `view.data(name)` surface; unknown sets
 * count as zero.
 */
export function countDataTuples(view: View, compiledSpec: unknown): number {
  const data =
    typeof compiledSpec === "object" && compiledSpec !== null
      ? (compiledSpec as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(data)) return 0;
  let total = 0;
  for (const entry of data) {
    const name =
      typeof entry === "object" && entry !== null ? (entry as { name?: unknown }).name : undefined;
    if (typeof name !== "string") continue;
    try {
      total += view.data(name).length;
    } catch {
      // unknown data set — counts as zero tuples
    }
  }
  return total;
}

/**
 * Vega's loader swallows fetch failures and silently substitutes its
 * built-in sample data — a spec with `data.url` would render a WRONG
 * chart that looks like success. Reject url-bearing compiled specs
 * up front: inline/named/generated data only.
 */
export function compiledSpecHasExternalUrl(spec: unknown): boolean {
  if (typeof spec !== "object" || spec === null) return false;
  const data = (spec as { data?: unknown }).data;
  if (!Array.isArray(data)) return false;
  return data.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { url?: unknown }).url === "string",
  );
}

/** Render a chart artifact (artifactType "chart"): Vega-Lite JSON bytes. */
export async function renderChart(
  ctx: RenderContext,
  bytes: Uint8Array,
  renderer: Renderer = "svg",
): Promise<void> {
  const text = decodeArtifactBytes(bytes);
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FacetRenderError(`chart spec is not valid JSON: ${message}`, "chart_invalid_json");
  }
  let compiled: { spec: unknown };
  try {
    compiled = compile(spec as never);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FacetRenderError(`vega-lite compile failed: ${message}`, "chart_compile_error");
  }
  if (compiledSpecHasExternalUrl(compiled.spec)) {
    throw new FacetRenderError("external chart data is not permitted", "chart_external_data");
  }
  // `ast: true` + the expression INTERPRETER is Vega's CSP-safe path.
  // The default compiles expressions with `Function`/eval, which the
  // frame's nonce-only CSP blocks outright — every chart rendered as an
  // "unsafe-eval" error instead of a plot.
  const runtime = parse(compiled.spec as never, {}, { ast: true });
  const view = new View(runtime, {
    loader: createBlockedLoader(),
    renderer: "none",
    expr: expressionInterpreter,
  });
  try {
    if (renderer === "canvas") view.renderer("canvas").initialize(ctx.container);
    await view.runAsync();
    if (countDataTuples(view, compiled.spec) === 0) {
      throw new FacetRenderError("chart spec renders zero marks", "chart_zero_marks");
    }
    if (renderer === "svg") {
      const svgText = await view.toSVG();
      await importSanitizedSvgText(ctx.container, svgText);
    }
  } catch (error) {
    if (error instanceof FacetRenderError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new FacetRenderError(`vega render failed: ${message}`, "chart_render_error");
  } finally {
    view.finalize();
  }
}
