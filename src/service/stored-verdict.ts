import type { Revision, RenderRun } from "../shared/contracts/artifact";
import { VerdictSchema, type Verdict } from "../shared/contracts/validation";
import type { ArtifactRepository } from "./store/repository";

export function verdictFromStoredRun(revision: Revision, run: RenderRun): Verdict {
  return VerdictSchema.parse({
    status: run.status,
    tier: run.tier,
    artifactId: revision.artifactId,
    revisionSha: revision.sha256,
    observed: JSON.parse(run.observedJson),
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
    .toSorted((left, right) => right.finishedAt.localeCompare(left.finishedAt));
  const run = runs[0];
  return run === undefined ? null : verdictFromStoredRun(revision, run);
}
