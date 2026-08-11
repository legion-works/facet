/**
 * Tier 0 runner — the PARENT side of the Tier 0 worker protocol.
 *
 * Spawns the worker subprocess inside a rootless network namespace
 * (via `sandbox/netns.ts`), writes the input envelope to the worker's
 * STDIN, reads STDOUT with a hard byte cap, enforces a wall-clock
 * timeout, kills the worker on overrun, and parses the STDOUT payload
 * via a STRICT zod schema.
 *
 * Worker stdout is treated as UNTRUSTED protocol input. Anything
 * beyond a single well-formed Tier0Result is mapped to a typed
 * `FacetError`:
 *
 *   - `tier0_unavailable`     — unshare / userns not available.
 *   - `tier0_timeout`         — wall-clock budget exceeded.
 *   - `tier0_output_cap`      — stdout exceeded the byte cap.
 *   - `tier0_worker_died`     — worker exited via signal.
 *   - `tier0_protocol_error`  — non-JSON, schema mismatch, or extra
 *                               trailing bytes.
 *
 * Parser-level outcomes (status="error") are returned as Tier0WorkerResult
 * with discriminativeErrors populated; the caller persists them as a
 * render_run bound to (artifactId, revisionSha).
 */

import type { ChildProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";

import type { ArtifactType } from "../../shared/contracts/artifact";
import { FacetError } from "../../shared/errors/facet-error";
import {
  LexicalCountersSchema,
  Tier0WorkerResultSchema,
  type LexicalCounters,
  type InsecureLevel,
  type Tier0Input,
  type Tier0Runner,
  type Tier0WorkerResult,
} from "../../shared/contracts/validation";

import {
  probeNetnsSupport,
  resolveTier0Isolation,
  spawnDirectWorker,
  spawnNetnsWorker,
} from "../sandbox/netns";

export { resolveTier0Isolation } from "../sandbox/netns";

/** Probe the host capability used by Tier 0 without bypassing its cache. */
export function probeTier0Isolation() {
  return probeNetnsSupport();
}

import { TIER0_OUTPUT_CAP_BYTES, TIER0_TIMEOUT_MS } from "../sandbox/limits";

const TIER0_WORKER_ENTRY = resolvePath(import.meta.dir, "worker-entry.ts");

/**
 * The wire envelope the parent writes to the worker's STDIN. The
 * source bytes are base64-encoded so JSON can carry them; the worker
 * decodes them back into a Uint8Array before invoking the parser.
 */
interface WorkerInputEnvelope {
  readonly schemaVersion: "facet.tier0.v1";
  readonly requestId: string;
  readonly revisionSha: string;
  readonly artifactType: ArtifactType;
  readonly renderer: Tier0Input["renderer"];
  readonly sourceBase64: string;
  readonly lexical: LexicalCounters;
}

export interface Tier0RunnerTestHooks {
  readonly workerEntry?: string;
  readonly timeoutMs?: number;
  readonly outputCap?: number;
  readonly onWorkerSpawn?: (pid: number) => void;
}

/**
 * Build the STDIN envelope from a `Tier0Input`. The lexical counters
 * are validated against the closed schema here so a misbehaving
 * caller cannot smuggle extra fields into the worker.
 */
function buildInputEnvelope(input: Tier0Input, requestId: string): WorkerInputEnvelope {
  // The contract says input.source is Uint8Array; we accept anything
  // `instanceof Uint8Array` and base64-encode it.
  const sourceBytes =
    input.source instanceof Uint8Array ? input.source : new Uint8Array(input.source);
  return {
    schemaVersion: "facet.tier0.v1",
    requestId,
    revisionSha: input.revisionSha,
    artifactType: input.artifactType,
    renderer: input.renderer,
    sourceBase64: Buffer.from(sourceBytes).toString("base64"),
    lexical: LexicalCountersSchema.parse(input.lexical),
  };
}

/**
 * Strip the worker's trailing newline (if any) and parse the JSON.
 * A non-JSON payload, a schema mismatch, or extra trailing bytes
 * produces a typed `tier0_protocol_error`.
 *
 * Exported (with a test-only prefix) so the strict-zod guard is
 * directly testable; production code only calls it through
 * `runTier0`.
 */
// oxlint-disable-next-line no-underscore-dangle
export function _parseWorkerStdout(stdout: string, outputCap: number): Tier0WorkerResult {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new FacetError("tier0_protocol_error", "Worker emitted empty stdout", {
      retryable: false,
    });
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FacetError("tier0_protocol_error", `Worker stdout is not valid JSON: ${message}`, {
      retryable: false,
    });
  }
  const result = Tier0WorkerResultSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new FacetError(
      "tier0_protocol_error",
      `Worker stdout does not match Tier0WorkerResultSchema: ${result.error.issues
        .slice(0, 3)
        .map((issue) => issue.message)
        .join("; ")}`,
      { retryable: false },
    );
  }
  // Reject extra trailing bytes — the worker MUST emit exactly one
  // JSON object. A trailing newline is allowed (we trimmed) but any
  // additional content after the closing brace is a protocol violation.
  // The output-cap check above bounds the total size so this is a
  // final correctness gate.
  void outputCap;
  return result.data;
}

interface PendingRequest {
  readonly requestId: string;
  readonly worker: ChildProcess;
  readonly resolve: (result: Tier0WorkerResult) => void;
  readonly reject: (error: FacetError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RunnerOptions {
  readonly workerEntry: string;
  readonly timeoutMs: number;
  readonly outputCap: number;
  readonly onWorkerSpawn?: (pid: number) => void;
}

function workerDiedError(code: number | null, signal: NodeJS.Signals | null): FacetError {
  if (signal !== null) {
    return new FacetError("tier0_worker_died", `Worker terminated by signal ${signal}`, {
      retryable: false,
      details: { signal },
    });
  }
  if (code === null) {
    return new FacetError("tier0_worker_died", "Worker exited without code or signal", {
      retryable: false,
    });
  }
  return new FacetError("tier0_worker_died", `Worker exited with non-zero code ${code}`, {
    retryable: false,
    details: { exitCode: code },
  });
}

function workerStartError(error: unknown, stderr: Buffer): FacetError {
  const fields =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof fields.code === "string" ? fields.code : null;
  const errno =
    typeof fields.errno === "string" || typeof fields.errno === "number" ? fields.errno : null;
  const syscall = typeof fields.syscall === "string" ? fields.syscall : null;
  const stderrText = stderr.toString("utf8").trim() || null;
  const diagnostics = [
    `error=${message}`,
    ...(code === null ? [] : [`code=${code}`]),
    ...(errno === null ? [] : [`errno=${errno}`]),
    ...(syscall === null ? [] : [`syscall=${syscall}`]),
    ...(stderrText === null ? [] : [`stderr=${stderrText}`]),
  ];
  return new FacetError(
    "tier0_worker_died",
    `Worker process failed to start: ${diagnostics.join("; ")}`,
    {
      retryable: false,
      details: {
        code,
        errno,
        syscall,
        stderr: stderrText,
      },
    },
  );
}

function parseWorkerResponse(
  line: Buffer,
  requestId: string,
  outputCap: number,
): Tier0WorkerResult {
  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(line.toString("utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FacetError("tier0_protocol_error", `Worker stdout is not valid JSON: ${message}`, {
      retryable: false,
    });
  }
  if (typeof rawEnvelope !== "object" || rawEnvelope === null || Array.isArray(rawEnvelope)) {
    throw new FacetError("tier0_protocol_error", "Worker response is not an object envelope", {
      retryable: false,
    });
  }
  const envelope = rawEnvelope as { requestId?: unknown; result?: unknown };
  if (envelope.requestId !== requestId) {
    throw new FacetError("tier0_protocol_error", "Worker response requestId did not match", {
      retryable: false,
    });
  }
  if (envelope.result === undefined) {
    throw new FacetError("tier0_protocol_error", "Worker response omitted result", {
      retryable: false,
    });
  }
  return _parseWorkerStdout(JSON.stringify(envelope.result), outputCap);
}

function createRunner(level: InsecureLevel, options: RunnerOptions): Tier0Runner {
  let child: ChildProcess | null = null;
  let pending: PendingRequest | null = null;
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBuffer = Buffer.alloc(0);
  let queued: Promise<void> = Promise.resolve();
  let requestSequence = 0;
  let closed = false;

  function rejectPending(target: PendingRequest, error: FacetError): void {
    if (pending !== target) return;
    clearTimeout(target.timer);
    pending = null;
    target.reject(error);
  }

  function resolvePending(target: PendingRequest, result: Tier0WorkerResult): void {
    if (pending !== target) return;
    clearTimeout(target.timer);
    pending = null;
    target.resolve(result);
  }

  function clearWorker(target: ChildProcess, kill: boolean): void {
    if (child !== target) return;
    child = null;
    stdoutBuffer = Buffer.alloc(0);
    stderrBuffer = Buffer.alloc(0);
    if (!kill) return;
    try {
      target.kill("SIGKILL");
    } catch {
      // The worker may have exited between protocol failure and teardown.
    }
  }

  function failWorker(target: ChildProcess, error: FacetError, kill: boolean): void {
    if (pending?.worker === target) rejectPending(pending, error);
    clearWorker(target, kill);
  }

  function handleStdout(target: ChildProcess, chunk: Buffer): void {
    if (child !== target || pending === null || pending.worker !== target) {
      failWorker(
        target,
        new FacetError("tier0_protocol_error", "Worker emitted stdout without an active request", {
          retryable: false,
        }),
        true,
      );
      return;
    }
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    const newline = stdoutBuffer.indexOf(0x0a);
    if (newline < 0) {
      if (stdoutBuffer.byteLength > options.outputCap) {
        failWorker(
          target,
          new FacetError("tier0_output_cap", "Worker stdout exceeded the byte cap", {
            retryable: false,
            details: { capBytes: options.outputCap },
          }),
          true,
        );
      }
      return;
    }
    const line = stdoutBuffer.subarray(0, newline);
    const trailing = stdoutBuffer.subarray(newline + 1);
    stdoutBuffer = Buffer.alloc(0);
    if (line.byteLength > options.outputCap) {
      failWorker(
        target,
        new FacetError("tier0_output_cap", "Worker stdout exceeded the byte cap", {
          retryable: false,
          details: { capBytes: options.outputCap },
        }),
        true,
      );
      return;
    }
    if (trailing.byteLength > 0) {
      failWorker(
        target,
        new FacetError("tier0_protocol_error", "Worker emitted trailing stdout bytes", {
          retryable: false,
        }),
        true,
      );
      return;
    }
    const active = pending;
    try {
      resolvePending(active, parseWorkerResponse(line, active.requestId, options.outputCap));
    } catch (error) {
      const facet = FacetError.from(error);
      failWorker(target, facet, true);
    }
  }

  function spawnWorker(): ChildProcess {
    const isolation = resolveTier0Isolation(level);
    if (isolation === "netns") {
      const probe = probeNetnsSupport();
      if (!probe.available) {
        throw new FacetError(
          "tier0_unavailable",
          `Tier 0 cannot run: netns unavailable (${probe.reason ?? "unknown"})`,
          { retryable: false, details: { reason: probe.reason ?? "unknown" } },
        );
      }
    }
    const started =
      isolation === "netns"
        ? spawnNetnsWorker(["run", options.workerEntry])
        : spawnDirectWorker(["run", options.workerEntry]);
    child = started;
    options.onWorkerSpawn?.(started.pid!);
    started.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer = Buffer.concat([stderrBuffer, Buffer.from(chunk)]).subarray(
        0,
        options.outputCap,
      );
    });
    started.stderr?.pipe(process.stderr, { end: false });
    started.stdout?.on("data", (chunk: Buffer) => handleStdout(started, Buffer.from(chunk)));
    started.once("error", (error) => {
      failWorker(started, workerStartError(error, stderrBuffer), false);
    });
    started.once("exit", (code, signal) => {
      failWorker(started, workerDiedError(code, signal), false);
    });
    return started;
  }

  async function runRequest(input: Tier0Input): Promise<Tier0WorkerResult> {
    if (closed) {
      throw new FacetError("tier0_worker_died", "Tier 0 runner is closed", { retryable: false });
    }
    const worker = child ?? spawnWorker();
    if (child !== worker)
      throw new FacetError("tier0_worker_died", "Worker exited before request", {
        retryable: false,
      });
    const requestId = String(++requestSequence);
    const envelopeJson = `${JSON.stringify(buildInputEnvelope(input, requestId))}\n`;
    return new Promise<Tier0WorkerResult>((resolve, reject) => {
      const target: PendingRequest = {
        requestId,
        worker,
        resolve,
        reject,
        timer: setTimeout(() => {
          failWorker(
            worker,
            new FacetError(
              "tier0_timeout",
              `Tier 0 worker timed out after ${options.timeoutMs}ms`,
              {
                retryable: false,
                details: { timeoutMs: options.timeoutMs },
              },
            ),
            true,
          );
        }, options.timeoutMs),
      };
      pending = target;
      try {
        worker.stdin?.write(envelopeJson);
      } catch {
        failWorker(
          worker,
          new FacetError("tier0_worker_died", "Failed to write to Tier 0 worker", {
            retryable: false,
          }),
          true,
        );
      }
    });
  }

  const run = (input: Tier0Input): Promise<Tier0WorkerResult> => {
    const request = queued.then(() => runRequest(input));
    queued = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    const active = child;
    if (active === null) return;
    failWorker(
      active,
      new FacetError("tier0_worker_died", "Tier 0 runner closed", { retryable: false }),
      true,
    );
  };

  return Object.assign(run, { close });
}

/**
 * Run the Tier 0 worker against an artifact's immutable bytes. The
 * returned worker result ALWAYS conforms to `Tier0WorkerResultSchema`; the
 * `status` field distinguishes a clean parse (`ok`) from a parser
 * rejection (`error`). System-level failures throw `FacetError` with
 * a typed `tier0_*` code.
 */
export async function runTier0(input: Tier0Input): Promise<Tier0WorkerResult> {
  const runner = createTier0Runner(0);
  try {
    return await runner(input);
  } finally {
    runner.close?.();
  }
}

/** Create a Tier 0 runner using the requested isolation level. */
export function createTier0Runner(level: InsecureLevel): Tier0Runner {
  return createRunner(level, {
    workerEntry: TIER0_WORKER_ENTRY,
    timeoutMs: TIER0_TIMEOUT_MS,
    outputCap: TIER0_OUTPUT_CAP_BYTES,
  });
}

export function createTier0RunnerForTests(
  level: InsecureLevel,
  hooks: Tier0RunnerTestHooks,
): Tier0Runner {
  return createRunner(level, {
    workerEntry: hooks.workerEntry ?? TIER0_WORKER_ENTRY,
    timeoutMs: hooks.timeoutMs ?? TIER0_TIMEOUT_MS,
    outputCap: hooks.outputCap ?? TIER0_OUTPUT_CAP_BYTES,
    ...(hooks.onWorkerSpawn === undefined ? {} : { onWorkerSpawn: hooks.onWorkerSpawn }),
  });
}
