/**
 * Evidence-root read resolution.
 *
 * The service is the only writer of evidence; the CLI and the export path
 * are readers. After explicit evidence-root threading, both agree on ONE
 * canonical root. But default-XDG installs that ran before the threading
 * wrote evidence under a legacy child-derived root
 * (`legacyXdgEvidenceRoot`), so readers must tolerate the divergence:
 * when the canonical root holds no evidence AND the legacy root does, reads
 * ALSO fall back to the legacy root. Writes never go there — the fallback is
 * read-only and the canonical root is authoritative for everything new.
 */

import { readdirSync, statSync } from "node:fs";

export interface EvidenceReadRoot {
  readonly path: string;
  /** True when this root is the legacy fallback, false for the canonical root. */
  readonly legacy: boolean;
}

export interface EvidenceFs {
  /** True when `path` exists and holds at least one non-empty file (recursively). */
  hasEvidence(path: string): boolean;
}

/**
 * Recursively true when `path` exists and contains at least one file with
 * non-zero size. An empty or missing directory is "no evidence".
 */
export function directoryHasEvidence(path: string): boolean {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return false;
  }
  if (stat.isFile()) return stat.size > 0;
  if (!stat.isDirectory()) return false;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (directoryHasEvidence(`${path}/${entry}`)) return true;
  }
  return false;
}

/**
 * Ordered roots a reader should consult. The canonical root is always first;
 * the legacy root is appended only when the canonical root holds no evidence
 * while the legacy root does (the pre-threading migration case). Callers that
 * see a `legacy: true` root should log once and must never write to it.
 */
export function resolveEvidenceReadRoots(
  canonical: string,
  legacy: string | null,
  fs: EvidenceFs = { hasEvidence: directoryHasEvidence },
): EvidenceReadRoot[] {
  const roots: EvidenceReadRoot[] = [{ path: canonical, legacy: false }];
  if (
    legacy !== null &&
    legacy !== canonical &&
    !fs.hasEvidence(canonical) &&
    fs.hasEvidence(legacy)
  ) {
    roots.push({ path: legacy, legacy: true });
  }
  return roots;
}

/** Total byte count of evidence across the resolved read roots. */
export function evidenceBytesAcross(roots: readonly EvidenceReadRoot[]): number {
  let total = 0;
  for (const root of roots) total += directoryBytes(root.path);
  return total;
}

function directoryBytes(path: string): number {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(path)) total += directoryBytes(`${path}/${entry}`);
  } catch {
    // unreadable directory counts as zero
  }
  return total;
}
