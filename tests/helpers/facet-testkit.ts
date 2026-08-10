// Acceptance test contract.
//
// Acceptance tests pin the wire-level behavior the product ships:
// forge-resistant Tier 1 verdicts, network-namespace egress proof,
// and the publish/read-back envelope round-trip. The helper below
// starts a real Facet service in-process per `beforeAll`, injects a
// Tier 1 verifier (the test fixture is the unfakeable-proof path),
// and exposes a tiny test-shaped surface the acceptance tests use.
//
// Production-mode runs inject `runTier1` directly. Screenshot modes replace
// only the post-verdict capture call so verdict gates do not depend on CDP timing.

import { afterAll, beforeAll } from "bun:test";
import { Buffer } from "node:buffer";
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
import type { ArtifactType } from "../../src/shared/contracts/artifact-types";
import type { Renderer } from "../../src/shared/contracts/renderers";
import type {
  HtmlStructureCounts,
  InsecureLevel,
  InsecureMarker,
  ScreenshotError,
} from "../../src/shared/contracts/validation";

const TIER1_TRACE = process.env.FACET_TIER1_TRACE === "1";

function traceTier1Transport(stage: string): void {
  if (!TIER1_TRACE) return;
  process.stderr.write(`[tier1-transport] ${stage}\n`);
}

export type Tier = 0 | 1;
export type Launcher = "production";
export type ScreenshotMode = "live" | "deterministic" | "fail";

// Acceptance-level verdict contract. This is the surface the acceptance gates
// assert against; the full product schema supersedes it once the shared
// contracts land.
export interface AcceptanceVerdictObserved {
  readonly rendererRootSvgCount: number;
  readonly graphCount: number;
  readonly errorCount: number;
  readonly opaqueRegionCount: number;
  readonly html?: HtmlStructureCounts;
  readonly discriminativeErrors?: readonly { readonly code: string; readonly message: string }[];
}

export interface AcceptanceVerdict {
  readonly status: string;
  readonly tier: Tier;
  readonly renderer: Renderer;
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly observed: AcceptanceVerdictObserved;
  readonly insecure?: InsecureMarker;
  readonly screenshotError?: ScreenshotError;
}

// Re-export the canonical egress types from `scripts/egress-penetration.ts`
// so a future drift in the harness signature surfaces at the import site
// rather than inside the acceptance tests.
export type { EgressPenetrationOptions, EgressPenetrationResult };

export interface PublishedArtifact {
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly tier1ScreenshotPath: string | null;
  readonly tier1Status: string | null;
  readonly tier1ScreenshotError: ScreenshotError | null;
}

export interface PublishFixtureOptions {
  readonly fixturePath: string;
  readonly artifactType: ArtifactType;
  readonly renderer?: Renderer;
  readonly slug?: string;
  readonly screenshotMode?: ScreenshotMode;
  readonly insecureLevel?: InsecureLevel;
  readonly productionTier0?: boolean;
}

export interface ReadBackFixtureOptions {
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly tier: Tier;
  readonly insecureLevel?: InsecureLevel;
  readonly productionTier0?: boolean;
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
  readonly screenshotMode: ScreenshotMode;
  readonly insecureLevel: InsecureLevel;
  readonly productionTier0: boolean;
}

async function startAcceptanceService(
  envDir: string,
  screenshotMode: ScreenshotMode,
  insecureLevel: InsecureLevel,
  productionTier0: boolean,
): Promise<AcceptanceEnv> {
  const dbPath = join(envDir, "facet.sqlite");
  const installTokenPath = join(envDir, "install.token");
  const promoteTokenPath = join(envDir, "promote.token");
  const lockPath = join(envDir, "facet.lock");
  // Lazy import keeps the Tier 1 verifier out of the unit-test bundle.
  const { createTier1Runner, createTier1RunnerForTests } =
    await import("../../src/validation/tier1/runner");
  const { createTier0Runner } = await import("../../src/validation/tier0/runner");
  const tier1Runner =
    screenshotMode === "live"
      ? createTier1Runner(insecureLevel)
      : createTier1RunnerForTests({
          captureScreenshot:
            screenshotMode === "deterministic"
              ? async () => Buffer.from("facet-test-screenshot")
              : async () => {
                  throw new Error("forced screenshot failure");
                },
        });
  const service = await startFacetService({
    dbPath,
    installTokenPath,
    promoteTokenPath,
    lockPath,
    idleTimeoutMs: ACCEPTANCE_IDLE_TIMEOUT_MS,
    logger: createQuietLogger({ component: "acceptance" }),
    tier0Runner: productionTier0 ? createTier0Runner(insecureLevel) : stubTier0Runner,
    tier1Runner,
    insecureLevel,
    insecureReason: insecureLevel > 0 ? `manual insecure level ${insecureLevel}` : null,
  });
  const client = new FacetClient({
    baseUrl: service.url,
    installToken: service.installToken,
  });
  return { client, service, envDir, screenshotMode, insecureLevel, productionTier0 };
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

async function ensureEnv(
  screenshotMode?: ScreenshotMode,
  insecureLevel: InsecureLevel = 0,
  productionTier0 = false,
): Promise<AcceptanceEnv> {
  if (
    env !== null &&
    (screenshotMode === undefined || env.screenshotMode === screenshotMode) &&
    env.insecureLevel === insecureLevel &&
    env.productionTier0 === productionTier0 &&
    (await isServiceReachable(env))
  ) {
    return env;
  }

  const previous = env;
  if (previous !== null) {
    env = null;
    await previous.service.stop().catch(() => {});
  }

  const envDir = previous?.envDir ?? mkdtempSync(join(tmpdir(), "facet-acceptance-"));
  env = await startAcceptanceService(
    envDir,
    screenshotMode ?? "live",
    insecureLevel,
    productionTier0,
  );
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
  const { client } = await ensureEnv(
    opts.screenshotMode ?? "live",
    opts.insecureLevel ?? 0,
    opts.productionTier0 ?? false,
  );
  const result = await publishArtifact(client, {
    artifactType: opts.artifactType,
    ...(opts.renderer !== undefined ? { renderer: opts.renderer } : {}),
    bytes,
    ...(opts.slug !== undefined ? { slug: opts.slug } : {}),
  });
  traceTier1Transport("test:publish:complete");
  return {
    artifactId: result.artifactId,
    revisionSha: result.revisionSha,
    tier1ScreenshotPath: result.tier1ScreenshotPath,
    tier1Status: result.tier1Status,
    tier1ScreenshotError: result.tier1ScreenshotError,
  };
}

export async function readBackFixture(opts: ReadBackFixtureOptions): Promise<AcceptanceVerdict> {
  traceTier1Transport("test:readback:start");
  const { client } = await ensureEnv(
    undefined,
    opts.insecureLevel ?? 0,
    opts.productionTier0 ?? false,
  );
  const result = await readBack(client, {
    artifactId: opts.artifactId,
    revisionSha: opts.revisionSha,
    tier: opts.tier,
  });
  traceTier1Transport(`test:readback:complete status=${result.status}`);
  return {
    status: result.status,
    tier: result.tier === "visual" ? 1 : result.tier,
    renderer: result.renderer,
    artifactId: result.artifactId,
    revisionSha: result.revisionSha,
    ...(result.insecure !== undefined ? { insecure: result.insecure } : {}),
    ...(result.screenshotError !== undefined ? { screenshotError: result.screenshotError } : {}),
    observed: {
      rendererRootSvgCount: result.observed.rendererRootSvgCount,
      graphCount: result.observed.graphCount,
      opaqueRegionCount: result.observed.opaqueRegionCount,
      errorCount: result.observed.errorCount,
      ...(result.observed.html === undefined ? {} : { html: result.observed.html }),
      ...(result.observed.discriminativeErrors !== undefined
        ? { discriminativeErrors: result.observed.discriminativeErrors }
        : {}),
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
