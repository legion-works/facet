import type { Tier0WorkerResult } from "../../shared/contracts/validation";
import { parseChart } from "./chart";
import { parseHtml } from "./html";
import { parseMarkdown } from "./markdown";
import { parseMermaid } from "./mermaid";
import { parseSvg } from "./svg";
import { compileTsx } from "./tsx/compiler";
import type { WorkerInput } from "./worker-input";

export async function runParser(input: WorkerInput): Promise<Tier0WorkerResult> {
  const base = {
    revisionSha: input.revisionSha,
    expected: input.lexical,
    tier: 0 as const,
  };
  switch (input.artifactType) {
    case "markdown": {
      const result = parseMarkdown(input.source);
      const externalImageCount = result.observed.externalImageCount;
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
  return [{ code, message: error instanceof Error ? error.message : String(error) }];
}
