import { FROZEN_CSP_TEMPLATE } from "../../../shared/security/frozen-csp";
import type { TsxExecutionMode } from "../../../shared/tsx/execution";
import { renderHtml } from "./html";
import { FacetRenderError, decodeArtifactBytes, type RenderContext } from "./registry";

function escapeScriptText(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

export function buildInteractiveTsxSrcdoc(compiledBytes: Uint8Array, nonce: string): string {
  const csp = FROZEN_CSP_TEMPLATE.replace("<BOOTSTRAP_NONCE>", nonce);
  const compiled = escapeScriptText(decodeArtifactBytes(compiledBytes));
  return (
    "<!doctype html><html><head>" +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    "</head><body>" +
    '<main id="facet-tsx-mount"></main>' +
    `<script type="module" nonce="${nonce}">${compiled}</script>` +
    "</body></html>"
  );
}

export async function renderTsx(
  ctx: RenderContext,
  bytes: Uint8Array,
  renderer: "svg" | "canvas",
  execution: TsxExecutionMode = "static",
): Promise<void> {
  void renderer;
  if (execution === "static") {
    await renderHtml(ctx, bytes);
    return;
  }
  if (ctx.nonce === undefined) {
    throw new FacetRenderError(
      "TSX interactive rendering requires a frame nonce",
      "invalid_request",
    );
  }
  const iframe = ctx.container.ownerDocument.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("allow", "");
  iframe.srcdoc = buildInteractiveTsxSrcdoc(bytes, ctx.nonce);
  ctx.container.replaceChildren(iframe);
}
