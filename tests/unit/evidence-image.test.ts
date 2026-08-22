import { describe, expect, test } from "bun:test";

import {
  extensionForEvidenceImage,
  mediaTypeForEvidenceImage,
  sniffEvidenceImageFormat,
} from "../../src/shared/evidence-image";

describe("evidence image contract", () => {
  test("sniffs PNG and WebP magic bytes and rejects unknown data", () => {
    expect(
      sniffEvidenceImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("png");
    expect(sniffEvidenceImageFormat(new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBP"))).toBe(
      "webp",
    );
    expect(sniffEvidenceImageFormat(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("maps evidence formats to media types and extensions", () => {
    expect(mediaTypeForEvidenceImage("png")).toBe("image/png");
    expect(mediaTypeForEvidenceImage("webp")).toBe("image/webp");
    expect(extensionForEvidenceImage("png")).toBe(".png");
    expect(extensionForEvidenceImage("webp")).toBe(".webp");
  });
});
