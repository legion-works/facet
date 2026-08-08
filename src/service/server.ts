/**
 * Loopback service server.
 *
 * Wires the store, security, lifecycle, and router together. Boots on
 * 127.0.0.1:<os-assigned-port>, creates an install token if absent,
 * acquires the process lock, and writes the ready/metadata record so
 * external CLI tooling can discover the service. Exits on idle.
 *
 * Bind strategy: we build the router with a placeholder port, bind once
 * on port 0 to learn the kernel-assigned port, then rewire the router's
 * expectedHost/origin via a mutable holder. We do NOT rebind Bun.serve
 * after the initial bind — the port is held for the lifetime of the
 * service, and the Host guard uses the placeholder until the first
 * request rewrites the holder.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { FacetError } from "../shared/errors/facet-error";
import { createLogger, type FacetLogger } from "../shared/logging/logger";
import { computeFacetPaths } from "../shared/config/paths";

import { openDatabase } from "./store/database";
import { runMigrations } from "./store/migrations";
import { ArtifactRepository } from "./store/repository";
import { buildRouter, type RouterDeps } from "./router";
import { createInstallTokenStore, createPromoteTokenStore } from "./security/token-store";
import { createLeaseManager, type GalleryLeaseManager } from "./security/leases";
import { acquireLock, releaseLock, type LockMetadata } from "./lifecycle/process-lock";
import { runOrphanCleanup } from "./lifecycle/orphan-cleanup";
import { createIdleController, type IdleController } from "./lifecycle/idle-controller";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const LEASE_TTL_MS = 5 * 60_000;

export interface StartServiceOptions {
  readonly dbPath?: string;
  readonly installTokenPath?: string;
  readonly promoteTokenPath?: string;
  readonly lockPath?: string;
  readonly idleTimeoutMs?: number;
  readonly logger?: FacetLogger;
  readonly host?: string;
  readonly onIdle?: () => void;
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
  const paths = computeFacetPaths();
  const dbPath = options.dbPath ?? paths.database;
  const installTokenPath =
    options.installTokenPath ?? paths.token.replace(/promote\.token$/, "install.token");
  const promoteTokenPath = options.promoteTokenPath ?? paths.token;
  const lockPath = options.lockPath ?? paths.lock;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const host = options.host ?? "127.0.0.1";

  // 1. Orphan cleanup before we acquire anything new.
  runOrphanCleanup({ lockPath, databasePath: dbPath });

  // 2. Open the store + run migrations.
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase({ databasePath: dbPath });
  runMigrations(db);
  const repository = new ArtifactRepository(db, {
    onCommitted: (revision) => {
      logger.info("revision.committed", {
        artifactId: revision.artifactId,
        revisionSha: revision.sha256,
      });
    },
  });

  // 3. Token stores (install is auto-created; promote is read-only).
  const installTokenStore = createInstallTokenStore({ tokenPath: installTokenPath });
  const installToken = installTokenStore.read();
  const promoteTokenStore = createPromoteTokenStore({ tokenPath: promoteTokenPath });
  const promoteToken = promoteTokenStore.read();

  // 4. Idle + lease managers.
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
    leaseTtlMs: LEASE_TTL_MS,
    onExpire: (entry) => {
      logger.info("lease.expired", { leaseId: entry.leaseId, artifactId: entry.artifactId });
      idle.release(`lease:${entry.leaseId}`);
    },
  });

  // 5. Bind on 127.0.0.1:<os-assigned port>. We bind once. The router
  //    uses a mutable `hostState` so the Host-exact-match guard
  //    accepts the kernel-assigned port once known — until then, a
  //    request with no Host header is normalized to the bound port.
  const hostState: { value: string | null } = { value: null };
  const routerDeps: RouterDeps = {
    repository,
    installToken,
    promoteToken,
    leases,
    idle,
    logger: logger.child("router"),
    expectedHost: () => hostState.value ?? "127.0.0.1:0",
    ownOrigin: () => `http://${hostState.value ?? "127.0.0.1:0"}`,
    startTime: Date.now(),
  };
  // We pass RouterDeps by-value at build time, but `getHost()` is
  // consulted inside the fetch handler below. The router holds the
  // PLACEHOLDER expectedHost; we patch the comparison by reading
  // hostState at request time.
  const router = buildRouter(routerDeps);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: host,
      port: 0,
      fetch: async (req) => {
        const incomingHost = req.headers.get("host");
        // If the request carries no Host (loopback transport), inject
        // the bound expected host so the host-exact-match guard passes.
        if (incomingHost === null && hostState.value !== null) {
          const headers = new Headers(req.headers);
          headers.set("host", hostState.value);
          req = new Request(req, { headers });
        }
        return router.fetch(req);
      },
    });
  } catch (error) {
    db.close();
    throw new FacetError("internal", "Failed to bind loopback port", {
      retryable: false,
      cause: error,
    });
  }
  const actualPort = server.port ?? 0;
  if (actualPort === 0) {
    server.stop(true);
    db.close();
    throw new FacetError("internal", "Failed to bind loopback port", { retryable: false });
  }
  const expectedHost = `${host}:${actualPort}`;
  const ownOrigin = `http://${expectedHost}`;
  hostState.value = expectedHost;

  // 6. Acquire the process lock.
  const lockMetadata: LockMetadata = {
    pid: process.pid,
    startTime: Date.now(),
    port: actualPort,
    contractVersion: "facet.v1",
  };
  const lockResult = acquireLock(lockPath, lockMetadata);
  if (!lockResult.ok) {
    server.stop(true);
    db.close();
    throw lockResult.error;
  }

  logger.info("service.ready", { port: actualPort, pid: process.pid });

  const stopPromise = new Promise<void>((resolve) => {
    resolveStop = () => {
      try {
        server.stop(true);
      } catch {
        // already stopped
      }
      try {
        db.close();
      } catch {
        // already closed
      }
      leases.clear();
      releaseLock(lockPath);
      logger.info("service.stopped", { port: actualPort });
      resolve();
    };
  });

  const running: RunningService = {
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
  return running;
}
