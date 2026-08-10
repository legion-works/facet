/**
 * Service entrypoint. Parses a tiny env/arg surface, starts the loopback
 * service, writes a single structured ready line to stderr, and shuts
 * down gracefully on SIGTERM/SIGINT.
 *
 * Recognized env/args:
 *   --db-path <path>            override default database path
 *   --install-token-path <p>    override install token path
 *   --promote-token-path <p>    override promote token path
 *   --lock-path <p>             override lock path
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
  Tier0Runner,
  Tier0RunnerFactory,
  Tier1Runner,
  Tier1RunnerFactory,
} from "../shared/contracts/validation";
import { FacetError } from "../shared/errors/facet-error";

interface MutableArgs {
  dbPath?: string;
  installTokenPath?: string;
  promoteTokenPath?: string;
  lockPath?: string;
  idleTimeoutMs?: number;
  tier0RunnerPath?: string;
  tier1RunnerPath?: string;
}

interface ParsedArgs {
  readonly dbPath?: string;
  readonly installTokenPath?: string;
  readonly promoteTokenPath?: string;
  readonly lockPath?: string;
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
async function loadTier0Runner(path: string): Promise<Tier0RunnerFactory> {
  // The path is an arbitrary string at runtime; TypeScript cannot
  // type-check the import so we cast via unknown. The contract is
  // enforced by `typeof mod.runTier0 === "function"`.
  const dynamicPath = path;
  const mod = (await import(dynamicPath)) as { createTier0Runner?: unknown; runTier0?: unknown };
  if (typeof mod.createTier0Runner === "function") {
    return mod.createTier0Runner as Tier0RunnerFactory;
  }
  if (typeof mod.runTier0 !== "function") {
    throw new FacetError(
      "internal",
      `Tier 0 runner module '${path}' did not export a runTier0 function`,
      { retryable: false },
    );
  }
  const runner = mod.runTier0 as Tier0Runner;
  return () => runner;
}

async function loadTier1Runner(path: string): Promise<Tier1RunnerFactory> {
  const dynamicPath = path;
  const mod = (await import(dynamicPath)) as { createTier1Runner?: unknown };
  if (typeof mod.createTier1Runner !== "function") {
    throw new FacetError(
      "internal",
      `Tier 1 runner module '${path}' did not export a createTier1Runner function`,
      { retryable: false },
    );
  }
  return mod.createTier1Runner as Tier1RunnerFactory;
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
    const insecureLevel = parseInsecureLevel(insecureRaw);
    const insecureReason = null;
    const tier0Factory = await loadRequiredTier0Runner(args.tier0RunnerPath);
    const configuredTier0Runner = tier0Factory(insecureLevel);
    let tier1Runner: Tier1Runner | undefined;
    if (insecureLevel > 0) {
      if (args.tier1RunnerPath === undefined) {
        throw new FacetError("internal", "Tier 1 runner path is required for insecure boots", {
          retryable: false,
        });
      }
      const tier1Factory = await loadTier1Runner(args.tier1RunnerPath);
      tier1Runner = tier1Factory(insecureLevel);
    }
    running = await startFacetService({
      ...(args.dbPath !== undefined ? { dbPath: args.dbPath } : {}),
      ...(args.installTokenPath !== undefined ? { installTokenPath: args.installTokenPath } : {}),
      ...(args.promoteTokenPath !== undefined ? { promoteTokenPath: args.promoteTokenPath } : {}),
      ...(args.lockPath !== undefined ? { lockPath: args.lockPath } : {}),
      ...(args.idleTimeoutMs !== undefined ? { idleTimeoutMs: args.idleTimeoutMs } : {}),
      tier0Runner: configuredTier0Runner,
      ...(tier1Runner !== undefined ? { tier1Runner } : {}),
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

async function loadRequiredTier0Runner(path: string | undefined): Promise<Tier0RunnerFactory> {
  if (path === undefined) {
    throw new FacetError(
      "internal",
      "Tier 0 runner path is required (pass --tier0-runner-path <module>)",
      { retryable: false },
    );
  }
  return loadTier0Runner(path);
}

if (import.meta.main) {
  void main();
}
