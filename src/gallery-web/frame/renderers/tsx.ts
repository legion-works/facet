import type { TsxExecutionMode } from "../../../shared/tsx/execution";
import type { Renderer } from "../../../shared/contracts/renderers";
import { renderHtml } from "./html";
import { appendRenderError, RENDER_ERROR_ATTRIBUTE, type RenderContext } from "./registry";

export interface TsxModuleRuntime {
  readonly createObjectURL: (blob: Blob) => string;
  readonly importModule: (url: string) => Promise<unknown>;
  readonly revokeObjectURL: (url: string) => void;
}

const browserTsxModuleRuntime: TsxModuleRuntime = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  importModule: async (url) => import(url),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

let tsxModuleRuntime = browserTsxModuleRuntime;

/** Test-only injection avoids relying on the host runtime's blob-module loader. */
export function setTsxModuleRuntimeForTests(runtime: TsxModuleRuntime | undefined): void {
  tsxModuleRuntime = runtime ?? browserTsxModuleRuntime;
}

function appendRuntimeError(container: HTMLElement, event: unknown): void {
  if (container.querySelector(`[${RENDER_ERROR_ATTRIBUTE}="true"]`) !== null) return;
  // This marker is diagnostics only; CDP Runtime.exceptionThrown remains the verifier authority.
  appendRenderError(container, event);
}

export async function renderTsx(
  ctx: RenderContext,
  bytes: Uint8Array,
  renderer: Renderer,
  execution: TsxExecutionMode = "static",
): Promise<void> {
  void renderer;
  if (execution === "static") {
    await renderHtml(ctx, bytes);
    return;
  }
  const root = ctx.container.ownerDocument.createElement("main");
  root.id = "facet-tsx-mount";
  root.setAttribute("data-facet-renderer-root", "true");
  ctx.container.replaceChildren(root);
  const frameWindow = ctx.container.ownerDocument.defaultView;
  const report = (event: Event): void => appendRuntimeError(ctx.container, event);
  frameWindow?.addEventListener("error", report, true);
  frameWindow?.addEventListener("unhandledrejection", report, true);
  const moduleUrl = tsxModuleRuntime.createObjectURL(
    new Blob([bytes], { type: "text/javascript" }),
  );
  try {
    await tsxModuleRuntime.importModule(moduleUrl);
  } catch (error) {
    appendRuntimeError(ctx.container, error);
    throw error;
  } finally {
    tsxModuleRuntime.revokeObjectURL(moduleUrl);
  }
}
