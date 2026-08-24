import {
  runServiceProcess,
  type ParsedServiceArgs,
  type ServiceRunnerModules,
} from "../service/process";
import { createTier0Runner, probeTier0Isolation } from "../validation/tier0/runner";
import { formatWorkerUnhandled, runWorkerLoop } from "../validation/tier0/worker-entry";
import { createTier1Runner, probeTier1Availability } from "../validation/tier1/runner";

export { buildTier0WorkerArgs } from "../shared/build-mode";

export interface CompiledEntrypointHooks {
  readonly runService?: (argv: readonly string[]) => Promise<number>;
  readonly runTier0Worker?: () => Promise<number>;
}

function loadCompiledModules(
  _args: ParsedServiceArgs,
  _env: NodeJS.ProcessEnv,
): Promise<ServiceRunnerModules> {
  return Promise.resolve({
    tier0: { factory: createTier0Runner, probe: probeTier0Isolation },
    tier1: { factory: createTier1Runner, probe: probeTier1Availability },
  });
}

async function runCompiledService(argv: readonly string[]): Promise<number> {
  return runServiceProcess(argv, process.env, loadCompiledModules);
}

async function runCompiledTier0Worker(): Promise<number> {
  try {
    return await runWorkerLoop(
      Bun.stdin.stream().getReader(),
      process.stdout.write.bind(process.stdout),
      process.stderr.write.bind(process.stderr),
    );
  } catch (error) {
    process.stderr.write(formatWorkerUnhandled(error));
    return 1;
  }
}

export async function dispatchCompiledEntrypoint(
  argv: readonly string[],
  hooks: CompiledEntrypointHooks = {},
): Promise<number | null> {
  if (argv[0] === "--facet-internal-service") {
    return (hooks.runService ?? runCompiledService)(argv.slice(1));
  }
  if (argv[0] === "--facet-internal-tier0-worker") {
    return (hooks.runTier0Worker ?? runCompiledTier0Worker)();
  }
  return null;
}
