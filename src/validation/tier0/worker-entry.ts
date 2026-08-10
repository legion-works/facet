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

import { ARTIFACT_TYPES, type ArtifactType } from "../../shared/contracts/artifact-types";
import type { Renderer } from "../../shared/contracts/artifact";
import type { LexicalCounters, Tier0WorkerResult } from "../../shared/contracts/validation";
import { TIER0_INPUT_CAP_BYTES } from "../sandbox/limits";

import { parseMermaid } from "./mermaid";
import { parseMarkdown } from "./markdown";
import { parseSvg } from "./svg";
import { parseChart } from "./chart";
import { parseHtml } from "./html";

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
  readonly requestId: string;
  readonly revisionSha: string;
  readonly artifactType: ArtifactType;
  readonly renderer: Renderer;
  readonly source: Uint8Array;
  readonly lexical: LexicalCounters;
}

/**
 * Decode the worker input envelope. The protocol is intentionally
 * narrow — a JSON object with `schemaVersion`, `revisionSha`,
 * `artifactType`, `source` (Uint8Array — but JSON cannot carry
 * binary, so the parent sends a base64 string), and `lexical`.
 */
interface WorkerInputJson {
  readonly schemaVersion?: unknown;
  readonly requestId?: unknown;
  readonly revisionSha?: unknown;
  readonly artifactType?: unknown;
  readonly renderer?: unknown;
  readonly sourceBase64?: unknown;
  readonly lexical?: unknown;
}

function parseWorkerInput(text: string): WorkerInput {
  const raw = JSON.parse(text) as WorkerInputJson;
  if (raw.schemaVersion !== "facet.tier0.v1") {
    throw new Error(`unknown schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (typeof raw.requestId !== "string" || raw.requestId.length === 0) {
    throw new Error("invalid requestId");
  }
  if (typeof raw.revisionSha !== "string" || !/^[a-f0-9]{64}$/.test(raw.revisionSha)) {
    throw new Error("invalid revisionSha");
  }
  if (
    typeof raw.artifactType !== "string" ||
    !ARTIFACT_TYPES.includes(raw.artifactType as ArtifactType)
  ) {
    throw new Error(`invalid artifactType: ${String(raw.artifactType)}`);
  }
  if (raw.renderer !== "svg" && raw.renderer !== "canvas") {
    throw new Error(`invalid renderer: ${String(raw.renderer)}`);
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
    requestId: raw.requestId,
    revisionSha: raw.revisionSha,
    artifactType: raw.artifactType as ArtifactType,
    renderer: raw.renderer,
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
      // Propagate the markdown-side external-image count up to the
      // lexical expectation so the verdict's expected/observed match
      // compares two top-level counters. The dispatcher is byte-dumb
      // and cannot compute this itself.
      const externalImageCount =
        result.status === "ok" || result.status === "error"
          ? result.observed.externalImageCount
          : 0;
      return {
        ...base,
        expected: { ...input.lexical, externalImageCount },
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
    case "html": {
      const result = parseHtml(input.source);
      const html = result.html;
      // The HTML artifact's external-image count lives inside `html`
      // (Tier 1 protocol probes populate it from real DOM observation);
      // mirror it up to the top level so the verdict reads the
      // type-agnostic counter rather than the HTML-shaped subfield.
      return {
        ...base,
        status: result.status,
        expected: { ...input.lexical, externalImageCount: html.externalImageCount, html },
        observed: {
          rendererRootSvgCount: 0,
          graphCount: 0,
          mermaidNodeCount: 0,
          visibleSvgCount: 0,
          opaqueRegionCount: html.canvasCount,
          externalImageCount: html.externalImageCount,
          html,
          errorCount: result.status === "error" ? result.errors.length : 0,
          ...(result.status === "error" ? { discriminativeErrors: [...result.errors] } : {}),
        },
      };
    }
  }
}

async function main(): Promise<number> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    buffered += decoder.decode(value, { stream: true });
    if (Buffer.byteLength(buffered, "utf8") > TIER0_INPUT_CAP_BYTES) {
      process.stderr.write("tier0.worker.input_error request line exceeds byte cap\n");
      return 2;
    }
    let lineEnd = buffered.indexOf("\n");
    while (lineEnd >= 0) {
      const line = buffered.slice(0, lineEnd);
      buffered = buffered.slice(lineEnd + 1);
      lineEnd = buffered.indexOf("\n");
      if (Buffer.byteLength(line, "utf8") > TIER0_INPUT_CAP_BYTES) {
        process.stderr.write("tier0.worker.input_error request line exceeds byte cap\n");
        return 2;
      }
      let input: WorkerInput;
      try {
        input = parseWorkerInput(line);
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
      process.stdout.write(`${JSON.stringify({ requestId: input.requestId, result })}\n`);
    }
  }
  if (buffered.length > 0) {
    process.stderr.write("tier0.worker.input_error incomplete request line\n");
    return 2;
  }
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
