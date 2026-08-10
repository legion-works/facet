import { z } from "zod";

import { RendererSchema } from "./artifact";

/**
 * Validation tier. Tier 0 is the always-on parser worker (no browser);
 * Tier 1 is the explicit, ephemeral, headless-shell-backed verifier.
 * Tier 2 (the user's browser) is display-only and never produces a
 * `RenderRun`.
 */
export const ValidationTierSchema = z.union([z.literal(0), z.literal(1)]);

/**
 * Closed set of render status codes the verifier can produce. The
 * `partial:` prefix is reserved for results that completed some checks
 * but could not finalize the layout pass (e.g., due to viewport
 * unavailability); `tampered` is reserved for hostile pages that
 * attempted to forge the verdict.
 */
export const RenderStatusSchema = z.enum([
  "ok",
  "error",
  "partial:layout_unverified",
  "partial:opaque_content",
  "tampered",
  "timeout",
  "shim_only",
  "probe_only",
  "insecure:unvalidated",
]);
export type RenderStatus = z.infer<typeof RenderStatusSchema>;

/** Discriminative errors the verifier chooses to surface beyond the count. */
export const DiscriminativeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  location: z.string().optional(),
});
export type DiscriminativeError = z.infer<typeof DiscriminativeErrorSchema>;

/**
 * Evidence capture failed after the render verdict was derived. This stays
 * outside `observed.discriminativeErrors`, which the verdict ladder consumes.
 */
export const ScreenshotErrorSchema = z.object({
  code: z.literal("screenshot_unavailable"),
  message: z.string().min(1),
});
export type ScreenshotError = z.infer<typeof ScreenshotErrorSchema>;

export const InsecureLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type InsecureLevel = z.infer<typeof InsecureLevelSchema>;

export const InsecureMarkerSchema = z.object({
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  reason: z.string().min(1),
});
export type InsecureMarker = z.infer<typeof InsecureMarkerSchema>;

/**
 * Lexical counters computed from the source bytes WITHOUT parsing or
 * rendering. The verifier compares these against its own observations
 * so an attacker cannot make a forged page's `svgCount` agree with
 * the verifier's observation without also matching the lexical
 * expectation.
 */
export const LexicalCountersSchema = z.object({
  rendererRootSvgCount: z.number().int().nonnegative(),
  mermaidNodeCount: z.number().int().nonnegative(),
  visibleSvgCount: z.number().int().nonnegative(),
  opaqueRegionCount: z.number().int().nonnegative(),
});
export type LexicalCounters = z.infer<typeof LexicalCountersSchema>;

/**
 * The ONE canonical verdict-observed shape. Every read-back result and
 * every Tier 0/1 result derives from this. The optional fields
 * (`viewBoxes`, `discriminativeErrors`) are filled by Tier 1 when the
 * layout pass succeeds.
 *
 * `graphCount` is included alongside `mermaidNodeCount` for parity with
 * the acceptance-gate verdict contract — the acceptance tests assert
 * `observed.graphCount` for nested-SVG forgery probes, so a verifier
 * that does not surface it would fail those gates regardless of the
 * status.
 */
export const VerdictObservedSchema = z.object({
  rendererRootSvgCount: z.number().int().nonnegative(),
  graphCount: z.number().int().nonnegative(),
  mermaidNodeCount: z.number().int().nonnegative(),
  visibleSvgCount: z.number().int().nonnegative(),
  opaqueRegionCount: z.number().int().nonnegative(),
  viewBoxes: z.array(z.string()).optional(),
  errorCount: z.number().int().nonnegative(),
  discriminativeErrors: z.array(DiscriminativeErrorSchema).optional(),
});
export type VerdictObserved = z.infer<typeof VerdictObservedSchema>;

/**
 * Canonical verdict: every read-back response, every Tier 0/1 result,
 * and the acceptance-gate verdict are all structurally compatible with
 * this shape. Tier results extend it (with `expected` for the
 * expected-vs-observed comparison); read-back uses it directly.
 */
export const VerdictSchema = z.object({
  status: RenderStatusSchema,
  tier: ValidationTierSchema,
  artifactId: z.string().min(1),
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
  observed: VerdictObservedSchema,
  screenshotError: ScreenshotErrorSchema.optional(),
  insecure: InsecureMarkerSchema.optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** Tier 0 input: pure-parse verifier, no browser, no egress. */
export const Tier0InputSchema = z.object({
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
  artifactType: z.enum(["markdown", "mermaid", "svg", "chart"]),
  renderer: RendererSchema,
  source: z.instanceof(Uint8Array<ArrayBuffer>),
  lexical: LexicalCountersSchema,
});
export type Tier0Input = z.infer<typeof Tier0InputSchema>;

/**
 * The parent-side Tier 0 runner contract. The default implementation
 * lives in `src/validation/tier0/runner.ts` (out-of-process Bun
 * subprocess under `unshare --map-current-user --net`). The service
 * imports THIS TYPE only — the runner implementation is constructed
 * by callers (`src/cli/`, tests) and injected into the dispatcher so
 * `src/service/**` stays byte-dumb and the boundary checker remains
 * clean.
 */
export type Tier0Runner = (input: Tier0Input) => Promise<Tier0WorkerResult>;
export type Tier0RunnerFactory = (level: InsecureLevel) => Tier0Runner;

export interface IsolationProbeResult {
  readonly available: boolean;
  readonly reason: string | null;
}

export type Tier0IsolationProbe = () => IsolationProbeResult | Promise<IsolationProbeResult>;

/** Tier 0 result: extends the canonical verdict with the expected counters. */
export const Tier0ResultSchema = VerdictSchema.extend({
  tier: z.literal(0),
  expected: LexicalCountersSchema,
});
export type Tier0Result = z.infer<typeof Tier0ResultSchema>;

/** Identity-blind worker stdout; the parent adds artifactId before persistence. */
export const Tier0WorkerResultSchema = Tier0ResultSchema.omit({ artifactId: true });
export type Tier0WorkerResult = z.infer<typeof Tier0WorkerResultSchema>;

/** Tier 1 input: headless-shell-backed verifier on top of Tier 0. */
export const Tier1InputSchema = Tier0InputSchema.extend({
  /** Pinned chrome-headless-shell version that must run this verification. */
  launcherVersion: z.string().min(1),
  /** Network namespace name the verifier must be confined to. */
  networkNamespace: z.string().min(1),
  /**
   * Per-run evidence directory (mode 0700). The runner writes the
   * screenshot, the bounded console summary, and the protocol
   * observation JSON under this directory. When omitted, the runner
   * falls back to `computeFacetPaths().evidence` so production
   * callers never have to specify it.
   */
  evidenceDir: z.string().optional(),
});
export type Tier1Input = z.infer<typeof Tier1InputSchema>;

/**
 * The parent-side Tier 1 runner contract. The default implementation
 * lives in `src/validation/tier1/runner.ts` (an ephemeral netns'd
 * `chrome-headless-shell` driven via CDP pipe). Like `Tier0Runner`,
 * only THIS TYPE is imported by the service — the implementation is
 * constructed by callers (`src/cli/`, tests) and injected so
 * `src/service/**` stays byte-dumb.
 */
export type Tier1Runner = (input: Tier1Input) => Promise<Tier1Result>;
export type Tier1RunnerFactory = (level: InsecureLevel) => Tier1Runner;
export type Tier1AvailabilityProbe = () => IsolationProbeResult | Promise<IsolationProbeResult>;

/**
 * Tier 1 result: extends Tier 0 with screenshot/console paths.
 *
 * Partial verdicts require screenshot evidence or a typed explanation for
 * why capture failed after the render verdict was already derived.
 */
export const Tier1ResultSchema = Tier0ResultSchema.extend({
  tier: z.literal(1),
  screenshotPath: z.string().nullable(),
  consolePath: z.string().nullable(),
  screenshotError: ScreenshotErrorSchema.optional(),
}).refine(
  (value) =>
    !value.status.startsWith("partial:") ||
    value.screenshotPath !== null ||
    value.screenshotError !== undefined,
  {
    message: "partial verdict requires screenshot evidence or a screenshot-unavailable marker",
    path: ["screenshotPath"],
  },
);
export type Tier1Result = z.infer<typeof Tier1ResultSchema>;

/**
 * The renderer-OWNED root count the verifier expects from one Tier 1
 * run. Counts ONE top-level renderer-owned root per expected
 * (revision, fence) pair — NOT every descendant `<svg>`. A nested
 * `<svg id="forged">` inside a Mermaid label does NOT inflate this
 * count; that probe is the gate-forgery acceptance contract.
 */
export const ProtocolObservationSchema = z.object({
  rendererRootSvgCount: z.number().int().nonnegative(),
  graphCount: z.number().int().nonnegative(),
  mermaidNodeCount: z.number().int().nonnegative(),
  visibleSvgCount: z.number().int().nonnegative(),
  opaqueRegionCount: z.number().int().nonnegative(),
  viewBoxes: z.array(z.string()),
  errorCount: z.number().int().nonnegative(),
  discriminativeErrors: z.array(DiscriminativeErrorSchema),
});
export type ProtocolObservation = z.infer<typeof ProtocolObservationSchema>;
