/**
 * Canonical TSX execution modes (D2 of the TSX design).
 *
 * `--execution` is a DECLARED mode, not an inferred one. The artifact
 * author states which mode the TSX is meant to render under; the
 * trust core then applies the matching verification path:
 *
 *   - `static`       — compiles to HTML via the existing static HTML
 *                      pipeline; full predict-and-compare claim.
 *   - `interactive`  — executes the compiled bundle in a nested
 *                      opaque-origin frame; observation-only claim.
 *
 * Inference from hook or handler usage was rejected during design:
 * it is fragile and makes the trust claim a function of a heuristic
 * rather than an operator declaration. A static artifact that
 * accidentally trips an inference rule would silently earn the weaker
 * verdict.
 *
 * The exported constant is the single source of truth for TypeScript
 * consumers; the storage CHECK derives its SQL literal from it at schema-build
 * time so a new mode lands in the database contract too.
 */

export const TSX_EXECUTION_MODES = ["static", "interactive"] as const;
export type TsxExecutionMode = (typeof TSX_EXECUTION_MODES)[number];

export function isTsxExecutionMode(value: unknown): value is TsxExecutionMode {
  return typeof value === "string" && TSX_EXECUTION_MODES.includes(value as TsxExecutionMode);
}
