import { createLogger } from "../shared/logging/logger";
import type {
  InsecureLevel,
  IsolationProbeResult,
  Tier0IsolationProbe,
  Tier0RunnerFactory,
  Tier1AvailabilityProbe,
  Tier1Runner,
  Tier1RunnerFactory,
} from "../shared/contracts/validation";
import { FacetError } from "../shared/errors/facet-error";

import { startFacetService, type RunningService } from "./server";
import { defaultInsecureReason } from "./verdict-enrichment";

interface MutableServiceArgs {
  dbPath?: string;
  installTokenPath?: string;
  promoteTokenPath?: string;
  lockPath?: string;
  evidencePath?: string;
  idleTimeoutMs?: number;
  tier0RunnerPath?: string;
  tier1RunnerPath?: string;
}

export interface ParsedServiceArgs {
  readonly dbPath?: string;
  readonly installTokenPath?: string;
  readonly promoteTokenPath?: string;
  readonly lockPath?: string;
  readonly evidencePath?: string;
  readonly idleTimeoutMs?: number;
  readonly tier0RunnerPath?: string;
  readonly tier1RunnerPath?: string;
}

export interface LoadedTier0Runner {
  readonly factory: Tier0RunnerFactory;
  readonly probe?: Tier0IsolationProbe;
}

export interface LoadedTier1Runner {
  readonly factory: Tier1RunnerFactory;
  readonly probe?: Tier1AvailabilityProbe;
}

export interface ServiceRunnerModules {
  readonly tier0: LoadedTier0Runner;
  readonly tier1: LoadedTier1Runner;
}

export function parseServiceArgs(argv: readonly string[]): ParsedServiceArgs {
  const out: MutableServiceArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db-path") {
      const value = argv[i + 1];
      if (value !== undefined) {
        out.dbPath = value;
        i += 1;
      }
    } else if (arg === "--install-token-path") {
      const value = argv[i + 1];
      if (value !== undefined) {
        out.installTokenPath = value;
        i += 1;
      }
    } else if (arg === "--promote-token-path") {
      const value = argv[i + 1];
      if (value !== undefined) {
        out.promoteTokenPath = value;
        i += 1;
      }
    } else if (arg === "--lock-path") {
      const value = argv[i + 1];
      if (value !== undefined) {
        out.lockPath = value;
        i += 1;
      }
    } else if (arg === "--evidence-path") {
      const value = argv[i + 1];
      if (value !== undefined) {
        out.evidencePath = value;
        i += 1;
      }
    } else if (arg === "--idle-timeout-ms") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        out.idleTimeoutMs = value;
        i += 1;
      }
    } else if (arg === "--tier0-runner-path") {
      const value = argv[i + 1];
      if (value !== undefined) {
        out.tier0RunnerPath = value;
        i += 1;
      }
    } else if (arg === "--tier1-runner-path") {
      const value = argv[i + 1];
      if (value !== undefined) {
        out.tier1RunnerPath = value;
        i += 1;
      }
    }
  }
  return out;
}

function parseInsecureLevel(raw: string | undefined): InsecureLevel {
  if (raw === undefined || raw === "0") return 0;
  if (raw === "1" || raw === "2" || raw === "3") return Number(raw) as InsecureLevel;
  throw new FacetError(
    "invalid_request",
    `FACET_INSECURE must be one of 0, 1, 2, or 3; got '${raw}'`,
    { retryable: false },
  );
}

function isAutoFallbackEnabled(raw: string | undefined): boolean {
  return raw === "1";
}

function boundedProbeReason(result: IsolationProbeResult): string {
  const reason = result.reason?.trim() || "unavailable";
  return reason.slice(0, 240);
}

function requireProbe<T>(probe: T | undefined, label: string): T {
  if (probe !== undefined) return probe;
  throw new FacetError("internal", `${label} probe is required for insecure auto fallback`, {
    retryable: false,
  });
}

function createLazyTier1Runner(factory: Tier1RunnerFactory, level: InsecureLevel): Tier1Runner {
  let runner: Tier1Runner | undefined;
  return async (input) => {
    runner ??= factory(level);
    return runner(input);
  };
}

export async function runServiceProcess(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  loadModules: (args: ParsedServiceArgs, env: NodeJS.ProcessEnv) => Promise<ServiceRunnerModules>,
): Promise<number> {
  const logger = createLogger({ component: "main" });
  const args = parseServiceArgs(argv);
  let running: RunningService | null = null;
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("service.signal", { signal });
    if (running) await running.stop();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    const forcedLevel = parseInsecureLevel(env.FACET_INSECURE);
    const autoFallback = isAutoFallbackEnabled(env.FACET_INSECURE_AUTO);
    const modules = await loadModules(args, env);
    let insecureLevel = forcedLevel;
    let insecureReason: string | null = null;
    if (autoFallback && forcedLevel < 2) {
      const tier0Probe = requireProbe(modules.tier0.probe, "Tier 0 isolation");
      const tier0 = await tier0Probe();
      if (!tier0.available) {
        insecureLevel = 2;
        insecureReason = `auto:${boundedProbeReason(tier0)}`;
      } else if (forcedLevel === 0) {
        const tier1Probe = requireProbe(modules.tier1.probe, "Tier 1 availability");
        const tier1 = await tier1Probe();
        if (!tier1.available) {
          insecureLevel = 1;
          insecureReason = `auto:${boundedProbeReason(tier1)}`;
        }
      }
    }
    if (insecureLevel > 0) {
      const reason = insecureReason ?? defaultInsecureReason(insecureLevel);
      process.stderr.write(`WARN: FACET_INSECURE=${insecureLevel} — ${reason}\n`);
    }
    running = await startFacetService({
      ...(args.dbPath !== undefined ? { dbPath: args.dbPath } : {}),
      ...(args.installTokenPath !== undefined ? { installTokenPath: args.installTokenPath } : {}),
      ...(args.promoteTokenPath !== undefined ? { promoteTokenPath: args.promoteTokenPath } : {}),
      ...(args.lockPath !== undefined ? { lockPath: args.lockPath } : {}),
      ...(args.evidencePath !== undefined ? { evidencePath: args.evidencePath } : {}),
      ...(args.idleTimeoutMs !== undefined ? { idleTimeoutMs: args.idleTimeoutMs } : {}),
      tier0Runner: modules.tier0.factory(insecureLevel),
      tier1Runner: createLazyTier1Runner(modules.tier1.factory, insecureLevel),
      insecureLevel,
      insecureReason,
      logger,
    });
    process.stderr.write(
      `${JSON.stringify({
        event: "service.ready",
        component: "main",
        timestamp: new Date().toISOString(),
        pid: process.pid,
        port: running.port,
        url: running.url,
        ...(insecureLevel > 0
          ? {
              insecureLevel,
              insecureReason: insecureReason ?? defaultInsecureReason(insecureLevel),
            }
          : {}),
      })}\n`,
    );
    await running.waitUntilIdle();
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("service.failed", { errorMessage: message });
    return 1;
  }
}
