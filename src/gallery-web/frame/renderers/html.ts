import { decodeArtifactBytes, type RenderContext } from "./registry";
import {
  isAllowedHtmlUrl,
  isHtmlDeniedElement,
  isHtmlEventHandlerAttribute,
  isHtmlInlineStyleAttribute,
  isHtmlUrlAttributeName,
  isHtmlUrlBearingAttribute,
} from "../../../shared/html/policy";

function shouldKeepAttribute(elementName: string, name: string, value: string): boolean {
  if (isHtmlEventHandlerAttribute(name) || isHtmlInlineStyleAttribute(name)) return false;
  if (isHtmlUrlBearingAttribute(elementName, name))
    return isAllowedHtmlUrl(elementName, name, value);
  return !isHtmlUrlAttributeName(name);
}

function sanitizeParsedHtml(root: HTMLElement): void {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    const tagName = element.localName.toLowerCase();
    if (isHtmlDeniedElement(tagName)) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      if (!shouldKeepAttribute(tagName, attribute.name.toLowerCase(), attribute.value))
        element.removeAttribute(attribute.name);
    }
  }
}

export function createHtmlRendererRoot(ownerDocument: Document): HTMLElement {
  const root = ownerDocument.createElement("div");
  root.setAttribute("data-facet-renderer-root", "true");
  root.className = "facet-html-root";
  return root;
}

export async function renderHtml(ctx: RenderContext, bytes: Uint8Array): Promise<void> {
  const ownerDocument = ctx.container.ownerDocument;
  const root = createHtmlRendererRoot(ownerDocument);
  const parsed = new DOMParser().parseFromString(decodeArtifactBytes(bytes), "text/html");
  const parsedBody = parsed.body;
  sanitizeParsedHtml(parsedBody);
  for (const child of Array.from(parsedBody.childNodes))
    root.appendChild(ownerDocument.adoptNode(child));
  ctx.container.replaceChildren(root);
}
