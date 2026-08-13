import { FROZEN_CSP_TEMPLATE } from "../../../shared/security/frozen-csp";
import { TSX_ARTIFACT_FRAME_ATTRIBUTE, type TsxExecutionMode } from "../../../shared/tsx/execution";
import type { Renderer } from "../../../shared/contracts/renderers";
import { renderHtml } from "./html";
import {
  FacetRenderError,
  decodeArtifactBytes,
  RENDER_ERROR_ATTRIBUTE,
  RENDER_ERROR_ELEMENT,
  type RenderContext,
} from "./registry";

function escapeScriptText(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function nestedRuntimeErrorHandler(nonce: string): string {
  const attribute = JSON.stringify(RENDER_ERROR_ATTRIBUTE);
  const element = JSON.stringify(RENDER_ERROR_ELEMENT);
  return (
    `<script nonce="${nonce}">(function(){` +
    `var report=function(event){var error=event&&('reason'in event?event.reason:event.error);` +
    `var message=error&&error.message?error.message:event&&event.message?event.message:'interactive TSX runtime error';` +
    `if(document.querySelector('['+${attribute}+'="true"]'))return;` +
    `var marker=document.createElement(${element});marker.setAttribute(${attribute},'true');` +
    `marker.textContent=String(message);document.body.appendChild(marker);};` +
    `window.addEventListener('error',report,true);window.addEventListener('unhandledrejection',report,true);})();</script>`
  );
}

export function buildInteractiveTsxSrcdoc(compiledBytes: Uint8Array, nonce: string): string {
  const csp = FROZEN_CSP_TEMPLATE.replace("<BOOTSTRAP_NONCE>", nonce);
  const compiled = escapeScriptText(decodeArtifactBytes(compiledBytes));
  return (
    "<!doctype html><html><head>" +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    "</head><body>" +
    '<main id="facet-tsx-mount" data-facet-renderer-root="true"></main>' +
    // Frame-owned marker is visible diagnostics only; Tier 1 trusts CDP runtime exceptions.
    nestedRuntimeErrorHandler(nonce) +
    `<script type="module" nonce="${nonce}">${compiled}</script>` +
    "</body></html>"
  );
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
  if (ctx.nonce === undefined) {
    throw new FacetRenderError(
      "TSX interactive rendering requires a frame nonce",
      "invalid_request",
    );
  }
  const iframe = ctx.container.ownerDocument.createElement("iframe");
  iframe.setAttribute(TSX_ARTIFACT_FRAME_ATTRIBUTE, "true");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("allow", "");
  iframe.srcdoc = buildInteractiveTsxSrcdoc(bytes, ctx.nonce);
  ctx.container.replaceChildren(iframe);
}
