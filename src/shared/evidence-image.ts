import { z } from "zod";

export const EvidenceImageFormatSchema = z.enum(["png", "webp"]);
export type EvidenceImageFormat = z.infer<typeof EvidenceImageFormatSchema>;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function sniffEvidenceImageFormat(bytes: Uint8Array): EvidenceImageFormat | null {
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return "png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "webp";
  return null;
}

export function mediaTypeForEvidenceImage(format: EvidenceImageFormat): "image/png" | "image/webp" {
  return format === "png" ? "image/png" : "image/webp";
}

export function extensionForEvidenceImage(format: EvidenceImageFormat): ".png" | ".webp" {
  return format === "png" ? ".png" : ".webp";
}
