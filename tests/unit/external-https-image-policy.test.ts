import { expect, test } from "bun:test";

import { isExternalHttpsImageSource } from "../../src/shared/html/policy";
import { parseMarkdown } from "../../src/validation/tier0/markdown";

const IMAGE_SOURCE_CASES = [
  ["absolute HTTPS URL", "https://host/x.png", true],
  ["HTTP URL", "http://host/x.png", false],
  ["data URL", "data:image/png,abc", false],
  ["relative URL", "/x.png", false],
  ["protocol-relative URL", "//host/x.png", false],
  ["mixed-case scheme", "HTTPS://host/x.png", true],
  ["leading whitespace", " https://host/x.png", true],
  ["empty string", "", false],
  ["null", null, false],
  ["undefined", undefined, false],
  ["malformed URL", "https://[", false],
] as const;

test.each(IMAGE_SOURCE_CASES)(
  "classifies %s as an external HTTPS image",
  (_label, source, expected) => {
    expect(isExternalHttpsImageSource(source)).toBe(expected);
  },
);

test("the serialized predicate works without its module scope", () => {
  const isolated = new Function(
    `return (${isExternalHttpsImageSource.toString()})`,
  )() as typeof isExternalHttpsImageSource;

  for (const [, source] of IMAGE_SOURCE_CASES) {
    expect(isolated(source)).toBe(isExternalHttpsImageSource(source));
  }
});

test("Tier 0 does not disclose HTTP Markdown images as external HTTPS resources", async () => {
  const source = new TextEncoder().encode("![image](http://host/x.png)");
  const parsed = await parseMarkdown(source);

  expect(parsed.status).toBe("ok");
  expect(parsed.observed.externalImageCount).toBe(0);
});
