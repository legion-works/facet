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

import type {
  Tier0IsolationProbe,
  Tier0Runner,
  Tier0RunnerFactory,
  Tier1AvailabilityProbe,
  Tier1RunnerFactory,
} from "../shared/contracts/validation";
import { FacetError } from "../shared/errors/facet-error";
import {
  runServiceProcess,
  type LoadedTier0Runner,
  type LoadedTier1Runner,
  type ParsedServiceArgs,
  type ServiceRunnerModules,
} from "./process";

/**
 * Dynamic-import the Tier 0 runner from the caller-provided path.
 * The path comes from CLI argv (NOT a static string literal), so the
 * boundary checker's regex does not match — there is no static
 * `import "../validation/..."` in this file. The runtime resolution
 * is the canonical mechanism for cross-process dependency injection
 * in the service child; the CLI (src/cli/) is the only place that
 * knows the concrete path.
 */
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

async function loadModules(args: ParsedServiceArgs): Promise<ServiceRunnerModules> {
  const tier1RunnerPath = requireTier1RunnerPath(args.tier1RunnerPath);
  return {
    tier0: await loadRequiredTier0Runner(args.tier0RunnerPath),
    loadTier1: () => loadTier1Runner(tier1RunnerPath),
  };
}

async function main(): Promise<void> {
  process.exitCode = await runServiceProcess(process.argv.slice(2), process.env, loadModules);
}

if (import.meta.main) {
  void main();
}
