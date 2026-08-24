import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  type FacetEnvelope,
  type FacetErrorBody,
  parseEnvelope,
} from "../../shared/contracts/envelope";

const STDERR_DETAIL_LIMIT = 4_096;

export type FacetToolName = "publish" | "read_back" | "status" | "export" | "open";

export interface FacetCliInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
}

export interface FacetCliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type FacetCliRunner = (invocation: FacetCliInvocation) => Promise<FacetCliResult>;

export interface InvokeFacetOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runner?: FacetCliRunner;
  readonly stdin?: string;
}

export class FacetBridgeError extends Error {
  constructor(
    readonly body: FacetErrorBody,
    cause?: unknown,
  ) {
    super(body.message, { cause });
  }
}

function bridgeError(
  code: string,
  message: string,
  details?: FacetErrorBody["details"],
  cause?: unknown,
): FacetBridgeError {
  return new FacetBridgeError(
    {
      code,
      message,
      retryable: false,
      ...(details === undefined ? {} : { details }),
    },
    cause,
  );
}

function requiredString(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  if (typeof value === "string" && value.length > 0) return value;
  throw bridgeError("invalid_request", `${key} is required`);
}

function appendString(args: string[], flag: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) args.push(flag, value);
}

export function buildFacetArgs(
  tool: FacetToolName,
  input: Readonly<Record<string, unknown>>,
): string[] {
  switch (tool) {
    case "publish": {
      const args = [
        "publish",
        "--artifact-id",
        requiredString(input, "artifactId"),
        "--type",
        requiredString(input, "type"),
      ];
      appendString(args, "--renderer", input.renderer);
      appendString(args, "--execution", input.execution);
      appendString(args, "--file", input.file);
      appendString(args, "--note", input.note);
      appendString(args, "--parent-revision-id", input.parentRevisionId);
      return args;
    }
    case "read_back": {
      const args = ["read-back", "--artifact-id", requiredString(input, "artifactId")];
      appendString(args, "--revision-sha", input.revisionSha);
      if (input.tier !== undefined) args.push("--tier", String(input.tier));
      return args;
    }
    case "status": {
      const args = ["status"];
      appendString(args, "--artifact-id", input.artifactId);
      if (input.start === true) args.push("--start");
      return args;
    }
    case "export": {
      const args = [
        "export",
        requiredString(input, "artifactId"),
        "--format",
        requiredString(input, "format"),
      ];
      appendString(args, "--revision", input.revisionSha);
      if (input.force === true) args.push("--force");
      if (input.includeBytes === true) args.push("--include-bytes");
      return args;
    }
    case "open": {
      const args = ["open", "--artifact-id", requiredString(input, "artifactId")];
      appendString(args, "--revision-sha", input.revisionSha);
      args.push("--no-launch");
      return args;
    }
  }
}

function resolveFacetCommand(env: NodeJS.ProcessEnv): Pick<FacetCliInvocation, "command" | "args"> {
  const override = env.FACET_CLI?.trim();
  if (override !== undefined && override.length > 0) return { command: override, args: [] };

  const sourceCli = resolve(import.meta.dir, "../../cli/main.ts");
  if (existsSync(sourceCli)) return { command: Bun.which("bun") ?? "bun", args: [sourceCli] };
  return { command: "facet", args: [] };
}

async function runFacetCli(invocation: FacetCliInvocation): Promise<FacetCliResult> {
  const proc = Bun.spawn([invocation.command, ...invocation.args], {
    stderr: "pipe",
    stdin: invocation.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    ...(invocation.env === undefined ? {} : { env: invocation.env }),
  });
  if (invocation.stdin !== undefined) {
    const stdin = proc.stdin;
    if (stdin === undefined) throw new Error("Facet CLI stdin pipe was not created");
    stdin.write(invocation.stdin);
    stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function boundedStderr(stderr: string): string {
  const normalized = stderr.trim();
  if (normalized.length <= STDERR_DETAIL_LIMIT) return normalized;
  return `${normalized.slice(0, STDERR_DETAIL_LIMIT)}…`;
}

export function parseFacetStdout(stdout: string): FacetEnvelope<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw bridgeError("invalid_envelope", "Invalid Facet envelope on stdout", undefined, cause);
  }
  const parsed = parseEnvelope(value);
  if (parsed.ok) return parsed.envelope;
  throw new FacetBridgeError({
    ...parsed.body,
    message: `Invalid Facet envelope: ${parsed.body.message}`,
  });
}

export async function invokeFacet(
  args: readonly string[],
  options: InvokeFacetOptions = {},
): Promise<FacetEnvelope<unknown>> {
  const env = options.env ?? process.env;
  const resolved = resolveFacetCommand(env);
  const invocation: FacetCliInvocation = {
    command: resolved.command,
    args: [...resolved.args, ...args],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  };
  const result = await (options.runner ?? runFacetCli)(invocation);
  try {
    return parseFacetStdout(result.stdout);
  } catch (cause) {
    const error =
      cause instanceof FacetBridgeError
        ? cause
        : bridgeError(
            "invalid_envelope",
            cause instanceof Error ? cause.message : String(cause),
            undefined,
            cause,
          );
    throw new FacetBridgeError(
      {
        ...error.body,
        details: {
          ...error.body.details,
          exitCode: result.exitCode,
          ...(result.stderr.length === 0 ? {} : { stderr: boundedStderr(result.stderr) }),
        },
      },
      cause,
    );
  }
}
