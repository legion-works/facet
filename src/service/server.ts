/**
 * Loopback service server.
 *
 * Bind order (security-critical — D3 review):
 *   1. Acquire the process lock FIRST with a minimal metadata record
 *      (pid + startTime; port=0). A second cold start cannot race the
 *      install-token create, DB migrate, or port bind while we hold
 *      the lock.
 *   2. Open the database + run migrations (idempotent under lock).
 *   3. Create the install token atomically (temp-file + rename under
 *      lock; a second starter that wins the lock reads what we wrote).
 *   4. Read the operator promote token (read-only, may be absent).
 *   5. Bind Bun.serve on 127.0.0.1:<os-assigned port>.
 *   6. Update the lock metadata with the assigned port + complete
 *      record — STILL holding the lock so a parallel starter cannot
 *      observe a port-less lock and assume the service is unready.
 *
 * Idle-driven stop: release the lock, close the server, WAL checkpoint.
 */

import { dirname } from "node:path";

import { FacetError } from "../shared/errors/facet-error";
import { createLogger, type FacetLogger } from "../shared/logging/logger";
import { computeFacetPaths } from "../shared/config/paths";

import { openDatabase } from "./store/database";
import { runMigrations } from "./store/migrations";
import { ArtifactRepository } from "./store/repository";
import { buildRouter } from "./router";
import { createInstallTokenStore, createPromoteTokenStore } from "./security/token-store";
import { createLeaseManager, type GalleryLeaseManager } from "./security/leases";
import {
  assertHeartbeatBeforeLeaseTtl,
  createRevisionBroadcaster,
  STREAM_HEARTBEAT_INTERVAL_MS,
} from "./stream";
import { defaultInsecureReason } from "./verdict-enrichment";
import {
  InsecureLevelSchema,
  type InsecureLevel,
  type Tier0Runner,
  type Tier1Runner,
} from "../shared/contracts/validation";
import {
  acquireLock,
  releaseLock,
  writeLockMetadata,
  readPidStartTimeTicks,
  type LockMetadata,
} from "./lifecycle/process-lock";
import { runOrphanCleanup } from "./lifecycle/orphan-cleanup";
import { createIdleController, type IdleController } from "./lifecycle/idle-controller";
import { ensureEvidenceRoot } from "./store/evidence-retention";
import { ensureOwnerOnlyDirectory } from "../shared/util/dir-permissions";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const LEASE_TTL_MS = 5 * 60_000;
export const BUN_SOCKET_IDLE_TIMEOUT_S = 45;

export interface StartServiceOptions {
  readonly insecureLevel?: InsecureLevel;
  readonly insecureReason?: string | null;
  readonly dbPath?: string;
  readonly installTokenPath?: string;
  readonly promoteTokenPath?: string;
  readonly lockPath?: string;
  readonly idleTimeoutMs?: number;
  readonly leaseTtlMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly logger?: FacetLogger;
  readonly host?: string;
  readonly onIdle?: () => void;
  /**
   * Tier 0 runner. Production callers pass the default from
   * `src/validation/tier0/runner.ts`; tests inject a stub so they
   * can exercise the publish path without spawning a worker. The
   * type lives in `dispatcher.ts` so the server does not need to
   * know which module implements it.
   */
  readonly tier0Runner?: Tier0Runner;
  /**
   * Optional Tier 1 verifier. When present, publish records BOTH a
   * Tier 0 and a Tier 1 render_run; read-back of tier 1 returns the
   * Tier 1 verdict. When absent, tier 1 is never recorded and
   * read-back of tier 1 surfaces `revision_not_found`.
   */
  readonly tier1Runner?: Tier1Runner;
}

export interface RunningService {
  readonly port: number;
  readonly pid: number;
  readonly url: string;
  readonly installToken: string;
  readonly promoteToken: string | null;
  stop(): Promise<void>;
  waitUntilIdle(): Promise<void>;
}

export async function startFacetService(
  options: StartServiceOptions = {},
): Promise<RunningService> {
  const logger = options.logger ?? createLogger({ component: "service" });
  const insecureLevel = InsecureLevelSchema.parse(options.insecureLevel ?? 0);
  const paths = computeFacetPaths();
  const dbPath = options.dbPath ?? paths.database;
  const installTokenPath =
    options.installTokenPath ?? paths.token.replace(/promote\.token$/, "install.token");
  const promoteTokenPath = options.promoteTokenPath ?? paths.token;
  const lockPath = options.lockPath ?? paths.lock;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? STREAM_HEARTBEAT_INTERVAL_MS;
  assertHeartbeatBeforeLeaseTtl(heartbeatIntervalMs, leaseTtlMs);
  const host = options.host ?? "127.0.0.1";

  // Pre-lock: orphan cleanup (read-only inspection of disk state).
  runOrphanCleanup({ lockPath, databasePath: dbPath });

  // Ensure the evidence root exists with mode 0700 before any
  // service writes land there. Idempotent and best-effort — the
  // directory may already exist (e.g. from a prior run) in which case
  // ensureEvidenceRoot rechmods to enforce the secret-bearing layout.
  ensureEvidenceRoot(paths.evidence);

  // 1. Lock FIRST. port=0 because the kernel-assigned port is not yet
  //    known. A second cold start that races this one will be refused
  //    by acquireLock (live foreign pid contention) until we either
  //    succeed (lock released on stop) or fail (typed constraint).
  const lockStartTime = Date.now();
  const lockMetadata: LockMetadata = {
    pid: process.pid,
    startTime: lockStartTime,
    startTimeTicks: readPidStartTimeTicks(process.pid),
    port: 0,
    contractVersion: "facet.v1",
  };
  const lockResult = acquireLock(lockPath, lockMetadata);
  if (!lockResult.ok) {
    throw lockResult.error;
  }

  let boundServer: ReturnType<typeof Bun.serve> | null = null;
  // Capture the hook before initialization so every later startup failure reaps a lazy worker.
  let tier0Close: (() => void) | null = options.tier0Runner?.close ?? null;
  let databaseClose: (() => void) | null = null;
  let leasesClear: (() => void) | null = null;
  const cleanup = (): void => {
    if (boundServer !== null) {
      try {
        boundServer.stop(true);
      } catch {
        // already stopped
      }
      boundServer = null;
    }
    if (tier0Close !== null) {
      try {
        tier0Close();
      } catch {
        // A worker can die before service cleanup reaches it.
      }
      tier0Close = null;
    }
    if (databaseClose !== null) {
      try {
        databaseClose();
      } catch {
        // already closed
      }
      databaseClose = null;
    }
    if (leasesClear !== null) {
      try {
        leasesClear();
      } catch {
        // already cleared
      }
      leasesClear = null;
    }
    releaseLock(lockPath);
  };

  try {
    // 2. Open the database under lock.
    ensureOwnerOnlyDirectory(dirname(dbPath));
    const db = openDatabase({ databasePath: dbPath });
    databaseClose = () => db.close();
    runMigrations(db);
    const repository = new ArtifactRepository(db, {
      onCommitted: (revision) => {
        logger.info("revision.committed", {
          artifactId: revision.artifactId,
          revisionSha: revision.sha256,
        });
      },
      // Evidence retention runs inside the write path; the root must
      // match the Tier 1 runner's screenshot/console destination so
      // the cleanup unlink lands on the same path the runner wrote.
      evidenceRoot: paths.evidence,
    });

    // 3. Install token (atomic create under lock). The token store uses
    //    write-tmp + rename so a second starter that later wins the lock
    //    reads the persisted token; we never cache a token that is not
    //    on disk.
    const installTokenStore = createInstallTokenStore({ tokenPath: installTokenPath });
    const installToken = installTokenStore.read();

    // 4. Promote token (read-only; absence is a typed state).
    const promoteTokenStore = createPromoteTokenStore({ tokenPath: promoteTokenPath });
    const promoteToken = promoteTokenStore.read();

    // 5. Idle + lease managers.
    let resolveStop: (() => void) | null = null;
    const idle: IdleController = createIdleController({
      idleTimeoutMs,
      onIdle: () => {
        logger.info("service.idle", { idleTimeoutMs });
        options.onIdle?.();
        resolveStop?.();
      },
    });
    const leases: GalleryLeaseManager = createLeaseManager({
      leaseTtlMs,
      onExpire: (entry) => {
        logger.info("lease.expired", { leaseId: entry.leaseId, artifactId: entry.artifactId });
        idle.release(`lease:${entry.leaseId}`);
      },
    });
    leasesClear = () => leases.clear();

    // 6. Bind Bun.serve on 127.0.0.1:<os-assigned port>. Host guards
    //    must reject (not inject) a missing Host header.
    const hostState: { value: string | null } = { value: null };
    // The Tier 0 runner is required because the service is byte-dumb
    // and may not import `src/validation`. The default runner lives
    // there; callers (CLI, tests) construct it externally and inject.
    if (options.tier0Runner === undefined) {
      throw new FacetError(
        "internal",
        "Tier 0 runner is not configured; pass startFacetService({ tier0Runner })",
        { retryable: false },
      );
    }
    const tier0Runner: Tier0Runner = options.tier0Runner;
    const tier1Runner: Tier1Runner | undefined = options.tier1Runner;
    // Write-path → SSE seam: the dispatcher emits the canonical
    // revision:committed event after commit + verdict runs; the
    // broadcaster fans it out to the live gallery streams.
    const broadcaster = createRevisionBroadcaster();
    const router = buildRouter({
      insecureLevel,
      insecureReason: options.insecureReason ?? null,
      ...(tier1Runner !== undefined ? { tier1Runner } : {}),
      repository,
      installToken,
      promoteToken,
      leases,
      idle,
      logger: logger.child("router"),
      expectedHost: () => hostState.value ?? "127.0.0.1:0",
      ownOrigin: () => `http://${hostState.value ?? "127.0.0.1:0"}`,
      startTime: lockStartTime,
      tier0Runner,
      tier1Runner,
      broadcaster,
      heartbeatIntervalMs,
      onPublished: (event) => broadcaster.emit(event),
    });
    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({
        hostname: host,
        port: 0,
        idleTimeout: BUN_SOCKET_IDLE_TIMEOUT_S,
        fetch: (req) => router.fetch(req),
      });
    } catch (error) {
      throw new FacetError("internal", "Failed to bind loopback port", {
        retryable: false,
        cause: error,
      });
    }
    const actualPort = server.port ?? 0;
    if (actualPort === 0) {
      try {
        server.stop(true);
      } catch {
        // ignore
      }
      throw new FacetError("internal", "Failed to bind loopback port", { retryable: false });
    }
    const expectedHost = `${host}:${actualPort}`;
    const ownOrigin = `http://${expectedHost}`;
    hostState.value = expectedHost;
    boundServer = server;

    // 7. Update lock metadata with the now-known port while still
    //    holding the lock. This is the LAST step before serving; a
    //    parallel starter that observes this lock sees a live service.
    writeLockMetadata(lockPath, {
      pid: process.pid,
      startTime: lockStartTime,
      port: actualPort,
      contractVersion: "facet.v1",
    });

    logger.info("service.ready", {
      port: actualPort,
      pid: process.pid,
      ...(insecureLevel > 0
        ? {
            insecureLevel,
            insecureReason: options.insecureReason ?? defaultInsecureReason(insecureLevel),
          }
        : {}),
    });

    const stopPromise = new Promise<void>((resolve) => {
      resolveStop = () => {
        cleanup();
        logger.info("service.stopped", { port: actualPort });
        resolve();
      };
    });

    return {
      port: actualPort,
      pid: process.pid,
      url: ownOrigin,
      installToken,
      promoteToken,
      stop: async () => {
        idle.stop();
        await stopPromise;
      },
      waitUntilIdle: () => idle.waitUntilIdle(),
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
