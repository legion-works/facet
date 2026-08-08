/**
 * Tier 0 worker subprocess entrypoint.
 *
 * Spawned by `runner.ts` inside a rootless network namespace via
 * `sandbox/netns.ts`. The worker:
 *
 *   1. Reads ONE JSON envelope from STDIN (the Tier0Input wire shape).
 *   2. Dispatches by `artifactType` to the matching parser module.
 *      The parsers are pure-token or pure-compile — none of them touch
 *      a DOM, open a socket, or load a remote resource. The netns is
 *      the second line of defense for any library that does try to.
 *   3. Writes ONE JSON envelope to STDOUT (the identity-blind
 *      Tier0WorkerResult wire shape). STDOUT is capped by the parent; anything
 *      beyond the first JSON object is a typed `tier0_protocol_error`
 *      failure on the parent side.
 *   4. Writes diagnostics to STDERR. STDERR is NEVER parsed by the
 *      parent — it is captured only for debugging.
 *
 * The worker runs in `Bun.spawn` mode (process.argv[1] is the worker
 * entry path); it is invoked by `bun run src/validation/tier0/worker-entry.ts`.
 */

import type { ArtifactType } from "../../shared/contracts/artifact";
import type { LexicalCounters, Tier0WorkerResult } from "../../shared/contracts/validation";

import { parseMermaid } from "./mermaid";
import { parseMarkdown } from "./markdown";
import { parseSvg } from "./svg";
import { parseChart } from "./chart";

/**
 * Worker wire shape — the exact JSON object the parent writes to the
 * worker's STDIN. Re-declared here (not imported from `protocol.ts`)
 * because the worker lives in a separate process and should not pull
 * in any module that the boundary check disallows in `src/service`.
 * `schemaVersion` is the protocol discriminator; the parent uses it to
 * reject mismatched workers.
 */
export interface WorkerInput {
  readonly schemaVersion: "facet.tier0.v1";
  readonly revisionSha: string;
  readonly artifactType: ArtifactType;
  readonly source: Uint8Array;
  readonly lexical: LexicalCounters;
}

/**
 * Read ALL of STDIN as bytes. Bun's `Bun.stdin.stream()` is a
 * Web ReadableStream; for a small bounded payload we accumulate into a
 * single Uint8Array. The parent caps the input via the message length
 * check upstream so this read cannot exhaust memory.
 */
async function readAllStdin(): Promise<Uint8Array> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Decode the worker input envelope. The protocol is intentionally
 * narrow — a JSON object with `schemaVersion`, `revisionSha`,
 * `artifactType`, `source` (Uint8Array — but JSON cannot carry
 * binary, so the parent sends a base64 string), and `lexical`.
 */
interface WorkerInputJson {
  readonly schemaVersion?: unknown;
  readonly revisionSha?: unknown;
  readonly artifactType?: unknown;
  readonly sourceBase64?: unknown;
  readonly lexical?: unknown;
}

function parseWorkerInput(bytes: Uint8Array): WorkerInput {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const raw = JSON.parse(text) as WorkerInputJson;
  if (raw.schemaVersion !== "facet.tier0.v1") {
    throw new Error(`unknown schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (typeof raw.revisionSha !== "string" || !/^[a-f0-9]{64}$/.test(raw.revisionSha)) {
    throw new Error("invalid revisionSha");
  }
  if (
    raw.artifactType !== "markdown" &&
    raw.artifactType !== "mermaid" &&
    raw.artifactType !== "svg" &&
    raw.artifactType !== "chart"
  ) {
    throw new Error(`invalid artifactType: ${String(raw.artifactType)}`);
  }
  if (typeof raw.sourceBase64 !== "string") {
    throw new Error("missing sourceBase64");
  }
  const lexical = raw.lexical as LexicalCounters | undefined;
  if (
    lexical === undefined ||
    typeof lexical.rendererRootSvgCount !== "number" ||
    typeof lexical.mermaidNodeCount !== "number" ||
    typeof lexical.visibleSvgCount !== "number"
  ) {
    throw new Error("invalid lexical counters");
  }
  const source = Uint8Array.from(Buffer.from(raw.sourceBase64, "base64"));
  return {
    schemaVersion: "facet.tier0.v1",
    revisionSha: raw.revisionSha,
    artifactType: raw.artifactType,
    source,
    lexical,
  };
}

/**
 * Dispatch by artifact type. Each branch returns a Tier0Result-shaped
 * value; the caller serializes and writes it to STDOUT. The result
 * always carries `status: "ok"` (the parser succeeded) or
 * `status: "error"` (the parser rejected). Wall-clock / output-cap /
 * protocol violations are NOT observed here — they are enforced by the
 * PARENT runner.
 */
async function runParser(input: WorkerInput): Promise<Tier0WorkerResult> {
  const base = {
    revisionSha: input.revisionSha,
    expected: input.lexical,
    tier: 0 as const,
  };
  switch (input.artifactType) {
    case "markdown": {
      const result = parseMarkdown(input.source);
      return {
        ...base,
        status: result.status === "ok" ? "ok" : "error",
        observed:
          result.status === "error"
            ? { ...result.observed, discriminativeErrors: [...result.errors] }
            : result.observed,
      };
    }
    case "mermaid": {
      const result = await parseMermaid(input.source);
      return {
        ...base,
        status: result.status === "ok" ? "ok" : "error",
        observed:
          result.status === "error"
            ? { ...result.observed, discriminativeErrors: [...result.errors] }
            : result.observed,
      };
    }
    case "svg": {
      const result = parseSvg(input.source);
      if (result.status === "ok") {
        return {
          ...base,
          status: "ok",
          observed: { ...result.observed, viewBoxes: [...result.viewBoxes] },
        };
      }
      return {
        ...base,
        status: "error",
        observed: { ...result.observed, discriminativeErrors: [...result.errors] },
      };
    }
    case "chart": {
      const result = parseChart(input.source);
      return {
        ...base,
        status: result.status === "ok" ? "ok" : "error",
        observed:
          result.status === "error"
            ? { ...result.observed, discriminativeErrors: [...result.errors] }
            : result.observed,
      };
    }
  }
}

async function main(): Promise<number> {
  const stdinBytes = await readAllStdin();
  let input: WorkerInput;
  try {
    input = parseWorkerInput(stdinBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tier0.worker.input_error ${message}\n`);
    return 2;
  }

  let result: Tier0WorkerResult;
  try {
    result = await runParser(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tier0.worker.parser_error ${message}\n`);
    return 3;
  }

  // ONE bounded JSON object to STDOUT. The parent enforces the output
  // cap; we do not newline-delimit or emit anything else.
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`tier0.worker.unhandled ${message}\n`);
      process.exit(1);
    },
  );
}
