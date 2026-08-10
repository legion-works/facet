export const HTML_DENIED_ELEMENTS = [
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "link",
  "meta",
  "base",
  "style",
] as const;

export const HTML_STRUCTURAL_GROUPS = {
  headings: ["h1", "h2", "h3", "h4", "h5", "h6"],
  tables: ["table"],
  lists: ["ul", "ol"],
  images: ["img"],
  canvases: ["canvas"],
} as const;

export const HTML_URL_BEARING_ATTRIBUTES = {
  img: ["src", "srcset"],
  a: ["href"],
} as const;

export const HTML_ALLOWED_ANCHOR_SCHEMES = ["https:", "mailto:"] as const;
export const HTML_ALLOWED_IMAGE_SCHEMES = ["data:", "https:"] as const;

type HtmlUrlBearingElement = keyof typeof HTML_URL_BEARING_ATTRIBUTES;

function htmlUrlBearingElement(name: string): HtmlUrlBearingElement | null {
  const normalized = name.toLowerCase();
  return normalized in HTML_URL_BEARING_ATTRIBUTES ? (normalized as HtmlUrlBearingElement) : null;
}

export function isHtmlDeniedElement(name: string): boolean {
  return (HTML_DENIED_ELEMENTS as readonly string[]).includes(name.toLowerCase());
}

export function isHtmlUrlBearingAttribute(elementName: string, attributeName: string): boolean {
  const element = htmlUrlBearingElement(elementName);
  return (
    element !== null &&
    HTML_URL_BEARING_ATTRIBUTES[element].includes(attributeName.toLowerCase() as never)
  );
}

export function isHtmlUrlAttributeName(attributeName: string): boolean {
  const normalized = attributeName.toLowerCase();
  return Object.values(HTML_URL_BEARING_ATTRIBUTES).some((attributes) =>
    attributes.includes(normalized as never),
  );
}

export function isHtmlEventHandlerAttribute(name: string): boolean {
  return name.toLowerCase().startsWith("on");
}

export function isHtmlInlineStyleAttribute(name: string): boolean {
  return name.toLowerCase() === "style";
}

export function isAllowedHtmlUrl(
  elementName: string,
  attributeName: string,
  value: string,
): boolean {
  const element = htmlUrlBearingElement(elementName);
  if (element === null || !isHtmlUrlBearingAttribute(element, attributeName)) return false;
  const trimmed = value.trim();
  if (trimmed.startsWith("//")) return false;
  if (!hasScheme(trimmed)) return true;
  let scheme: string;
  try {
    scheme = new URL(trimmed).protocol.toLowerCase();
  } catch {
    return false;
  }
  switch (element) {
    case "img":
      return (HTML_ALLOWED_IMAGE_SCHEMES as readonly string[]).includes(scheme);
    case "a":
      return (HTML_ALLOWED_ANCHOR_SCHEMES as readonly string[]).includes(scheme);
    default: {
      const _: never = element;
      return _;
    }
  }
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value);
}
