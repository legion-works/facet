/**
 * linkedom-based DOM shim for the Tier 0 worker.
 *
 * Mermaid and other browser-shaped libraries perform import-time
 * initialization against `globalThis.document`, `window`, and the
 * `implementation.createHTMLDocument` API. Bun's worker process has
 * none of these by default, so a naive `import mermaid from "mermaid"`
 * throws `DOMPurify.addHook is not a function` (or its equivalent)
 * before the parser ever sees source.
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
  // DOMPurify's isSupported check looks for `implementation.createHTMLDocument`.
  // linkedom ships without an implementation object; we attach a minimal shim
  // that returns a freshly-parsed document. This is structural only —
  // we never serialize against this DOM.
  const fakeImpl = {
    createHTMLDocument: (html: string): Document => {
      const r = parseHTML(html);
      return r.document as unknown as Document;
    },
  };
  Object.defineProperty(document, "implementation", { value: fakeImpl, configurable: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g["document"] = document;
  g["window"] = window;
  g["Element"] = window.Element;
  g["HTMLElement"] = window.HTMLElement;
  g["Node"] = window.Node;
  g["DocumentFragment"] = window.DocumentFragment;
  g["HTMLTemplateElement"] = window.HTMLTemplateElement;
  g["NodeFilter"] = window.NodeFilter;
}

// Top-level install — runs synchronously when this module is first
// imported. Any module that subsequently imports `mermaid` (which has
// import-time DOM checks) sees the structural DOM in place.
installDomShim();

export const domShimInstalled = true;
