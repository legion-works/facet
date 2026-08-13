import type {
  InsecureLevel,
  InsecureMarker,
  TsxExecutionMode,
} from "../shared/contracts/validation";

export const defaultInsecureReason = (level: InsecureLevel): string =>
  `manual insecure level ${level}`;

export function insecureMarker(
  level: InsecureLevel,
  reason: string | null | undefined,
): InsecureMarker | undefined {
  if (level === 0) return undefined;
  return { level, reason: reason ?? defaultInsecureReason(level) };
}

/**
 * Bind the verdict to its (artifactId, revisionSha) pair and attach
 * the insecure marker and the TSX execution marker when set.
 * The execution marker is conditional spread so non-TSX verdicts
 * stay BYTE-IDENTICAL to the pre-arc wire shape — the field is
 * absent, not null. The Tier 0/1 result schema extends VerdictSchema,
 * so the marker flows through TSX publish and read-back uniformly.
 */
export function enrichVerdict<T extends object>(
  result: T,
  artifactId: string,
  revisionSha: string,
  insecure?: InsecureMarker,
  execution?: TsxExecutionMode,
): T & {
  artifactId: string;
  revisionSha: string;
  insecure?: InsecureMarker;
  execution?: TsxExecutionMode;
} {
  return {
    ...result,
    ...(insecure !== undefined ? { insecure } : {}),
    ...(execution !== undefined ? { execution } : {}),
    artifactId,
    revisionSha,
  };
}
