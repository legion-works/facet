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
  source: ["srcset"],
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

export function isExternalHttpsImageSource(src: string | null | undefined): boolean {
  if (typeof src !== "string") return false;
  try {
    return new URL(src).protocol === "https:";
  } catch {
    return false;
  }
}

/** URL candidates from the HTML Standard's srcset splitting and descriptor parsing algorithm. */
export function srcsetCandidates(input: string): string[] {
  const candidates: string[] = [];
  let position = 0;
  const whitespace = /[ \t\n\r\f]/;
  while (position < input.length) {
    while (
      position < input.length &&
      (whitespace.test(input[position]!) || input[position] === ",")
    )
      position += 1;
    if (position >= input.length) break;
    const start = position;
    while (position < input.length && !whitespace.test(input[position]!)) position += 1;
    let url = input.slice(start, position);
    const descriptors: string[] = [];
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      while (position < input.length && whitespace.test(input[position]!)) position += 1;
      let descriptor = "";
      let state: "descriptor" | "parens" | "after" = "descriptor";
      while (position < input.length) {
        const character = input[position++]!;
        if (state === "parens") {
          descriptor += character;
          if (character === ")") state = "descriptor";
        } else if (state === "after") {
          if (!whitespace.test(character)) {
            position -= 1;
            state = "descriptor";
          }
        } else if (character === ",") {
          if (descriptor) descriptors.push(descriptor);
          descriptor = "";
          break;
        } else if (whitespace.test(character)) {
          if (descriptor) descriptors.push(descriptor);
          descriptor = "";
          state = "after";
        } else {
          descriptor += character;
          if (character === "(") state = "parens";
        }
      }
      if (descriptor && position >= input.length) descriptors.push(descriptor);
    }
    let width = false;
    let density = false;
    let futureHeight = false;
    let valid = url.length > 0;
    for (const descriptor of descriptors) {
      if (
        /^[0-9]+w$/.test(descriptor) &&
        Number(descriptor.slice(0, -1)) > 0 &&
        !width &&
        !density
      ) {
        width = true;
      } else if (
        /^(?:\+|-)?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?x$/.test(descriptor) &&
        !width &&
        !density &&
        !futureHeight &&
        Number(descriptor.slice(0, -1)) >= 0
      ) {
        density = true;
      } else if (
        /^[0-9]+h$/.test(descriptor) &&
        Number(descriptor.slice(0, -1)) > 0 &&
        !futureHeight &&
        !density
      ) {
        futureHeight = true;
      } else {
        valid = false;
      }
    }
    if (futureHeight && !width) valid = false;
    if (valid) candidates.push(url);
  }
  return candidates;
}

export function countExternalHttpsImageReferences(input: {
  element: string;
  src?: string | null | undefined;
  srcset?: string | null | undefined;
}): number {
  if (input.element !== "img" && input.element !== "source") return 0;
  let count = input.element === "img" && isExternalHttpsImageSource(input.src) ? 1 : 0;
  if (input.srcset !== null && input.srcset !== undefined) {
    for (const candidate of srcsetCandidates(input.srcset)) {
      if (isExternalHttpsImageSource(candidate)) count += 1;
    }
  }
  return count;
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
  let url: URL;
  try {
    url = new URL(trimmed, "https://facet.invalid/");
  } catch {
    return false;
  }
  const scheme = url.protocol.toLowerCase();
  switch (element) {
    case "img":
    case "source":
      if (scheme === "data:") return isImageDataUrl(url);
      return (HTML_ALLOWED_IMAGE_SCHEMES as readonly string[]).includes(scheme);
    case "a":
      return (HTML_ALLOWED_ANCHOR_SCHEMES as readonly string[]).includes(scheme);
    default: {
      const _: never = element;
      return _;
    }
  }
}

function isImageDataUrl(url: URL): boolean {
  const comma = url.pathname.indexOf(",");
  if (comma < 0) return false;
  const metadata = url.pathname.slice(0, comma);
  const separator = metadata.indexOf(";");
  const encodedMediaType = (separator < 0 ? metadata : metadata.slice(0, separator)).trim();
  let mediaType: string;
  try {
    mediaType = decodeURIComponent(encodedMediaType).toLowerCase();
  } catch {
    return false;
  }
  const parts = mediaType.split("/");
  return parts.length === 2 && parts[0] === "image" && parts[1]!.length > 0;
}
