import type { InsecureLevel, InsecureMarker } from "../shared/contracts/validation";

export const defaultInsecureReason = (level: InsecureLevel): string =>
  `manual insecure level ${level}`;

export function insecureMarker(
  level: InsecureLevel,
  reason: string | null | undefined,
): InsecureMarker | undefined {
  if (level === 0) return undefined;
  return { level, reason: reason ?? defaultInsecureReason(level) };
}

export function enrichVerdict<T extends object>(
  result: T,
  artifactId: string,
  revisionSha: string,
  insecure?: InsecureMarker,
): T & { artifactId: string; revisionSha: string; insecure?: InsecureMarker } {
  return {
    ...result,
    ...(insecure !== undefined ? { insecure } : {}),
    artifactId,
    revisionSha,
  };
}
