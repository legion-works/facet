import type { InsecureLevel, InsecureMarker } from "../shared/contracts/validation";

const DEFAULT_INSECURE_REASON = (level: Exclude<InsecureLevel, 0>): string =>
  `manual insecure level ${level}`;

export function insecureMarker(
  level: InsecureLevel,
  reason: string | null | undefined,
): InsecureMarker | undefined {
  if (level === 0) return undefined;
  return { level, reason: reason ?? DEFAULT_INSECURE_REASON(level) };
}

export function enrichVerdict<T extends object>(
  result: T,
  artifactId: string,
  revisionSha: string,
  insecure?: InsecureMarker,
): T & { artifactId: string; revisionSha: string } {
  return {
    ...result,
    ...(insecure !== undefined ? { insecure } : {}),
    artifactId,
    revisionSha,
  };
}
