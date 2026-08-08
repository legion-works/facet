/**
 * Service metadata helpers shared by the lazy spawn path and any
 * future CLI surface that needs to peek at the live loopback service.
 *
 * Three responsibilities:
 *
 *   1. Read the install token from disk (the CLI never auto-generates
 *      tokens; the service does on its first start).
 *   2. Read the validated metadata record and classify it as live,
 *      stale, cross-version, or missing. The classification drives
 *      every spawn decision.
 *   3. Wait for the metadata record to become ready (port > 0, live
 *      pid, matching contract version) under a bounded deadline.
 *      Never a fixed sleep.
 *
 * Extracted from `spawn-service.ts` so the orchestrator stays under
 * the 300-line hard cap; the helpers here are the kind that grow as
 * new edge cases get defended.
 */

import { existsSync, readFileSync } from "node:fs";

import { FacetError } from "../shared/errors/facet-error";
import { FACET_SCHEMA_VERSION } from "../shared/contracts/envelope";
import {
  isLockStale,
  readLockMetadata,
  type LockMetadata,
} from "../service/lifecycle/process-lock";
import { isPidAlive } from "../service/lifecycle/process-lock";
import type { FacetRuntimePaths } from "../shared/config/paths";

/**
 * Build the typed contract-mismatch error used by every code path
 * that observes a cross-version lock. Lives in one place so the
 * error body shape cannot drift between the fast-path and the
 * wait-for-ready path.
 */
export function contractMismatchError(meta: {
  pid: number;
  port: number;
  contractVersion: string;
}): FacetError {
  return new FacetError(
    "internal",
    `Service contract version mismatch: service=${meta.contractVersion}, cli=${FACET_SCHEMA_VERSION}`,
    {
      retryable: false,
      details: {
        reason: "contract_version_mismatch",
        service: meta.contractVersion,
        cli: FACET_SCHEMA_VERSION,
        pid: meta.pid,
        port: meta.port,
      },
    },
  );
}

/**
 * Read the install token from disk. The token is created by the
 * service during its first start; if the lock is missing the token
 * is too. The CLI never auto-generates tokens — that is a
 * service-side responsibility.
 */
export function readInstallToken(paths: FacetRuntimePaths): string {
  const tokenPath = paths.token.replace(/promote\.token$/, "install.token");
  if (!existsSync(tokenPath)) {
    throw new FacetError(
      "internal",
      `Install token not found at ${tokenPath}; the service must start before the CLI can talk to it`,
      { retryable: true, details: { tokenPath } },
    );
  }
  const value = readFileSync(tokenPath, "utf8").trim();
  if (value.length === 0) {
    throw new FacetError("internal", `Install token at ${tokenPath} is empty`, {
      retryable: false,
      details: { tokenPath },
    });
  }
  return value;
}

/**
 * Read a usable metadata record from disk. Returns the record only
 * when it points at a live, contract-version-matching service.
 * Returns null in every other case (missing, stale, dead pid) so the
 * caller can decide whether to spawn or surface a typed error.
 *
 * Cross-version live records are reported as `null` here — the caller
 * uses `readLiveMetadata` only for the same-version fast path and
 * branches on contract version separately to surface the typed
 * mismatch error.
 */
export function readLiveMetadata(paths: FacetRuntimePaths): LockMetadata | null {
  const meta = readLockMetadata(paths.lock);
  if (meta === null) return null;
  if (meta.contractVersion !== FACET_SCHEMA_VERSION) return null;
  if (!isPidAlive(meta.pid)) return null;
  if (isLockStale(meta)) return null;
  return meta;
}

/**
 * Wait for the metadata record to appear with a non-zero port —
 * `startFacetService` writes the port AFTER the kernel-assigned
 * bind succeeds, so a port>0 record means a serving loopback.
 * Poll-with-deadline — never a fixed sleep. Throws a typed
 * `contract_version_mismatch` if the record appears with a future
 * schema version (a build upgrade) and a typed `internal` on
 * deadline.
 */
export async function waitForReady(
  paths: FacetRuntimePaths,
  timeoutMs: number,
  intervalMs: number,
): Promise<LockMetadata> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = readLockMetadata(paths.lock);
    if (meta !== null && meta.port > 0) {
      if (meta.contractVersion !== FACET_SCHEMA_VERSION) {
        throw contractMismatchError(meta);
      }
      if (isPidAlive(meta.pid)) return meta;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new FacetError("internal", "Service did not become ready before deadline", {
    retryable: true,
    details: { timeoutMs, lockPath: paths.lock },
  });
}
