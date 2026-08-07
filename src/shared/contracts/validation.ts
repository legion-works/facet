import { z } from "zod";

/**
 * Validation tier. Tier 0 is the always-on parser worker (no browser);
 * Tier 1 is the explicit, ephemeral, headless-shell-backed verifier.
 * Tier 2 (the user's browser) is display-only and never produces a
 * `RenderRun`.
 */
export const ValidationTierSchema = z.union([z.literal(0), z.literal(1)]);
export type ValidationTier = z.infer<typeof ValidationTierSchema>;

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
  "tampered",
  "timeout",
  "shim_only",
  "probe_only",
]);
export type RenderStatus = z.infer<typeof RenderStatusSchema>;

/** Required of every Verdict to match the acceptance-gate contract. */
export const VerdictObservedSchema = z.object({
  rendererRootSvgCount: z.number().int().nonnegative(),
  graphCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
});
export type VerdictObserved = z.infer<typeof VerdictObservedSchema>;

/** Discriminative errors the verifier chooses to surface beyond the count. */
export const DiscriminativeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  location: z.string().optional(),
});
export type DiscriminativeError = z.infer<typeof DiscriminativeErrorSchema>;

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
});
export type LexicalCounters = z.infer<typeof LexicalCountersSchema>;

/** Verifier-side observations of the rendered page. */
export const ObservedCountersSchema = LexicalCountersSchema.extend({
  viewBoxes: z.array(z.string()).optional(),
  errorCount: z.number().int().nonnegative(),
  discriminativeErrors: z.array(DiscriminativeErrorSchema).optional(),
});
export type ObservedCounters = z.infer<typeof ObservedCountersSchema>;

export const VerdictSchema = z.object({
  status: RenderStatusSchema,
  tier: ValidationTierSchema,
  artifactId: z.string().min(1),
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
  observed: VerdictObservedSchema,
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** Tier 0 input: pure-parse verifier, no browser, no egress. */
export const Tier0InputSchema = z.object({
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
  artifactType: z.enum(["markdown", "mermaid", "svg", "chart"]),
  source: z.instanceof(Uint8Array),
  lexical: LexicalCountersSchema,
});
export type Tier0Input = z.infer<typeof Tier0InputSchema>;

/** Tier 0 result: lexical vs. observed, with optional discriminative errors. */
export const Tier0ResultSchema = z.object({
  revisionSha: z.string().regex(/^[a-f0-9]{64}$/),
  tier: z.literal(0),
  status: RenderStatusSchema,
  expected: LexicalCountersSchema,
  observed: ObservedCountersSchema,
  discriminativeErrors: z.array(DiscriminativeErrorSchema).optional(),
});
export type Tier0Result = z.infer<typeof Tier0ResultSchema>;

/** Tier 1 input: headless-shell-backed verifier on top of Tier 0. */
export const Tier1InputSchema = Tier0InputSchema.extend({
  /** Pinned chrome-headless-shell version that must run this verification. */
  launcherVersion: z.string().min(1),
  /** Network namespace name the verifier must be confined to. */
  networkNamespace: z.string().min(1),
});
export type Tier1Input = z.infer<typeof Tier1InputSchema>;

/** Tier 1 result: full-page render with layout checks. */
export const Tier1ResultSchema = Tier0ResultSchema.extend({
  tier: z.literal(1),
  screenshotPath: z.string().nullable(),
  consolePath: z.string().nullable(),
});
export type Tier1Result = z.infer<typeof Tier1ResultSchema>;
