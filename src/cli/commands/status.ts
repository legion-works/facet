/**
 * `facet status` request builder.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

import { generateRequestId } from "../../shared/util/time";
import type { StatusRequest } from "../../shared/contracts/commands/requests";
import { FACET_SCHEMA_VERSION } from "../../shared/contracts/envelope";
import type { FacetRuntimePaths } from "../../shared/config/paths";
import { evidenceBytesAcross, resolveEvidenceReadRoots } from "../../shared/config/evidence-read";
import { FACET_VERSION } from "../../shared/version";
import { readLiveMetadata } from "../service-metadata";

export interface FacetStatusOptions {
  readonly activeLeases?: number;
  readonly activeJobs?: number;
  readonly browserJobs?: number;
  readonly idleDeadline?: number | null;
}

export interface FacetStatus {
  readonly state: "dormant" | "active";
  readonly process: {
    readonly pid: number;
    readonly uptimeMs: number;
    readonly rssBytes: number | null;
    readonly pssBytes: number | null;
  } | null;
  readonly dbBytes: number;
  readonly evidenceBytes: number;
  readonly activeLeases: number;
  readonly activeJobs: number;
  readonly browserJobs: number;
  readonly idleDeadline: number | null;
  readonly version: string;
  readonly contractVersion: string;
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return readdirSync(path).reduce((total, entry) => total + directoryBytes(`${path}/${entry}`), 0);
}

function readKbMetric(text: string, key: string): number | null {
  const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
  return match ? Number(match[1]) * 1024 : null;
}

function processMemory(pid: number): { rssBytes: number | null; pssBytes: number | null } {
  try {
    const statusText = readFileSync(`/proc/${pid}/status`, "utf8");
    const rollupText = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    return {
      rssBytes: readKbMetric(statusText, "VmRSS"),
      pssBytes: readKbMetric(rollupText, "Pss"),
    };
  } catch {
    let rssBytes: number | null = null;
    try {
      const statusText = readFileSync(`/proc/${pid}/status`, "utf8");
      rssBytes = readKbMetric(statusText, "VmRSS");
    } catch {
      // The process may have exited or become unreadable between probes.
    }
    return { rssBytes, pssBytes: null };
  }
}

export function collectFacetStatus(
  paths: FacetRuntimePaths,
  options: FacetStatusOptions = {},
  legacyEvidenceRoot: string | null = null,
): FacetStatus {
  const metadata = readLiveMetadata(paths);
  const memory = metadata === null ? null : processMemory(metadata.pid);
  const evidenceBytes = evidenceBytesAcross(
    resolveEvidenceReadRoots(paths.evidence, legacyEvidenceRoot),
  );
  return {
    state: metadata === null ? "dormant" : "active",
    process:
      metadata === null
        ? null
        : {
            pid: metadata.pid,
            uptimeMs: Math.max(0, Date.now() - metadata.startTime),
            rssBytes: memory?.rssBytes ?? null,
            pssBytes: memory?.pssBytes ?? null,
          },
    dbBytes: directoryBytes(paths.database),
    evidenceBytes,
    activeLeases: options.activeLeases ?? 0,
    activeJobs: options.activeJobs ?? 0,
    browserJobs: options.browserJobs ?? 0,
    idleDeadline: options.idleDeadline ?? null,
    version: FACET_VERSION,
    contractVersion: FACET_SCHEMA_VERSION,
  };
}

export function buildStatusRequest(
  args: Readonly<Record<string, string | boolean>>,
): StatusRequest {
  const artifactId = args["artifact-id"];
  return {
    command: "status",
    requestId: generateRequestId(),
    ...(typeof artifactId === "string" && artifactId.length > 0 ? { artifactId } : {}),
  };
}
