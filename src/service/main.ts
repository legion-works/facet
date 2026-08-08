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
 *
 * The ready line is a single JSON object on stderr so external CLI
 * tooling can scrape it without parsing prose.
 */

import { createLogger } from "../shared/logging/logger";
import { startFacetService, type RunningService } from "./server";

interface MutableArgs {
  dbPath?: string;
  installTokenPath?: string;
  promoteTokenPath?: string;
  lockPath?: string;
  idleTimeoutMs?: number;
}

interface ParsedArgs {
  readonly dbPath?: string;
  readonly installTokenPath?: string;
  readonly promoteTokenPath?: string;
  readonly lockPath?: string;
  readonly idleTimeoutMs?: number;
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
    }
  }
  return out;
}

async function main(): Promise<void> {
  const logger = createLogger({ component: "main" });
  const args = parseArgs(process.argv.slice(2));

  let running: RunningService | null = null;
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("service.signal", { signal });
    if (running) await running.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    running = await startFacetService({
      ...(args.dbPath !== undefined ? { dbPath: args.dbPath } : {}),
      ...(args.installTokenPath !== undefined ? { installTokenPath: args.installTokenPath } : {}),
      ...(args.promoteTokenPath !== undefined ? { promoteTokenPath: args.promoteTokenPath } : {}),
      ...(args.lockPath !== undefined ? { lockPath: args.lockPath } : {}),
      ...(args.idleTimeoutMs !== undefined ? { idleTimeoutMs: args.idleTimeoutMs } : {}),
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

if (import.meta.main) {
  void main();
}
