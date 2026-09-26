import { expect, test } from "bun:test";

import {
  countExternalHttpsImageReferences,
  isExternalHttpsImageSource,
  srcsetCandidates,
} from "../../src/shared/html/policy";
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

test.each([
  [
    "https://host/a,b.png 1x, https://host/c.png 2x",
    ["https://host/a,b.png", "https://host/c.png"],
  ],
  [
    "  https://host/a.png 200w ,  https://host/b.png 2x  ",
    ["https://host/a.png", "https://host/b.png"],
  ],
  [" , , https://host/a.png, , ", ["https://host/a.png"]],
  [
    "data:image/png;base64,AAAA 1x, https://host/a.png 2x",
    ["data:image/png;base64,AAAA", "https://host/a.png"],
  ],
  ["https://host/a.png 100w 200h, https://host/invalid.png 0w", ["https://host/a.png"]],
  ["https://host/leading.png 001w, https://host/invalid.png 000h", ["https://host/leading.png"]],
] as const)("srcset extracts candidates without splitting URL commas: %s", (source, expected) => {
  expect(srcsetCandidates(source)).toEqual([...expected]);
});

test.each([
  ["a 1x,", ["a"]],
  ["a 1x, ", ["a"]],
  ["a 1x ,", ["a"]],
  ["a,b 1x", ["a,b"]],
  ["a 1x, b 2x,", ["a", "b"]],
  [",", []],
  ["a 100w,", ["a"]],
] as const)("parses a srcset boundary: %s", (source, expected) => {
  expect(srcsetCandidates(source)).toEqual([...expected]);
});

test("the shared counter includes src and every srcset candidate on img, only srcset on source", () => {
  expect(
    countExternalHttpsImageReferences({
      element: "img",
      src: "https://host/base.png",
      srcset: "https://host/a,b.png 1x, https://host/c.png 2x",
    }),
  ).toBe(3);
  expect(
    countExternalHttpsImageReferences({
      element: "source",
      src: "https://host/ignored.png",
      srcset: "https://host/a.png 2w",
    }),
  ).toBe(1);
  expect(
    countExternalHttpsImageReferences({
      element: "other",
      src: "https://host/ignored.png",
      srcset: "https://host/a.png",
    }),
  ).toBe(0);
});

test("the serialized shared image counter agrees without module scope", () => {
  const isolated = new Function(
    `var isExternalHttpsImageSource=(${isExternalHttpsImageSource.toString()});var srcsetCandidates=(${srcsetCandidates.toString()});return (${countExternalHttpsImageReferences.toString()});`,
  )() as typeof countExternalHttpsImageReferences;
  for (const image of [
    {
      element: "img",
      src: "https://host/base.png",
      srcset: "https://host/a,b.png 1x, https://host/c.png 2x",
    },
    { element: "source", srcset: "https://host/a.png 1x, https://host/b.png 2x" },
    { element: "img", src: "data:image/png;base64,AAAA", srcset: "" },
    { element: "img", srcset: "https://host/a.png 1x," },
  ])
    expect(isolated(image)).toBe(countExternalHttpsImageReferences(image));
  expect(isolated({ element: "img", srcset: "https://host/a.png 1x," })).toBe(1);
});
