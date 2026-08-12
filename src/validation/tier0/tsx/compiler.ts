import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { FacetError } from "../../../shared/errors/facet-error";
import type { TsxExecutionMode } from "../../../shared/contracts/validation";
import { tsxAllowlistResolverPlugin } from "./allowlist-resolver";
import { validateTsxAst } from "./ast-policy";

export const TSX_COMPILED_OUTPUT_CAP_BYTES = 2 * 1024 * 1024;

export interface CompileTsxInput {
  readonly source: string;
  readonly execution: TsxExecutionMode;
}

export interface CompileTsxResult {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mediaType: "text/html" | "text/javascript";
  readonly html?: string;
}

const WORK_ROOT = join(resolve(import.meta.dir, "../../../.."), ".facet-tsx-worker");
const ENTRY = join(WORK_ROOT, "artifact.tsx");
const OUT_DIR = join(WORK_ROOT, "out");
const OUTPUT = join(OUT_DIR, "artifact.js");

function typedCompileError(
  message: string,
  details: Record<string, string | number | boolean | null>,
): FacetError {
  return new FacetError("tsx_compile_error", message, { retryable: false, details });
}

export async function compileTsx(input: CompileTsxInput): Promise<CompileTsxResult> {
  const astErrors = validateTsxAst(input.source);
  if (astErrors.length > 0) {
    throw new FacetError("tsx_ast_denied", "TSX source violates the capability policy", {
      retryable: false,
      details: { errorsJson: JSON.stringify(astErrors) },
    });
  }

  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  await Bun.write(ENTRY, input.source);
  rmSync(OUTPUT, { force: true });
  const result = await Bun.build({
    entrypoints: [resolve(ENTRY)],
    outdir: resolve(OUT_DIR),
    target: "browser",
    format: "esm",
    minify: false,
    splitting: false,
    sourcemap: "none",
    naming: "artifact.js",
    plugins: [tsxAllowlistResolverPlugin()],
    throw: false,
  });
  if (!result.success || result.outputs.length === 0) {
    throw typedCompileError("TSX compiler failed", {
      diagnostics: JSON.stringify(result.logs),
      outputCount: result.outputs.length,
    });
  }
  const bytes = new Uint8Array(await result.outputs[0]!.arrayBuffer());
  if (bytes.byteLength > TSX_COMPILED_OUTPUT_CAP_BYTES) {
    throw new FacetError("tsx_compile_output_cap", "TSX compiler output exceeded the byte cap", {
      retryable: false,
      details: { capBytes: TSX_COMPILED_OUTPUT_CAP_BYTES, sizeBytes: bytes.byteLength },
    });
  }
  const bundleSha256 = createHash("sha256").update(bytes).digest("hex");
  if (input.execution === "interactive") {
    return { bytes, sha256: bundleSha256, mediaType: "text/javascript" };
  }

  try {
    const moduleUrl = `${Bun.pathToFileURL(OUTPUT).href}?sha=${bundleSha256}`;
    const module = (await import(moduleUrl)) as { default?: unknown };
    const renderToStaticMarkup = (await import("react-dom/server")).renderToStaticMarkup;
    if (typeof module.default !== "function") {
      throw new Error("compiled TSX module has no default component export");
    }
    const html = renderToStaticMarkup(module.default({}));
    const htmlBytes = new TextEncoder().encode(html);
    if (htmlBytes.byteLength > TSX_COMPILED_OUTPUT_CAP_BYTES) {
      throw new FacetError("tsx_compile_output_cap", "TSX HTML output exceeded the byte cap", {
        retryable: false,
        details: { capBytes: TSX_COMPILED_OUTPUT_CAP_BYTES, sizeBytes: htmlBytes.byteLength },
      });
    }
    return {
      bytes: htmlBytes,
      sha256: createHash("sha256").update(htmlBytes).digest("hex"),
      mediaType: "text/html",
      html,
    };
  } catch (error) {
    if (error instanceof FacetError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw typedCompileError("TSX static rendering failed", { message });
  }
}
