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

import { FacetClient, publishArtifact, readBack, type ReadBackResult } from "../../src/cli/client";
import {
  runEgressPenetration as runEgressPenetrationHarness,
  type EgressPenetrationOptions,
  type EgressPenetrationResult,
} from "../../scripts/egress-penetration";
import { startFacetService, type RunningService } from "../../src/service/server";
import { openDatabase } from "../../src/service/store/database";
import { ArtifactRepository } from "../../src/service/store/repository";
import { ACCEPTANCE_TEST_BUDGET_MS } from "../../src/shared/config/limits";
import { createQuietLogger } from "../../src/shared/logging/logger";
import { stubTier0Runner } from "./stub-tier0-runner";
import type { ArtifactType } from "../../src/shared/contracts/artifact-types";
import type { Renderer } from "../../src/shared/contracts/renderers";
import type {
  InsecureLevel,
  InsecureMarker,
  ScreenshotError,
  VerdictObserved,
} from "../../src/shared/contracts/validation";

const TIER1_TRACE = process.env.FACET_TIER1_TRACE === "1";

function traceTier1Transport(stage: string): void {
  if (!TIER1_TRACE) return;
  process.stderr.write(`[tier1-transport] ${stage}\n`);
}

export type Tier = 0 | 1;
export type Launcher = "production";
export type ScreenshotMode = "live" | "deterministic" | "fail";

// Acceptance-level verdict contract. The canonical observed shape
// (the same `VerdictObservedSchema` every read-back response derives
// from) is the surface the acceptance gates assert against. The
// previous hand-picked subset (`rendererRootSvgCount`, `graphCount`,
// `errorCount`, `opaqueRegionCount`, optional `html`, optional
// `discriminativeErrors`) silently dropped `externalImageCount`,
// `viewBoxes`, `mermaidNodeCount`, and `visibleSvgCount` for every
// release since the HTML arc — `externalImageCount` is the
// disclosure channel, so an acceptance test could not check it
// end-to-end. The interface now carries the canonical shape; the
// projection (`projectToAcceptanceVerdict`) passes the parsed
// verdict through unchanged. A new field on the schema is
// surfaced by default.
export type AcceptanceVerdictObserved = VerdictObserved;

export interface AcceptanceVerdict {
  readonly status: string;
  readonly tier: Tier;
  readonly renderer: Renderer;
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly observed: AcceptanceVerdictObserved;
  readonly insecure?: InsecureMarker;
  readonly screenshotError?: ScreenshotError;
  /**
   * TSX execution mode belongs on TSX verdicts only. Non-TSX verdicts omit it
   * rather than serializing null, preserving their established wire shape.
   */
  readonly execution?: import("../../src/shared/contracts/validation").TsxExecutionMode;
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
  readonly execution?: import("../../src/shared/tsx/execution").TsxExecutionMode;
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
    idleTimeoutMs: ACCEPTANCE_TEST_BUDGET_MS,
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
    ...(opts.execution !== undefined ? { execution: opts.execution } : {}),
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
  const result = await readBackFixtureRaw(opts);
  return projectToAcceptanceVerdict(result);
}

/**
 * Low-level read-back that returns the canonical `ReadBackResult`
 * (renderer + canonical parsed verdict). The acceptance harness
 * `readBackFixture` is a thin projection over this. The split
 * exists so the projection can be tested at unit resolution
 * without spinning up a service.
 */
export async function readBackFixtureRaw(opts: ReadBackFixtureOptions): Promise<ReadBackResult> {
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
  traceTier1Transport(`test:readback:complete status=${result.verdict.status}`);
  return result;
}

export async function readStoredRenderRunsForTests(input: {
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly productionTier0?: boolean;
}): Promise<readonly { readonly compiledPath?: string | null }[]> {
  const current = await ensureEnv(undefined, 0, input.productionTier0 ?? false);
  const db = openDatabase({ databasePath: join(current.envDir, "facet.sqlite") });
  try {
    const repository = new ArtifactRepository(db);
    const revision = repository.getRevisionBySha(input.artifactId, input.revisionSha);
    if (revision === null)
      throw new Error("published acceptance revision is missing from the store");
    return ([0, 1] as const)
      .flatMap((tier) => repository.listRenderRuns({ revisionId: revision.id, tier }))
      .map((run) => ({ compiledPath: run.compiledPath ?? null }));
  } finally {
    db.close();
  }
}

/**
 * Project the canonical parsed verdict onto the acceptance
 * surface. Pass-through by design: the canonical `VerdictObserved`
 * shape is the surface, so a new field on the schema is surfaced
 * by default. `insecure` and `screenshotError` are conditional
 * spreads so the wire form for verdicts without them stays
 * byte-identical to the pre-arc shape.
 *
 * Extracted from `readBackFixture` so the schema-derived key-set
 * guard (`tests/unit/facet-testkit-projection.test.ts`) can pin
 * the projection at unit resolution — see the test file's
 * standing-preamble preamble for why dropping fields here is
 * the same class the production client fix eliminated.
 */
export function projectToAcceptanceVerdict(result: ReadBackResult): AcceptanceVerdict {
  const verdict = result.verdict;
  return {
    status: verdict.status,
    tier: verdict.tier === 0 ? 0 : 1,
    renderer: result.renderer,
    artifactId: verdict.artifactId,
    revisionSha: verdict.revisionSha,
    observed: verdict.observed,
    ...(verdict.insecure !== undefined ? { insecure: verdict.insecure } : {}),
    ...(verdict.screenshotError !== undefined ? { screenshotError: verdict.screenshotError } : {}),
    ...(verdict.execution !== undefined ? { execution: verdict.execution } : {}),
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
