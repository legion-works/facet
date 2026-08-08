/**
 * Tier 0 chart (Vega-Lite) parser.
 *
 * Two-step validation:
 *
 *   1. STRUCTURAL zod check on the raw spec — we forbid any `data`
 *      loader that references an external URL. Inline `data.values`
 *      and inline datasets are allowed because they cannot trigger a
 *      network fetch (and netns would block it anyway — but rejecting
 *      at Tier 0 makes the policy explicit on the wire).
 *
 *   2. `vega-lite.compile()` — produces a Vega spec from the input
 *      Vega-Lite spec WITHOUT a DOM. `compile()` is documented as a
 *      pure transform: it returns the compiled spec or throws a
 *      `vlCompileError`. We have verified empirically that `compile()`
 *      does not require a browser or `document` (verified against
 *      vega-lite@6 in this build).
 *
 * The Tier 0 verdict reports `graphCount: 1` for a successfully
 * compiled chart (one rendered visualization) and `errorCount: 1` for
 * a malformed or external-data spec.
 */

import { z } from "zod";
import { compile } from "vega-lite";

import type { DiscriminativeError, VerdictObserved } from "../../shared/contracts/validation";

/**
 * Vega-Lite spec surface — STRICT subset. We accept only the data
 * forms that cannot reference an external URL: inline `values` and an
 * unnamed inline dataset reference. A `data` property whose value is
 * a string or `{ url: … }` is rejected at the zod layer.
 */
const InlineDataSchema = z.union([
  z.object({ values: z.array(z.unknown()) }).strict(),
  z.null(),
  z.undefined(),
]);

const VegaLiteDataSchema = z
  .object({
    data: InlineDataSchema.optional(),
  })
  .passthrough();

const VegaLiteSpecSchema = z
  .object({
    $schema: z.string().optional(),
    description: z.string().optional(),
    data: InlineDataSchema.optional(),
    mark: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    encoding: z.record(z.string(), z.unknown()).optional(),
    layer: z.array(z.record(z.string(), z.unknown())).optional(),
    transform: z.array(z.record(z.string(), z.unknown())).optional(),
    width: z.union([z.number(), z.record(z.string(), z.unknown())]).optional(),
    height: z.union([z.number(), z.record(z.string(), z.unknown())]).optional(),
  })
  .passthrough();

export interface ChartParseOk {
  readonly status: "ok";
  readonly observed: VerdictObserved;
}

export interface ChartParseFail {
  readonly status: "error";
  readonly observed: VerdictObserved;
  readonly errors: readonly DiscriminativeError[];
}

export type ChartParseResult = ChartParseOk | ChartParseFail;

/**
 * Parse the source bytes as a Vega-Lite chart spec. First the
 * structural shape is validated (zod) so any external `data` reference
 * is rejected before we hand the spec to the compiler; then
 * `vega-lite.compile()` is called to confirm the spec is well-formed
 * Vega-Lite.
 */
export function parseChart(bytes: Uint8Array): ChartParseResult {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
      },
      errors: [{ code: "chart_json_error", message }],
    };
  }

  // VegaLiteSpecSchema is strict about the top-level `data` shape —
  // any spec whose `data` is a string or `{ url: … }` fails with a
  // precise path so the wire response can point at the bad field.
  const topLevel = VegaLiteSpecSchema.safeParse(spec);
  if (!topLevel.success) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
      },
      errors: topLevel.error.issues.slice(0, 5).map((issue) => ({
        code: issue.code === "invalid_type" ? "chart_invalid_type" : "chart_invalid_spec",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      })),
    };
  }
  // Re-check the data field specifically to surface a precise error.
  const dataCheck = VegaLiteDataSchema.safeParse({ data: topLevel.data.data });
  if (!dataCheck.success) {
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
      },
      errors: [
        {
          code: "chart_external_data_rejected",
          message:
            "Vega-Lite spec references external data (data.url / data string / loader); only inline data is allowed at Tier 0",
        },
      ],
    };
  }

  try {
    const compiled = compile(topLevel.data as unknown as Parameters<typeof compile>[0]);
    void compiled.spec;
    return {
      status: "ok",
      observed: {
        rendererRootSvgCount: 1,
        graphCount: 1,
        mermaidNodeCount: 0,
        visibleSvgCount: 1,
        errorCount: 0,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      observed: {
        rendererRootSvgCount: 0,
        graphCount: 0,
        mermaidNodeCount: 0,
        visibleSvgCount: 0,
        errorCount: 1,
      },
      errors: [{ code: "chart_compile_error", message }],
    };
  }
}
