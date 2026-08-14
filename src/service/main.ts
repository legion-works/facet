/**
 * Service entrypoint. Parses a tiny env/arg surface, starts the loopback
 * service, writes a single structured ready line to stderr, and shuts
 * down gracefully on SIGTERM/SIGINT.
 *
 * Recognized env/args:
 *   FACET_INSECURE_AUTO=1       opt into boot-time isolation fallback
 *   --db-path <path>            override default database path
 *   --install-token-path <p>    override install token path
 *   --promote-token-path <p>    override promote token path
 *   --lock-path <p>             override lock path
 *   --evidence-path <p>         override evidence root (parent/child agreement)
 *   --idle-timeout-ms <n>       override idle window (default 30s)
 *   --tier0-runner-path <p>     path to a module exporting `runTier0`;
 *                                the service uses a dynamic import on
 *                                this path so the static boundary
 *                                check still flags any hardcoded
 *                                `src/validation/**` import.
 *   --tier1-runner-path <p>     path to a module exporting `createTier1Runner`;
 *
 * The ready line is a single JSON object on stderr so external CLI
 * tooling can scrape it without parsing prose.
 */

import { createLogger } from "../shared/logging/logger";
import { startFacetService, type RunningService } from "./server";
import type {
  InsecureLevel,
  IsolationProbeResult,
  Tier0IsolationProbe,
  Tier0Runner,
  Tier0RunnerFactory,
  Tier1AvailabilityProbe,
  Tier1Runner,
  Tier1RunnerFactory,
} from "../shared/contracts/validation";
import { FacetError } from "../shared/errors/facet-error";
import { defaultInsecureReason } from "./verdict-enrichment";

interface MutableArgs {
  dbPath?: string;
  installTokenPath?: string;
  promoteTokenPath?: string;
  lockPath?: string;
  evidencePath?: string;
  idleTimeoutMs?: number;
  tier0RunnerPath?: string;
  tier1RunnerPath?: string;
}

interface ParsedArgs {
  readonly dbPath?: string;
  readonly installTokenPath?: string;
  readonly promoteTokenPath?: string;
  readonly lockPath?: string;
  readonly evidencePath?: string;
  readonly idleTimeoutMs?: number;
  readonly tier0RunnerPath?: string;
  readonly tier1RunnerPath?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: MutableArgs = {};
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

/**
 * Dynamic-import the Tier 0 runner from the caller-provided path.
 * The path comes from CLI argv (NOT a static string literal), so the
 * boundary checker's regex does not match — there is no static
 * `import "../validation/..."` in this file. The runtime resolution
 * is the canonical mechanism for cross-process dependency injection
 * in the service child; the CLI (src/cli/) is the only place that
 * knows the concrete path.
 */
interface LoadedTier0Runner {
  readonly factory: Tier0RunnerFactory;
  readonly probe?: Tier0IsolationProbe;
}

interface LoadedTier1Runner {
  readonly factory: Tier1RunnerFactory;
  readonly probe?: Tier1AvailabilityProbe;
}

async function loadTier0Runner(path: string): Promise<LoadedTier0Runner> {
  // The path is an arbitrary string at runtime; TypeScript cannot
  // type-check the import so we cast via unknown. The contract is
  // enforced by `typeof mod.runTier0 === "function"`.
  const dynamicPath = path;
  const mod = (await import(dynamicPath)) as {
    createTier0Runner?: unknown;
    runTier0?: unknown;
    probeTier0Isolation?: unknown;
  };
  if (typeof mod.createTier0Runner === "function") {
    return {
      factory: mod.createTier0Runner as Tier0RunnerFactory,
      ...(typeof mod.probeTier0Isolation === "function"
        ? { probe: mod.probeTier0Isolation as Tier0IsolationProbe }
        : {}),
    };
  }
  if (typeof mod.runTier0 !== "function") {
    throw new FacetError(
      "internal",
      `Tier 0 runner module '${path}' did not export a runTier0 function`,
      { retryable: false },
    );
  }
  const runner = mod.runTier0 as Tier0Runner;
  return { factory: () => runner };
}

async function loadTier1Runner(path: string): Promise<LoadedTier1Runner> {
  const dynamicPath = path;
  const mod = (await import(dynamicPath)) as {
    createTier1Runner?: unknown;
    probeTier1Availability?: unknown;
  };
  if (typeof mod.createTier1Runner !== "function") {
    throw new FacetError(
      "internal",
      `Tier 1 runner module '${path}' did not export a createTier1Runner function`,
      { retryable: false },
    );
  }
  return {
    factory: mod.createTier1Runner as Tier1RunnerFactory,
    ...(typeof mod.probeTier1Availability === "function"
      ? { probe: mod.probeTier1Availability as Tier1AvailabilityProbe }
      : {}),
  };
}

function createLazyTier1Runner(path: string, level: InsecureLevel): Tier1Runner {
  let runner: Promise<Tier1Runner> | undefined;
  return async (input) => {
    runner ??= loadTier1Runner(path).then((loaded) => loaded.factory(level));
    return runner.then((loaded) => loaded(input));
  };
}

function parseInsecureLevel(raw: string | undefined): InsecureLevel {
  if (raw === undefined || raw === "0") return 0;
  if (raw === "1" || raw === "2" || raw === "3") return Number(raw) as InsecureLevel;
  throw new FacetError(
    "invalid_request",
    `FACET_INSECURE must be one of 0, 1, 2, or 3; got '${raw}'`,
    {
      retryable: false,
    },
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

async function main(): Promise<void> {
  const logger = createLogger({ component: "main" });
  const args = parseArgs(process.argv.slice(2));
  const insecureRaw = process.env.FACET_INSECURE;

  let running: RunningService | null = null;
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("service.signal", { signal });
    if (running) await running.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    const forcedLevel = parseInsecureLevel(insecureRaw);
    const autoFallback = isAutoFallbackEnabled(process.env.FACET_INSECURE_AUTO);
    const tier0Module = await loadRequiredTier0Runner(args.tier0RunnerPath);
    const tier1RunnerPath = requireTier1RunnerPath(args.tier1RunnerPath);
    let tier1Module: LoadedTier1Runner | undefined;
    let insecureLevel = forcedLevel;
    let insecureReason: string | null = null;
    if (autoFallback && forcedLevel < 2) {
      tier1Module = await loadTier1Runner(tier1RunnerPath);
      const tier0Probe = requireProbe(tier0Module.probe, "Tier 0 isolation");
      const tier0 = await tier0Probe();
      if (!tier0.available) {
        insecureLevel = 2;
        insecureReason = `auto:${boundedProbeReason(tier0)}`;
      } else if (forcedLevel === 0) {
        const tier1Probe = requireProbe(tier1Module.probe, "Tier 1 availability");
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
    const configuredTier0Runner = tier0Module.factory(insecureLevel);
    const tier1Runner =
      tier1Module === undefined
        ? createLazyTier1Runner(tier1RunnerPath, insecureLevel)
        : tier1Module.factory(insecureLevel);
    running = await startFacetService({
      ...(args.dbPath !== undefined ? { dbPath: args.dbPath } : {}),
      ...(args.installTokenPath !== undefined ? { installTokenPath: args.installTokenPath } : {}),
      ...(args.promoteTokenPath !== undefined ? { promoteTokenPath: args.promoteTokenPath } : {}),
      ...(args.lockPath !== undefined ? { lockPath: args.lockPath } : {}),
      ...(args.evidencePath !== undefined ? { evidencePath: args.evidencePath } : {}),
      ...(args.idleTimeoutMs !== undefined ? { idleTimeoutMs: args.idleTimeoutMs } : {}),
      tier0Runner: configuredTier0Runner,
      tier1Runner,
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
    // Park here so the process stays alive — the idle controller will
    // call stop() once the last reason releases.
    await running.waitUntilIdle();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("service.failed", { errorMessage: message });
    process.exit(1);
  }
}

async function loadRequiredTier0Runner(path: string | undefined): Promise<LoadedTier0Runner> {
  if (path === undefined) {
    throw new FacetError(
      "internal",
      "Tier 0 runner path is required (pass --tier0-runner-path <module>)",
      { retryable: false },
    );
  }
  return loadTier0Runner(path);
}

function requireTier1RunnerPath(path: string | undefined): string {
  if (path === undefined) {
    throw new FacetError(
      "internal",
      "Tier 1 runner path is required (pass --tier1-runner-path <module>)",
      { retryable: false },
    );
  }
  return path;
}

if (import.meta.main) {
  void main();
}
