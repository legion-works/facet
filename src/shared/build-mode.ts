export type ServiceLaunch =
  | {
      readonly mode: "source";
      readonly entrypoint: string;
      readonly tier0RunnerPath: string;
      readonly tier1RunnerPath: string;
    }
  | { readonly mode: "compiled" };

export type Tier0WorkerCommand =
  | { readonly mode: "source"; readonly entrypoint: string }
  | { readonly mode: "compiled" };

const BUN_COMPILED_FILESYSTEM_PREFIX = "/$bunfs/";

export function isCompiledRuntime(): boolean {
  return Bun.main.startsWith(BUN_COMPILED_FILESYSTEM_PREFIX);
}

export function buildTier0WorkerArgs(command: Tier0WorkerCommand): string[] {
  return command.mode === "compiled"
    ? ["--facet-internal-tier0-worker"]
    : ["run", command.entrypoint];
}
