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

export interface PublishedArtifact {
  readonly artifactId: string;
  readonly revisionSha: string;
}

export interface EgressPenetrationSummary {
  readonly sinkHits: readonly string[];
  readonly udpPackets: number;
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

export async function readBackFixture(opts: ReadBackFixtureOptions): Promise<unknown> {
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
  return { sinkHits: result.sinkHits, udpPackets: result.udpPackets };
}
