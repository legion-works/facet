/**
 * CLI entrypoint.
 *
 * `runCli(argv, io)` is the testable core: it parses argv, decides
 * whether the kill switch is active, lazily spawns the service on
 * first call, builds a strict `CommandRequest` for the verb, sends
 * it through the loopback HTTP client, and prints the response
 * envelope to stdout. All diagnostics go to stderr.
 *
 * `main()` is a thin wrapper that calls `runCli(process.argv.slice(2),
 * { stdin, stdout, stderr, env: process.env })` and then
 * `process.exit(code)`. The split keeps tests hermetic — every test
 * can pass its own io bag without ever spawning a real subprocess
 * from the test runner.
 *
 * stdout is reserved for the versioned JSON envelope. `--help` and
 * `--version` honor `--format text|json`; verb calls always print
 * a JSON envelope. The kill switch `FACET=off` is a clean no-op
 * (exit 0, no service spawned, no envelope on stdout).
 */

import type { Readable } from "node:stream";

import { FACET_SCHEMA_VERSION, okEnvelope, type FacetEnvelope } from "../shared/contracts/envelope";
import type { CommandRequest, CommandResult } from "../shared/contracts/commands";
import { FacetError } from "../shared/errors/facet-error";

import { parseArgs, renderHelp, type ParsedCommand } from "./parser";
import { buildVersionEnvelope, buildUsageError, printEnvelope, EXIT_CODES } from "./output";
import { ensureService, type ServiceHooks } from "./spawn-service";
import { FacetClient } from "./client";

import { buildCreateRequest } from "./commands/create";
import { buildListRequest } from "./commands/list";
import { buildOpenRequest } from "./commands/open";
import { buildPinRequest } from "./commands/pin";
import { buildPromoteRequest } from "./commands/promote";
import { buildInstantiateRequest } from "./commands/instantiate";
import { buildReadBackRequest } from "./commands/read-back";
import { buildStatusRequest } from "./commands/status";
import { buildPublishRequest, resolveSourceBytes } from "./commands/publish";

export interface CliIo {
  /** A standard Readable stream of bytes — the CLI reads source bytes for `publish` from here. */
  readonly stdin: ReadableStream<Uint8Array> | Readable;
  readonly stdout: { write(chunk: string | Uint8Array): boolean };
  readonly stderr: { write(chunk: string | Uint8Array): boolean };
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Test-only side-channels. The production entrypoint never passes
 * these; the test suite uses them to count real spawns and to
 * disable the in-process inflight wait map.
 */
export interface CliTestHooks {
  readonly onServiceSpawn?: () => void;
  readonly bypassInflight?: boolean;
}

export interface CliExit {
  readonly code: number;
  /** The pid the CLI spawned the service under, when applicable (null when reusing a live service). */
  readonly spawnedPid: number | null;
}

/**
 * Read all bytes from a ReadableStream or a Node Readable. Used by
 * `publish --file -` and by tests that pass a fixed byte payload.
 */
async function readAllStdin(stdin: CliIo["stdin"]): Promise<Uint8Array> {
  // Node Readable path: collect chunks via async iterator.
  if (typeof (stdin as Readable)[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  // Web ReadableStream path.
  const stream = stdin as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Dispatch a parsed verb to its builder, send the request, and
 * return the response envelope. Throws on builder-side usage errors
 * (caught by the caller and wrapped in a typed envelope).
 */
async function executeVerb(
  verb: ParsedCommand & { kind: "verb" },
  args: Readonly<Record<string, string | boolean>>,
  stdinBytes: Uint8Array,
  resolved: { baseUrl: string; installToken: string },
): Promise<FacetEnvelope<CommandResult>> {
  const client = new FacetClient({
    baseUrl: resolved.baseUrl,
    installToken: resolved.installToken,
  });
  let request: CommandRequest;
  switch (verb.verb) {
    case "create":
      request = buildCreateRequest(args);
      break;
    case "publish": {
      const bytes = resolveSourceBytes({
        fileFlag: typeof args["file"] === "string" ? args["file"] : undefined,
        stdinBytes,
      });
      request = buildPublishRequest(args, bytes);
      break;
    }
    case "list":
      request = buildListRequest(args);
      break;
    case "readBack":
      request = buildReadBackRequest(args);
      break;
    case "status":
      request = buildStatusRequest(args);
      break;
    case "open":
      request = buildOpenRequest(args);
      break;
    case "promote":
      request = buildPromoteRequest(args);
      break;
    case "instantiate":
      request = buildInstantiateRequest(args);
      break;
    case "pin":
      request = buildPinRequest(args);
      break;
    case "export":
      request = {
        command: "export",
        requestId: `req-${crypto.randomUUID()}`,
        format: typeof args["format"] === "string" ? args["format"] : "html",
      };
      break;
    default: {
      const exhaustive: never = verb.verb;
      void exhaustive;
      throw new FacetError("invalid_request", `Unhandled verb`, { retryable: false });
    }
  }
  return client.sendCommand(request);
}

/**
 * Top-level CLI driver. Returns the exit code + the pid the CLI
 * spawned (for test assertions); never calls `process.exit` so
 * tests can run end-to-end without a real subprocess.
 *
 * The third arg is test-only and lets the concurrency test count
 * real spawns + disable the in-process inflight wait map.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  testHooks: CliTestHooks = {},
): Promise<CliExit> {
  // 1. Kill switch: FACET=off is a clean no-op.
  if ((io.env.FACET ?? "").toLowerCase() === "off") {
    return { code: EXIT_CODES.OK, spawnedPid: null };
  }
  const parsed = parseArgs(argv);

  // 2. Meta commands: --help, --version.
  if (parsed.kind === "help") {
    io.stdout.write(renderHelp());
    io.stdout.write("\n");
    return { code: EXIT_CODES.OK, spawnedPid: null };
  }
  if (parsed.kind === "version") {
    if (parsed.format === "json") {
      printEnvelope(io.stdout, buildVersionEnvelope("0.1.0", FACET_SCHEMA_VERSION));
    } else {
      io.stdout.write(`facet 0.1.0 (${FACET_SCHEMA_VERSION})\n`);
    }
    return { code: EXIT_CODES.OK, spawnedPid: null };
  }
  if (parsed.kind === "usage") {
    const env1 = buildUsageError(parsed.message, { reason: "usage_error" });
    printEnvelope(io.stdout, env1);
    return { code: EXIT_CODES.USAGE, spawnedPid: null };
  }

  // 3. Read stdin up front (cheap when empty; needed for `publish -`).
  const stdinBytes = await readAllStdin(io.stdin);

  // 4. Lazy-spawn the service and resolve its baseUrl + install token.
  let resolved: {
    baseUrl: string;
    installToken: string;
    metadata: { pid: number; startTime: number; port: number; contractVersion: string };
  };
  try {
    const r = await ensureService({ env: io.env }, testHooks as ServiceHooks);
    resolved = { baseUrl: r.baseUrl, installToken: r.installToken, metadata: r.metadata };
  } catch (error) {
    // Any `FacetError` produces a well-formed envelope on stdout;
    // adapters branch on the envelope, so exit 0. A non-FacetError
    // (unexpected runtime failure) is mapped to a generic internal
    // envelope and exits INTERNAL so shell pipelines can see it.
    const facet = error instanceof FacetError ? error : FacetError.from(error);
    const env1: FacetEnvelope<never> = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: `req-${crypto.randomUUID()}`,
      ok: false,
      error: facet.toBody(),
    };
    printEnvelope(io.stdout, env1);
    if (error instanceof FacetError) {
      return { code: EXIT_CODES.OK, spawnedPid: null };
    }
    return { code: EXIT_CODES.INTERNAL, spawnedPid: null };
  }

  // 5. Dispatch the verb.
  try {
    const response = await executeVerb(parsed, parsed.args, stdinBytes, {
      baseUrl: resolved.baseUrl,
      installToken: resolved.installToken,
    });
    printEnvelope(io.stdout, response);
    return { code: EXIT_CODES.OK, spawnedPid: resolved.metadata.pid };
  } catch (error) {
    // Any `FacetError` (typed validation, connection failure, contract
    // mismatch) yields a well-formed envelope on stdout — adapters
    // branch on the envelope, so the exit code stays 0. Non-FacetError
    // throws (e.g. unexpected runtime errors) are mapped to a generic
    // internal envelope and exit INTERNAL so shell pipelines see a
    // distinct nonzero code.
    const facet = error instanceof FacetError ? error : FacetError.from(error);
    const env1: FacetEnvelope<CommandResult> = {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: `req-${crypto.randomUUID()}`,
      ok: false,
      error: facet.toBody(),
    };
    printEnvelope(io.stdout, env1);
    if (error instanceof FacetError) {
      return { code: EXIT_CODES.OK, spawnedPid: resolved.metadata.pid };
    }
    return { code: EXIT_CODES.INTERNAL, spawnedPid: resolved.metadata.pid };
  }
}

/**
 * Real entrypoint. Reads `process.argv`, hands I/O to `runCli`,
 * and exits with the returned code. Kept as a one-liner so the
 * test surface (`runCli`) stays hermetic.
 */
async function main(): Promise<void> {
  const exit = await runCli(process.argv.slice(2), {
    stdin: process.stdin as unknown as ReadableStream<Uint8Array>,
    stdout: {
      write(chunk) {
        process.stdout.write(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      },
    },
    stderr: {
      write(chunk) {
        process.stderr.write(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      },
    },
    env: process.env,
  });
  process.exit(exit.code);
}

// Re-export `okEnvelope` for the test that builds expected envelopes
// alongside the wire output. Pure re-export — no behavior change.
export { okEnvelope };

if (import.meta.main) {
  void main();
}
