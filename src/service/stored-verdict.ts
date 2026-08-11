import type { Revision, RenderRun } from "../shared/contracts/artifact";
import { VerdictSchema, type Verdict, type VerdictObserved } from "../shared/contracts/validation";
import type { ArtifactRepository } from "./store/repository";

/**
 * Tolerate counters the pre-arc stored-observation schema did not
 * include. Every prior release pre-dates both `externalImageCount`
 * (added by this arc) and `opaqueRegionCount` (added by the prior
 * opaque-content arc); a strict `VerdictObservedSchema.parse` would
 * 400 the read-back / export / gallery-source routes on every
 * pre-arc artifact. Default missing counters to 0 — the verdict's
 * downstream behavior for a zero counter is what the verifier
 * would have computed in the absence of the field (no partial,
 * no opaque, no external_resources), and that is the conservative
 * answer for a verifier that never observed the field at all.
 *
 * The companion migration (`src/service/store/migrations.ts`)
 * backfills the missing counters to 0 in the on-disk JSON so the
 * tolerant read is a defensive belt-and-braces against a row that
 * was written before the migration ran. Treating the instance
 * (`.optional()` on the schema) would fix this specific break but
 * leave the same defect class to recur on the next counter
 * addition; treating the boundary is what makes it durable.
 */
export function withTolerantObserved(parsed: unknown): VerdictObserved {
  const observed = (parsed ?? {}) as Record<string, unknown>;
  // Per-counter fallback: each field defaults to 0 when the stored
  // JSON omits it (the pre-arc shape) and preserves the on-disk value
  // when present. This is the durable treatment — every counter ever
  // added can be extended the same way without re-breaking old rows.
  const num = (key: string, fallback: number): number => {
    const value = observed[key];
    return typeof value === "number" ? value : fallback;
  };
  return {
    rendererRootSvgCount: num("rendererRootSvgCount", 0),
    graphCount: num("graphCount", 0),
    mermaidNodeCount: num("mermaidNodeCount", 0),
    visibleSvgCount: num("visibleSvgCount", 0),
    opaqueRegionCount: num("opaqueRegionCount", 0),
    externalImageCount: num("externalImageCount", 0),
    // errorCount is required on the schema; pre-arc rows that never
    // recorded it default to 0.
    errorCount: num("errorCount", 0),
    // Preserve optional fields the on-disk JSON may carry.
    ...(observed.html !== undefined ? { html: observed.html as VerdictObserved["html"] } : {}),
    ...(Array.isArray(observed.viewBoxes) ? { viewBoxes: observed.viewBoxes as string[] } : {}),
    ...(Array.isArray(observed.discriminativeErrors)
      ? {
          discriminativeErrors:
            observed.discriminativeErrors as VerdictObserved["discriminativeErrors"],
        }
      : {}),
  };
}

export function verdictFromStoredRun(revision: Revision, run: RenderRun): Verdict {
  return VerdictSchema.parse({
    status: run.status,
    tier: run.tier,
    artifactId: revision.artifactId,
    revisionSha: revision.sha256,
    observed: withTolerantObserved(JSON.parse(run.observedJson)),
    ...(run.screenshotErrorJson !== null
      ? { screenshotError: JSON.parse(run.screenshotErrorJson) }
      : {}),
    ...(run.insecureJson !== null ? { insecure: JSON.parse(run.insecureJson) } : {}),
  });
}

export function latestStoredVerdict(
  repository: ArtifactRepository,
  revision: Revision,
): Verdict | null {
  const runs = ([0, 1] as const)
    .flatMap((tier) => repository.listRenderRuns({ revisionId: revision.id, tier }))
    .toSorted(
      (left, right) => right.finishedAt.localeCompare(left.finishedAt) || right.tier - left.tier,
    );
  const run = runs[0];
  return run === undefined ? null : verdictFromStoredRun(revision, run);
}
