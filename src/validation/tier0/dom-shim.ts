/**
 * linkedom-based DOM shim for the Tier 0 worker.
 *
 * Mermaid needs a minimal DOM for import and parsing in the worker.
 * Tier 0 does not render labels; their sanitization is a render concern
 * verified by Tier 1.
 *
 * This module installs the shim at IMPORT TIME (top-level) so any
 * subsequent `import "mermaid"` sees a DOM. It is structural only —
 * it never executes any artifact source. The worker's netns prevents
 * any library-initiated network egress.
 */

import { parseHTML } from "linkedom";

let installed = false;
export let domShimDocument: Document;

function installDomShim(): void {
  if (installed) return;
  installed = true;
  const { document, window } = parseHTML("<!DOCTYPE html><html><body></body></html>");
  domShimDocument = document as unknown as Document;
  const g = globalThis as unknown as Record<string, unknown>;
  g["document"] = document;
  g["window"] = window;
  g["Element"] = window.Element;
  g["HTMLElement"] = window.HTMLElement;
  g["Node"] = window.Node;
  g["DocumentFragment"] = window.DocumentFragment;
  g["HTMLTemplateElement"] = window.HTMLTemplateElement;
}

// Top-level install — runs synchronously when this module is first
// imported. Any module that subsequently imports `mermaid` (which has
// import-time DOM checks) sees the structural DOM in place.
installDomShim();

export const domShimInstalled = true;
