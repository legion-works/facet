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

export interface CompiledServiceDeps {
  readonly runServiceProcess?: typeof runServiceProcess;
}

export interface CompiledWorkerDeps {
  readonly stdin?: ReadableStreamDefaultReader<Uint8Array>;
  readonly runWorkerLoop?: typeof runWorkerLoop;
  readonly writeStderr?: (text: string) => void;
  readonly writeStdout?: (text: string) => void;
}

function loadCompiledModules(
  _args: ParsedServiceArgs,
  _env: NodeJS.ProcessEnv,
): Promise<ServiceRunnerModules> {
  return Promise.resolve({
    tier0: { factory: createTier0Runner, probe: probeTier0Isolation },
    loadTier1: () => Promise.resolve({ factory: createTier1Runner, probe: probeTier1Availability }),
  });
}

export async function runCompiledService(
  argv: readonly string[],
  deps: CompiledServiceDeps = {},
): Promise<number> {
  return (deps.runServiceProcess ?? runServiceProcess)(argv, process.env, loadCompiledModules);
}

export async function runCompiledTier0Worker(deps: CompiledWorkerDeps = {}): Promise<number> {
  const stdin = deps.stdin ?? Bun.stdin.stream().getReader();
  const writeStdout = deps.writeStdout ?? process.stdout.write.bind(process.stdout);
  const writeStderr = deps.writeStderr ?? process.stderr.write.bind(process.stderr);
  const workerLoop = deps.runWorkerLoop ?? runWorkerLoop;
  try {
    return await workerLoop(stdin, writeStdout, writeStderr);
  } catch (error) {
    writeStderr(formatWorkerUnhandled(error));
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
