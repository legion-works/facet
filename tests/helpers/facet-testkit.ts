// Acceptance test contract.
//
// The imports below reference the planned production entrypoints
// (`src/cli/client`) and the egress harness stub (`scripts/egress-penetration`).
// Until those surfaces land, every acceptance test fails RED on the named
// missing module during module resolution. The helper's own code stays
// type-clean so the redness is entirely attributable to the missing product
// imports, not to `any`-soup or unrelated helper-side errors.

import { publishArtifact, readBack } from "../../src/cli/client";

import {
  runEgressPenetration as runEgressPenetrationHarness,
  type EgressPenetrationOptions,
  type EgressPenetrationResult,
} from "../../scripts/egress-penetration";

export type ArtifactType = "markdown" | "mermaid" | "svg" | "chart";
export type Tier = 0 | 1;
export type Launcher = "production";

// Acceptance-level verdict contract. This is the surface the acceptance gates
// assert against; the full product schema supersedes it once the shared
// contracts land.
export interface AcceptanceVerdictObserved {
  readonly rendererRootSvgCount: number;
  readonly graphCount: number;
  readonly errorCount: number;
}

export interface AcceptanceVerdict {
  readonly status: string;
  readonly tier: Tier;
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly observed: AcceptanceVerdictObserved;
}

// Externally-observed channels the production penetration harness must
// attempt during a run. An empty or subset harness now fails the gate because
// the assertion uses Set equality against this shape.
export interface EgressPenetrationSummary {
  readonly attemptedChannels: readonly string[];
  readonly sinkHits: readonly string[];
  readonly udpPackets: number;
}

export interface PublishedArtifact {
  readonly artifactId: string;
  readonly revisionSha: string;
}

export interface PublishFixtureOptions {
  readonly fixturePath: string;
  readonly artifactType: ArtifactType;
  readonly slug?: string;
}

export interface ReadBackFixtureOptions {
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly tier: Tier;
}

export interface RunEgressPenetrationOptions {
  readonly launcher: Launcher;
}

export async function publishFixture(opts: PublishFixtureOptions): Promise<PublishedArtifact> {
  const bytes = await Bun.file(opts.fixturePath).arrayBuffer();
  const result = await publishArtifact({
    artifactType: opts.artifactType,
    bytes,
    ...(opts.slug !== undefined ? { slug: opts.slug } : {}),
  });
  return { artifactId: result.artifactId, revisionSha: result.revisionSha };
}

export async function readBackFixture(opts: ReadBackFixtureOptions): Promise<AcceptanceVerdict> {
  const result = await readBack({
    artifactId: opts.artifactId,
    revisionSha: opts.revisionSha,
    tier: opts.tier,
  });
  return result;
}

export async function runEgressPenetration(
  opts: RunEgressPenetrationOptions,
): Promise<EgressPenetrationSummary> {
  if (opts.launcher !== "production") {
    throw new Error(`unsupported launcher: ${opts.launcher as string}`);
  }
  const harnessOptions: EgressPenetrationOptions = { launcher: "production" };
  const result: EgressPenetrationResult = await runEgressPenetrationHarness(harnessOptions);
  return {
    attemptedChannels: result.attemptedChannels,
    sinkHits: result.sinkHits,
    udpPackets: result.udpPackets,
  };
}
