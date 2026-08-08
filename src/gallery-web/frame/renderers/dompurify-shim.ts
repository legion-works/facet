/**
 * DOMPurify shim for bundled frame contexts.
 *
 * DOMPurify captures `document` methods at instance-construction time
 * (`createNodeIterator`, `createTreeWalker`, `getElementsByTagName`,
 * `importNode`, `createDocumentFragment`) and calls them with `this`
 * detached from the document. Standalone this survives; inside the
 * mermaid/d3/katex frame bundle the detached calls surface as
 * `TypeError: Illegal invocation` on the first HTML-label sanitize
 * (plain-text labels skip the NodeIterator path).
 *
 * Fix: DOMPurify's factory form builds a fresh instance against an
 * explicit window, and the frame's document carries the captured
 * methods as OWN properties pre-bound to the real document — the own
 * property wins over the prototype at capture time, so every detached
 * `.call(...)` lands on the right `this`. DOMPurify also reassigns its
 * internal document to `template.content.ownerDocument` (a DIFFERENT
 * Document object) when HTMLTemplateElement exists, so that document
 * gets the bound methods too. The import-time default instance is
 * never trusted in a srcdoc bundle.
 */

import purifyFactory from "dompurify";

type PurifyInstance = typeof purifyFactory & { isSupported?: boolean };

/** Document methods DOMPurify captures and calls unbound. */
const DOCUMENT_METHODS = [
  "createNodeIterator",
  "createTreeWalker",
  "getElementsByTagName",
  "getElementsByTagNameNS",
  "importNode",
  "createDocumentFragment",
] as const;

/**
 * Shadow DOMPurify's captured methods with pre-bound OWN properties on
 * the given document. Behavior is identical for all other callers — a
 * bound copy of the same method.
 */
function bindDocumentMethods(realDocument: Document): void {
  for (const name of DOCUMENT_METHODS) {
    const existing = Object.getOwnPropertyDescriptor(realDocument, name);
    if (existing !== undefined) continue;
    const method = (realDocument as unknown as Record<string, unknown>)[name];
    if (typeof method === "function") {
      Object.defineProperty(realDocument, name, {
        value: (method as (...args: unknown[]) => unknown).bind(realDocument),
        configurable: true,
        writable: true,
      });
    }
  }
}

function ensureBoundDocumentMethods(realWindow: Window & typeof globalThis): boolean {
  const realDocument = realWindow.document;
  if (realDocument === undefined) return false;
  bindDocumentMethods(realDocument);
  // DOMPurify REASSIGNS its internal document to
  // `template.content.ownerDocument` when HTMLTemplateElement exists —
  // a DIFFERENT Document object (the template's inert document). That
  // one must carry the bound methods too, or the HTML-label path
  // still hits the unbound capture.
  try {
    const probeTemplate = realDocument.createElement("template");
    const contentDoc = probeTemplate.content?.ownerDocument;
    if (contentDoc !== undefined && contentDoc !== null && contentDoc !== realDocument) {
      bindDocumentMethods(contentDoc);
    }
  } catch {
    // template probing is best-effort; the main document patch stands
  }
  return true;
}

let bound: PurifyInstance | null = null;

function resolveBound(): PurifyInstance {
  if (bound !== null) return bound;
  const w = globalThis.window as (Window & typeof globalThis) | undefined;
  if (w !== undefined) ensureBoundDocumentMethods(w);
  const candidate = purifyFactory(w) as PurifyInstance;
  // A supported instance carries `sanitize`; an unsupported factory
  // shell does not — fall back to the import-time default rather than
  // break the render path.
  bound = typeof candidate.sanitize === "function" ? candidate : purifyFactory;
  return bound;
}

const shim = new Proxy({} as PurifyInstance, {
  get(_target, prop, receiver) {
    const instance = resolveBound();
    const value = Reflect.get(instance, prop, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export default shim;
