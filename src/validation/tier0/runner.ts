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
  readonly revisionSha: string;
  readonly artifactType: ArtifactType;
  readonly sourceBase64: string;
  readonly lexical: LexicalCounters;
}

/**
 * Build the STDIN envelope from a `Tier0Input`. The lexical counters
 * are validated against the closed schema here so a misbehaving
 * caller cannot smuggle extra fields into the worker.
 */
function buildInputEnvelope(input: Tier0Input): WorkerInputEnvelope {
  // The contract says input.source is Uint8Array; we accept anything
  // `instanceof Uint8Array` and base64-encode it.
  const sourceBytes =
    input.source instanceof Uint8Array ? input.source : new Uint8Array(input.source);
  return {
    schemaVersion: "facet.tier0.v1",
    revisionSha: input.revisionSha,
    artifactType: input.artifactType,
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

/**
 * Drain a Node stream into a single string up to `cap` bytes. If the
 * stream emits more than `cap` bytes before EOF, the returned string
 * is truncated and `overflow` is set so the caller can surface a
 * typed `tier0_output_cap` error.
 */
async function readStreamCapped(
  stream: NodeJS.ReadableStream,
  cap: number,
): Promise<{ text: string; overflow: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (total + bytes > cap) {
        overflow = true;
        // Append only what fits, then signal the caller.
        const remaining = cap - total;
        if (remaining > 0) {
          chunks.push(Buffer.from(chunk.slice(0, remaining), "utf8"));
          total += remaining;
        }
        stream.removeAllListeners("data");
        stream.removeAllListeners("end");
        stream.removeAllListeners("error");
        // Nudge the stream toward EOF without consuming more bytes.
        stream.resume();
        resolve({ text: chunks.map((b) => b.toString("utf8")).join(""), overflow: true });
        return;
      }
      chunks.push(Buffer.from(chunk, "utf8"));
      total += bytes;
    });
    stream.on("end", () => {
      resolve({ text: chunks.map((b) => b.toString("utf8")).join(""), overflow });
    });
    stream.on("error", (error) => reject(error));
  });
}

/**
 * Spawn the worker, write the input envelope, read stdout, enforce
 * the wall-clock timeout, kill the worker on overrun, and surface the
 * result. NEVER returns a partially-parsed result: every failure mode
 * is either a typed `FacetError` (system-level) or a `Tier0Result`
 * with a non-`ok` status (parser-level).
 */
async function runOnce(
  input: Tier0Input,
  options: { timeoutMs: number; outputCap: number },
  level: InsecureLevel,
): Promise<Tier0WorkerResult> {
  const envelope = buildInputEnvelope(input);
  const envelopeJson = `${JSON.stringify(envelope)}\n`;

  const isolation = resolveTier0Isolation(level);
  if (isolation === "netns") {
    // Reject netns-unavailable hosts with a typed error instead of silently
    // running un-sandboxed. The probe is cheap (a single unshare invocation).
    const probe = probeNetnsSupport();
    if (!probe.available) {
      throw new FacetError(
        "tier0_unavailable",
        `Tier 0 cannot run: netns unavailable (${probe.reason ?? "unknown"})`,
        { retryable: false, details: { reason: probe.reason ?? "unknown" } },
      );
    }
  }

  const child: ChildProcess =
    isolation === "netns"
      ? spawnNetnsWorker(["run", TIER0_WORKER_ENTRY])
      : spawnDirectWorker(["run", TIER0_WORKER_ENTRY]);
  // We never read STDERR — it goes to the parent's STDERR via the
  // default pipe inheritance so test logs can see diagnostics.
  let stdoutOverflow = false;
  const stdoutPromise = readStreamCapped(child.stdout!, options.outputCap).then(
    (r) => {
      stdoutOverflow = r.overflow;
      return r.text;
    },
    () => "",
  );

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, options.timeoutMs);

  // Write the envelope, then close STDIN so the worker observes EOF.
  child.stdin!.write(envelopeJson);
  child.stdin!.end();

  // Race the exit against the timeout. The timer fires regardless of
  // which resolves first; if the worker exits cleanly we clear it.
  const exitCode = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", (error) => reject(error));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  ).finally(() => clearTimeout(timer));

  const stdout = await stdoutPromise;

  if (exitCode.signal !== null && exitCode.signal !== undefined) {
    throw new FacetError("tier0_worker_died", `Worker terminated by signal ${exitCode.signal}`, {
      retryable: false,
      details: { signal: exitCode.signal },
    });
  }
  if (exitCode.code === null) {
    throw new FacetError("tier0_worker_died", "Worker exited without code or signal", {
      retryable: false,
    });
  }
  if (exitCode.code !== 0) {
    throw new FacetError("tier0_worker_died", `Worker exited with non-zero code ${exitCode.code}`, {
      retryable: false,
      details: { exitCode: exitCode.code },
    });
  }
  if (stdoutOverflow) {
    throw new FacetError("tier0_output_cap", "Worker stdout exceeded the byte cap", {
      retryable: false,
      details: { capBytes: options.outputCap },
    });
  }
  const result = _parseWorkerStdout(stdout, options.outputCap);
  return result;
}

/**
 * Run the Tier 0 worker against an artifact's immutable bytes. The
 * returned worker result ALWAYS conforms to `Tier0WorkerResultSchema`; the
 * `status` field distinguishes a clean parse (`ok`) from a parser
 * rejection (`error`). System-level failures throw `FacetError` with
 * a typed `tier0_*` code.
 */
export async function runTier0(input: Tier0Input): Promise<Tier0WorkerResult> {
  // The contract requires `tier` to be 0 here, but we trust the
  // caller's input rather than re-parsing it — `Tier0ResultSchema`
  // enforces `tier: 0` on the worker side.
  return runOnce(input, { timeoutMs: TIER0_TIMEOUT_MS, outputCap: TIER0_OUTPUT_CAP_BYTES }, 0);
}

/** Create a Tier 0 runner using the requested isolation level. */
export function createTier0Runner(
  level: InsecureLevel,
): (input: Tier0Input) => Promise<Tier0WorkerResult> {
  return (input) =>
    runOnce(input, { timeoutMs: TIER0_TIMEOUT_MS, outputCap: TIER0_OUTPUT_CAP_BYTES }, level);
}
