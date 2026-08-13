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
import type { TsxExecutionMode } from "../../shared/contracts/validation";
import { TIER0_INPUT_CAP_BYTES } from "../sandbox/limits";

import { parseMermaid } from "./mermaid";
import { parseMarkdown } from "./markdown";
import { parseSvg } from "./svg";
import { parseChart } from "./chart";
import { parseHtml } from "./html";
import { compileTsx } from "./tsx/compiler";

/**
 * Worker wire shape — the exact JSON object the parent writes to the
 * worker's STDIN. Re-declared here (not imported from `protocol.ts`)
 * because the worker lives in a separate process and should not pull
 * in any module that the boundary check disallows in `src/service`.
 * `schemaVersion` is the protocol discriminator; the parent uses it to
 * reject mismatched workers.
 */
export interface WorkerInput {
  readonly schemaVersion: "facet.tier0.v2";
  readonly requestId: string;
  readonly revisionSha: string;
  readonly artifactType: ArtifactType;
  readonly renderer: Renderer;
  readonly source: Uint8Array;
  readonly lexical: LexicalCounters;
  readonly execution?: TsxExecutionMode;
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
  readonly execution?: unknown;
}

function parseWorkerInput(text: string): WorkerInput {
  const raw = JSON.parse(text) as WorkerInputJson;
  if (raw.schemaVersion !== "facet.tier0.v2") {
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
    (typeof lexical.mermaidNodeCount !== "number" && lexical.mermaidNodeCount !== null) ||
    typeof lexical.visibleSvgCount !== "number"
  ) {
    throw new Error("invalid lexical counters");
  }
  const source = Uint8Array.from(Buffer.from(raw.sourceBase64, "base64"));
  const execution =
    raw.execution === "static" || raw.execution === "interactive" ? raw.execution : undefined;
  if (raw.artifactType === "tsx" && execution !== "static" && execution !== "interactive") {
    throw new Error("TSX input requires execution mode");
  }
  if (raw.artifactType !== "tsx" && raw.execution !== undefined) {
    throw new Error("execution is only valid for TSX input");
  }
  return {
    schemaVersion: "facet.tier0.v2",
    requestId: raw.requestId,
    revisionSha: raw.revisionSha,
    artifactType: raw.artifactType as ArtifactType,
    renderer: raw.renderer,
    source,
    lexical,
    ...(execution === undefined ? {} : { execution }),
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
    case "tsx": {
      if (input.execution === undefined) throw new Error("TSX execution mode missing");
      try {
        const compiled = await compileTsx({
          source: new TextDecoder("utf-8", { fatal: true }).decode(input.source),
          execution: input.execution,
        });
        const encoded = Buffer.from(compiled.bytes).toString("base64");
        const common = {
          ...base,
          status: "ok" as const,
          execution: input.execution,
          compiled: {
            mediaType: compiled.mediaType,
            bytesBase64: encoded,
            sha256: compiled.sha256,
          },
        };
        if (input.execution === "interactive") {
          return {
            ...common,
            expected: { ...base.expected },
            observed: {
              rendererRootSvgCount: 0,
              graphCount: 0,
              mermaidNodeCount: 0,
              visibleSvgCount: 0,
              opaqueRegionCount: 0,
              externalImageCount: 0,
              errorCount: 0,
            },
          };
        }
        if (compiled.html === undefined) throw new Error("static TSX compiler omitted HTML");
        const parsed = parseHtml(new TextEncoder().encode(compiled.html));
        return {
          ...common,
          status: parsed.status,
          expected: {
            ...base.expected,
            rendererRootSvgCount: 0,
            mermaidNodeCount: 0,
            opaqueRegionCount: parsed.html.canvasCount,
            html: parsed.html,
            externalImageCount: parsed.html.externalImageCount,
          },
          observed: {
            rendererRootSvgCount: 0,
            graphCount: 0,
            mermaidNodeCount: 0,
            visibleSvgCount: 0,
            opaqueRegionCount: parsed.html.canvasCount,
            externalImageCount: parsed.html.externalImageCount,
            html: parsed.html,
            errorCount: parsed.status === "error" ? parsed.errors.length : 0,
            ...(parsed.status === "error" ? { discriminativeErrors: [...parsed.errors] } : {}),
          },
        };
      } catch (error) {
        const facet = error instanceof Error && "code" in error ? error : null;
        const code =
          facet !== null && typeof facet.code === "string" ? facet.code : "tsx_compile_error";
        if (
          code === "tsx_ast_denied" ||
          code === "tsx_compile_error" ||
          code === "tsx_compile_output_cap"
        ) {
          const details =
            facet !== null && "options" in facet
              ? (facet.options as { details?: Record<string, unknown> }).details
              : undefined;
          const errors = tsxDiscriminativeErrors(code, error, details);
          return {
            ...base,
            status: "error",
            execution: input.execution,
            observed: {
              rendererRootSvgCount: 0,
              graphCount: 0,
              mermaidNodeCount: 0,
              visibleSvgCount: 0,
              opaqueRegionCount: 0,
              externalImageCount: 0,
              errorCount: errors.length,
              discriminativeErrors: errors,
            },
          };
        }
        throw error;
      }
    }
    default: {
      const exhaustive: never = input.artifactType;
      void exhaustive;
      throw new Error(`Unsupported artifact type for tier 0: ${String(input.artifactType)}`);
    }
  }
}

function tsxDiscriminativeErrors(
  code: string,
  error: unknown,
  details: Record<string, unknown> | undefined,
): Array<{ code: string; message: string; location?: string }> {
  if (code === "tsx_ast_denied" && typeof details?.errorsJson === "string") {
    return JSON.parse(details.errorsJson) as Array<{ code: string; message: string }>;
  }
  if (typeof details?.diagnostics === "string") {
    const diagnostics = JSON.parse(details.diagnostics) as Array<{
      message?: string;
      position?: { line?: number; column?: number };
    }>;
    return diagnostics.map((diagnostic) => ({
      code,
      message: diagnostic.message ?? String(error),
      ...(diagnostic.position?.line === undefined
        ? {}
        : {
            location: `line ${diagnostic.position.line + 1}:${(diagnostic.position.column ?? 0) + 1}`,
          }),
    }));
  }
  if (typeof details?.message === "string") return [{ code, message: details.message }];
  return [
    {
      code,
      message: error instanceof Error ? error.message : String(error),
    },
  ];
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
