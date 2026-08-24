#!/usr/bin/env bun

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
import { existsSync, readFileSync } from "node:fs";

import { FACET_SCHEMA_VERSION, okEnvelope, type FacetEnvelope } from "../shared/contracts/envelope";
import type { CommandRequest, CommandResult, CommandName } from "../shared/contracts/commands";
import { FacetError } from "../shared/errors/facet-error";
import { FACET_VERSION } from "../shared/version";
import { isCompiledEntrypointArg, isCompiledRuntime } from "../shared/build-mode";

import { parseArgs, renderHelp, type ParsedCommand } from "./parser";
import { buildVersionEnvelope, buildUsageError, printEnvelope, EXIT_CODES } from "./output";
import { ensureService, type ServiceHooks } from "./spawn-service";
import { FacetClient } from "./client";

import { buildCreateRequest } from "./commands/create";
import { buildListRequest } from "./commands/list";
import { buildOpenRequest, launchDisplay } from "./commands/open";
import { buildPinRequest } from "./commands/pin";
import { buildPromoteRequest } from "./commands/promote";
import { buildInstantiateRequest } from "./commands/instantiate";
import { buildReadBackRequest } from "./commands/read-back";
import { buildStatusRequest } from "./commands/status";
import { collectFacetStatus } from "./commands/status";
import { computeFacetPaths, legacyXdgEvidenceRoot } from "../shared/config/paths";
import { readInstallToken, readLiveMetadata } from "./service-metadata";
import { generateRequestId } from "../shared/util/time";
import { buildPublishRequest, resolveSourceBytes } from "./commands/publish";
import { buildExportRequest, resolveExportPaths, writeExportFiles } from "./commands/export";
import { presentEnvelope, presenterCaps, shouldPresentPretty } from "./presenter";
import { runDoctor } from "./commands/doctor";

export interface CliIo {
  /** A standard Readable stream of bytes — the CLI reads source bytes for `publish` from here. */
  readonly stdin: ReadableStream<Uint8Array> | Readable;
  readonly stdout: { write(chunk: string | Uint8Array): boolean; readonly isTTY?: boolean };
  readonly stderr: { write(chunk: string | Uint8Array): boolean };
  readonly env: NodeJS.ProcessEnv;
}

export function writeEnvelope(
  io: CliIo,
  parsed: ParsedCommand,
  envelope: FacetEnvelope<unknown>,
): void {
  const routing = {
    isTTY: io.stdout.isTTY === true,
    jsonFlag: parsed.kind === "verb" && parsed.jsonFlag,
    env: io.env,
  };
  if (shouldPresentPretty(routing)) {
    for (const line of presentEnvelope(envelope, presenterCaps(routing)))
      io.stdout.write(`${line}\n`);
  } else {
    printEnvelope(io.stdout, envelope);
  }
}

/**
 * Test-only side-channels. The production entrypoint never passes
 * these; the test suite uses them to count real spawns and to
 * disable the in-process inflight wait map.
 */
export interface CliTestHooks {
  readonly onServiceSpawn?: () => void;
  readonly bypassInflight?: boolean;
  readonly openLauncher?: (url: string) => void | Promise<void>;
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
  verb: Extract<ParsedCommand, { kind: "verb" }> & { verb: CommandName },
  args: Readonly<Record<string, string | boolean>>,
  stdinBytes: Uint8Array,
  resolved: { baseUrl: string; installToken: string; promoteToken?: string },
  openLauncher?: (url: string) => void | Promise<void>,
  cwd = process.cwd(),
  promoteToken?: string,
): Promise<FacetEnvelope<unknown>> {
  const client = new FacetClient({
    baseUrl: resolved.baseUrl,
    installToken: resolved.installToken,
    ...(promoteToken === undefined ? {} : { promoteToken }),
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
      request = buildExportRequest(args);
      break;
    default: {
      const exhaustive: never = verb.verb;
      void exhaustive;
      throw new FacetError("invalid_request", `Unhandled verb`, { retryable: false });
    }
  }
  const response = await client.sendCommand(request);
  if (verb.verb === "export" && response.ok) {
    const result = response.data as Extract<CommandResult, { command: "export" }>;
    const paths = resolveExportPaths(
      result,
      typeof args.out === "string" ? args.out : undefined,
      cwd,
    );
    try {
      writeExportFiles(result, paths, args.force === true);
    } catch (cause) {
      if (cause instanceof FacetError) throw cause;
      throw new FacetError(
        "output_unwritable",
        `Cannot write export output: ${paths.artifactPath}`,
        {
          retryable: false,
          cause,
          details: { out: paths.artifactPath },
        },
      );
    }
    if (args["include-bytes"] !== true) {
      const { bytes: _bytes, ...projected } = result;
      void _bytes;
      return {
        ...response,
        data: { ...projected, paths, byteCount: Buffer.from(result.bytes, "base64").byteLength },
      };
    }
  }
  if (verb.verb === "open" && response.ok) {
    const openData = response.data as Extract<CommandResult, { command: "open" }>;
    const launched =
      args["no-launch"] === true
        ? false
        : await launchDisplay(
            { frameUrl: openData.frameUrl, installToken: resolved.installToken },
            openLauncher,
          );
    return { ...response, data: { ...openData, launched } };
  }
  return response;
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
    io.stdout.write(renderHelp(parsed.verb));
    io.stdout.write("\n");
    return { code: EXIT_CODES.OK, spawnedPid: null };
  }
  if (parsed.kind === "version") {
    if (parsed.format === "json") {
      printEnvelope(io.stdout, buildVersionEnvelope(FACET_VERSION, FACET_SCHEMA_VERSION));
    } else {
      io.stdout.write(`facet ${FACET_VERSION} (${FACET_SCHEMA_VERSION})\n`);
    }
    return { code: EXIT_CODES.OK, spawnedPid: null };
  }
  if (parsed.kind === "usage") {
    const env1 = buildUsageError(parsed.message, {
      reason: "usage_error",
      ...parsed.details,
    });
    printEnvelope(io.stdout, env1);
    return { code: EXIT_CODES.USAGE, spawnedPid: null };
  }

  if (parsed.kind === "verb" && parsed.verb === "doctor") {
    const result = runDoctor({
      paths: computeFacetPaths(
        io.env.FACET_HOME === undefined ? {} : { facetHome: io.env.FACET_HOME },
      ),
    });
    writeEnvelope(io, parsed, {
      schemaVersion: FACET_SCHEMA_VERSION,
      requestId: generateRequestId(),
      ok: true,
      data: result,
    });
    return { code: result.allPassed ? EXIT_CODES.OK : EXIT_CODES.DOCTOR_FAILED, spawnedPid: null };
  }

  if (
    parsed.kind === "verb" &&
    parsed.verb === "status" &&
    parsed.args["artifact-id"] === undefined
  ) {
    const pathsEnv = io.env.FACET_HOME === undefined ? {} : { facetHome: io.env.FACET_HOME };
    const paths = computeFacetPaths(pathsEnv);
    const legacyEvidenceRoot = legacyXdgEvidenceRoot(pathsEnv);
    try {
      let spawnedPid: number | null = null;
      let resolved: { baseUrl: string; installToken: string } | null = null;
      if (parsed.args.start === true) {
        const started = await ensureService({ env: io.env }, testHooks as ServiceHooks);
        spawnedPid = started.metadata.pid;
        resolved = { baseUrl: started.baseUrl, installToken: started.installToken };
      } else {
        const metadata = readLiveMetadata(paths);
        if (metadata !== null) {
          resolved = {
            baseUrl: `http://127.0.0.1:${metadata.port}`,
            installToken: readInstallToken(paths),
          };
        }
      }
      if (resolved !== null) {
        const response = await new FacetClient(resolved).sendCommand(buildStatusRequest({}));
        writeEnvelope(io, parsed, response);
        return { code: EXIT_CODES.OK, spawnedPid };
      }
      const data = {
        command: "status" as const,
        ...collectFacetStatus(paths, undefined, legacyEvidenceRoot),
      };
      writeEnvelope(io, parsed, okEnvelope(generateRequestId(), data));
      return { code: EXIT_CODES.OK, spawnedPid };
    } catch (error) {
      const facet = error instanceof FacetError ? error : FacetError.from(error);
      const env1: FacetEnvelope<never> = {
        schemaVersion: FACET_SCHEMA_VERSION,
        requestId: generateRequestId(),
        ok: false,
        error: facet.toBody(),
      };
      writeEnvelope(io, parsed, env1);
      return { code: EXIT_CODES.OK, spawnedPid: null };
    }
  }

  // 3. Read stdin up front (cheap when empty; needed for `publish -`).
  const stdinBytes = await readAllStdin(io.stdin);

  // 4. Lazy-spawn the service and resolve its baseUrl + install token.
  let resolved: {
    baseUrl: string;
    installToken: string;
    promoteToken?: string;
    metadata: { pid: number; startTime: number; port: number; contractVersion: string };
  };
  let promoteToken: string | undefined;
  try {
    const r = await ensureService({ env: io.env }, testHooks as ServiceHooks);
    const paths = computeFacetPaths(
      io.env.FACET_HOME === undefined ? {} : { facetHome: io.env.FACET_HOME },
    );
    promoteToken =
      io.env.FACET_PROMOTE_TOKEN ??
      (existsSync(paths.token) ? readFileSync(paths.token, "utf8").trim() : undefined);
    resolved = {
      baseUrl: r.baseUrl,
      installToken: r.installToken,
      metadata: r.metadata,
      ...(promoteToken === undefined || promoteToken.length === 0 ? {} : { promoteToken }),
    };
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
    const serviceVerb = parsed as Extract<ParsedCommand, { kind: "verb" }> & { verb: CommandName };
    const response = await executeVerb(
      serviceVerb,
      parsed.args,
      stdinBytes,
      {
        baseUrl: resolved.baseUrl,
        installToken: resolved.installToken,
      },
      testHooks.openLauncher,
      process.cwd(),
      promoteToken,
    );
    writeEnvelope(io, parsed, response);
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
    writeEnvelope(io, parsed, env1);
    if (error instanceof FacetError) {
      return { code: EXIT_CODES.OK, spawnedPid: resolved.metadata.pid };
    }
    return { code: EXIT_CODES.INTERNAL, spawnedPid: resolved.metadata.pid };
  }
}

/**
 * Real entrypoint. Compiled hidden roles are resolved lazily so source CLI
 * commands never evaluate validation's Tier 1 runtime graph.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isCompiledRuntime() && isCompiledEntrypointArg(argv)) {
    const { dispatchCompiledEntrypoint } = await import("../runtime/compiled-entrypoints");
    const compiledExit = await dispatchCompiledEntrypoint(argv);
    if (compiledExit !== null) {
      process.exit(compiledExit);
      return;
    }
  }
  const exit = await runCli(argv, {
    stdin: process.stdin as unknown as ReadableStream<Uint8Array>,
    stdout: {
      get isTTY() {
        return process.stdout.isTTY === true;
      },
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
