// Acceptance test contract.
//
// Acceptance tests pin the wire-level behavior the product ships:
// forge-resistant Tier 1 verdicts, network-namespace egress proof,
// and the publish/read-back envelope round-trip. The helper below
// starts a real Facet service in-process per `beforeAll`, injects a
// Tier 1 verifier (the test fixture is the unfakeable-proof path),
// and exposes a tiny test-shaped surface the acceptance tests use.
//
// The Tier 1 runner injected here IS the production `runTier1`
// implementation (`src/validation/tier1/runner.ts`); the helper
// resolves its dependencies (puppeteer-core, pinned shell path)
// from the same lookup the CLI uses, so acceptance tests cannot
// drift from production launcher wiring.

import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FacetClient, publishArtifact, readBack } from "../../src/cli/client";
import {
  runEgressPenetration as runEgressPenetrationHarness,
  type EgressPenetrationOptions,
  type EgressPenetrationResult,
} from "../../scripts/egress-penetration";
import { startFacetService, type RunningService } from "../../src/service/server";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "./stub-tier0-runner";

const TIER1_TRACE = process.env.FACET_TIER1_TRACE === "1";

function traceTier1Transport(stage: string): void {
  if (!TIER1_TRACE) return;
  process.stderr.write(`[tier1-transport] ${stage}\n`);
}

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

// Re-export the canonical egress types from `scripts/egress-penetration.ts`
// so a future drift in the harness signature surfaces at the import site
// rather than inside the acceptance tests.
export type { EgressPenetrationOptions, EgressPenetrationResult };

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

let env: AcceptanceEnv | null = null;
let cleanupRegistered = false;
const ACCEPTANCE_IDLE_TIMEOUT_MS = 120_000;

interface AcceptanceEnv {
  readonly client: FacetClient;
  readonly service: RunningService;
  readonly envDir: string;
}

async function startAcceptanceService(envDir: string): Promise<AcceptanceEnv> {
  const dbPath = join(envDir, "facet.sqlite");
  const installTokenPath = join(envDir, "install.token");
  const promoteTokenPath = join(envDir, "promote.token");
  const lockPath = join(envDir, "facet.lock");
  // Lazy import keeps the Tier 1 verifier out of the unit-test bundle.
  const { runTier1 } = await import("../../src/validation/tier1/runner");
  const service = await startFacetService({
    dbPath,
    installTokenPath,
    promoteTokenPath,
    lockPath,
    idleTimeoutMs: ACCEPTANCE_IDLE_TIMEOUT_MS,
    logger: createQuietLogger({ component: "acceptance" }),
    tier0Runner: stubTier0Runner,
    tier1Runner: runTier1,
  });
  const client = new FacetClient({
    baseUrl: service.url,
    installToken: service.installToken,
  });
  return { client, service, envDir };
}

async function isServiceReachable(candidate: AcceptanceEnv): Promise<boolean> {
  if (!Number.isInteger(candidate.service.pid) || candidate.service.pid <= 0) return false;
  try {
    process.kill(candidate.service.pid, 0);
    const origin = new URL(candidate.service.url);
    await fetch(candidate.service.url, {
      headers: { host: origin.host },
      signal: AbortSignal.timeout(1_000),
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureEnv(): Promise<AcceptanceEnv> {
  if (env !== null && (await isServiceReachable(env))) return env;

  const previous = env;
  if (previous !== null) {
    env = null;
    await previous.service.stop().catch(() => {});
  }

  const envDir = previous?.envDir ?? mkdtempSync(join(tmpdir(), "facet-acceptance-"));
  env = await startAcceptanceService(envDir);
  if (!cleanupRegistered) {
    afterAll(async () => {
      if (env !== null) {
        await env.service.stop().catch(() => {});
        try {
          rmSync(env.envDir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
        env = null;
      }
    });
    cleanupRegistered = true;
  }
  return env;
}

export async function stopAcceptanceServiceForTests(): Promise<void> {
  await env?.service.stop();
}

beforeAll(async () => {
  await ensureEnv();
});

export async function publishFixture(opts: PublishFixtureOptions): Promise<PublishedArtifact> {
  traceTier1Transport("test:publish:start");
  const bytes = await Bun.file(opts.fixturePath).arrayBuffer();
  const { client } = await ensureEnv();
  const result = await publishArtifact(client, {
    artifactType: opts.artifactType,
    bytes,
    ...(opts.slug !== undefined ? { slug: opts.slug } : {}),
  });
  traceTier1Transport("test:publish:complete");
  return { artifactId: result.artifactId, revisionSha: result.revisionSha };
}

export async function readBackFixture(opts: ReadBackFixtureOptions): Promise<AcceptanceVerdict> {
  traceTier1Transport("test:readback:start");
  const { client } = await ensureEnv();
  const result = await readBack(client, {
    artifactId: opts.artifactId,
    revisionSha: opts.revisionSha,
    tier: opts.tier,
  });
  traceTier1Transport(`test:readback:complete status=${result.status}`);
  return {
    status: result.status,
    tier: result.tier === "visual" ? 1 : result.tier,
    artifactId: result.artifactId,
    revisionSha: result.revisionSha,
    observed: {
      rendererRootSvgCount: result.observed.rendererRootSvgCount,
      graphCount: result.observed.graphCount,
      errorCount: result.observed.errorCount,
    },
  };
}

export interface EgressPenetrationSummary {
  readonly attemptedChannels: readonly string[];
  readonly sinkHits: readonly string[];
  readonly udpPackets: number;
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
