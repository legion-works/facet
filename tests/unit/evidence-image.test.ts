import { describe, expect, test } from "bun:test";

import {
  extensionForEvidenceImage,
  mediaTypeForEvidenceImage,
  sniffEvidenceImageFormat,
} from "../../src/shared/evidence-image";
import { RenderRunSchema } from "../../src/shared/contracts/artifact";

describe("evidence image contract", () => {
  test("sniffs PNG and WebP magic bytes and rejects unknown data", () => {
    expect(
      sniffEvidenceImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("png");
    expect(sniffEvidenceImageFormat(new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBP"))).toBe(
      "webp",
    );
    expect(
      sniffEvidenceImageFormat(new TextEncoder().encode("RIFF\x00\x00\x00\x00NOPE")),
    ).toBeNull();
    expect(sniffEvidenceImageFormat(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("maps evidence formats to media types and extensions", () => {
    expect(mediaTypeForEvidenceImage("png")).toBe("image/png");
    expect(mediaTypeForEvidenceImage("webp")).toBe("image/webp");
    expect(extensionForEvidenceImage("png")).toBe(".png");
    expect(extensionForEvidenceImage("webp")).toBe(".webp");
  });

  test("requires the nullable screenshotFormat key on render runs", () => {
    const run = {
      id: "run",
      revisionId: "revision",
      tier: 1 as const,
      status: "ok",
      expectedJson: "{}",
      observedJson: "{}",
      screenshotPath: null,
      consolePath: null,
      screenshotErrorJson: null,
      insecureJson: null,
      retained: false,
      startedAt: "2026-08-22T00:00:00.000Z",
      finishedAt: "2026-08-22T00:00:00.000Z",
    };
    expect(RenderRunSchema.safeParse(run).success).toBe(false);
    expect(RenderRunSchema.parse({ ...run, screenshotFormat: null }).screenshotFormat).toBeNull();
  });
});
