import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

const INTERACTIVE_MOUNT_ENTRY = [
  'import { createElement } from "react";',
  'import { createRoot } from "react-dom/client";',
  'import Artifact from "./artifact";',
  'const mount = document.getElementById("facet-tsx-mount");',
  'if (mount === null) throw new Error("interactive TSX mount is missing");',
  "createRoot(mount).render(createElement(Artifact));",
].join("\n");

function canonicalizeBundleBytes(rawBytes: Uint8Array): Uint8Array {
  const source = new TextDecoder().decode(rawBytes);
  // Per-call mkdtemp workspaces below vary the entrypoint path. Strip Bun's
  // path-bearing labels before hashing or storing so that isolation preserves
  // deterministic bytes. Re-run tests/unit/tsx-compiler.test.ts (cross-checkout
  // identity) and tests/acceptance/tsx-measurement.test.ts (same-worker ×20,
  // restart ×3) when either mechanism changes.
  const canonical = source.replace(
    /^\/\/ (?:(?:[A-Za-z]:)?[./~][^\r\n]*|[^\r\n]*node_modules\/[^\r\n]*)\.(?:[cm]?[jt]sx?|json)\r?\n/gm,
    "",
  );
  return new TextEncoder().encode(canonical);
}

function typedCompileError(
  message: string,
  details: Record<string, string | number | boolean | null>,
): FacetError {
  return new FacetError("tsx_compile_error", message, { retryable: false, details });
}

export async function compileTsx(input: CompileTsxInput): Promise<CompileTsxResult> {
  return compileTsxAtWorkRoot(input, WORK_ROOT);
}

export async function compileTsxAtWorkRootForTests(
  input: CompileTsxInput,
  workRoot: string,
): Promise<CompileTsxResult> {
  return compileTsxAtWorkRoot(input, workRoot);
}

async function compileTsxAtWorkRoot(
  input: CompileTsxInput,
  workRoot: string,
): Promise<CompileTsxResult> {
  const astErrors = validateTsxAst(input.source);
  if (astErrors.length > 0) {
    throw new FacetError("tsx_ast_denied", "TSX source violates the capability policy", {
      retryable: false,
      details: { errorsJson: JSON.stringify(astErrors) },
    });
  }

  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  // Each compile needs a private entry/output directory so concurrent builds
  // cannot substitute one artifact's output for another. That directory makes
  // paths vary; canonicalizeBundleBytes removes Bun's labels before hashing and
  // storage. Re-run tests/unit/tsx-compiler.test.ts (cross-checkout identity)
  // and tests/acceptance/tsx-measurement.test.ts (same-worker ×20, restart ×3)
  // when either mechanism changes.
  const compileRoot = mkdtempSync(join(workRoot, "compile-"));
  try {
    chmodSync(compileRoot, 0o700);
    const artifactEntry = join(compileRoot, "artifact.tsx");
    const interactiveEntry = join(compileRoot, "interactive-entry.tsx");
    const outDir = join(compileRoot, "out");
    const output = join(outDir, "artifact.js");
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    await Bun.write(artifactEntry, input.source);
    if (input.execution === "interactive")
      await Bun.write(interactiveEntry, INTERACTIVE_MOUNT_ENTRY);
    const result = await Bun.build({
      entrypoints: [resolve(input.execution === "interactive" ? interactiveEntry : artifactEntry)],
      outdir: resolve(outDir),
      target: "browser",
      format: "esm",
      define: { "process.env.NODE_ENV": '"production"' },
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
    const bytes = canonicalizeBundleBytes(new Uint8Array(await result.outputs[0]!.arrayBuffer()));
    await Bun.write(output, bytes);
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

    const moduleUrl = `${Bun.pathToFileURL(output).href}?sha=${bundleSha256}`;
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
  } finally {
    rmSync(compileRoot, { recursive: true, force: true });
  }
}
