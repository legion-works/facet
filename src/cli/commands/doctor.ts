import { existsSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";

import { computeFacetPaths, type FacetRuntimePaths } from "../../shared/config/paths";
import { FACET_SCHEMA_VERSION } from "../../shared/contracts/envelope";
import { CURRENT_STORAGE_VERSION } from "../../shared/storage-version";
import {
  isLockStale,
  readLockMetadata,
  type LockMetadata,
} from "../../service/lifecycle/process-lock";
import { isPidAlive } from "../../shared/util/process";
import { probeNetnsSupport, type NetnsProbe } from "../../validation/sandbox/netns";
import { resolveShellBinary } from "../../validation/tier1/launcher";
import type { DoctorResult } from "../../shared/contracts/commands/results";

export const DOCTOR_PROBE_NAMES = [
  "bun",
  "chrome-headless-shell",
  "netns-userns",
  "database",
  "token-permissions",
  "evidence-permissions",
  "service-lock",
] as const;
export type DoctorProbeName = (typeof DOCTOR_PROBE_NAMES)[number];
export type DoctorProbeResult = DoctorResult["probes"][number];

type DoctorFs = {
  exists: (path: string) => boolean;
  stat: (path: string) => { mode: number };
};
type DoctorDb = { quickCheck: string; version: number | null };
export interface DoctorOptions {
  readonly bunVersion?: string;
  readonly paths?: FacetRuntimePaths;
  readonly shellBinary?: string | null;
  readonly netns?: NetnsProbe;
  readonly fs?: DoctorFs;
  readonly databaseReader?: (path: string) => DoctorDb;
  readonly lockReader?: (path: string) => LockMetadata | null;
  readonly pidAlive?: (pid: number) => boolean;
  readonly lockStale?: (metadata: LockMetadata) => boolean;
  readonly statusCheck?: (metadata: LockMetadata) => boolean;
}

const BUN_VERSION = "1.4.0";
const shellFix = "bunx --bun puppeteer browsers install chrome-headless-shell@151.0.7922.77";
const netnsFix =
  "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 && unshare --map-current-user --user --net -- /bin/true";

function defaultDbReader(path: string): DoctorDb {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const quickCheck = String(
      (db.query("PRAGMA quick_check").get() as { quick_check?: string })?.quick_check,
    );
    const row = db.query("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version?: number | null;
    };
    return { quickCheck, version: row.version ?? null };
  } finally {
    db.close();
  }
}

function modeOf(fs: DoctorFs, path: string): number | null {
  try {
    return fs.stat(path).mode & 0o777;
  } catch {
    return null;
  }
}

function probe(
  name: DoctorProbeName,
  status: "pass" | "fail",
  summary: string,
  fixCommand: string | null,
  details: Record<string, string | number | boolean | null> = {},
): DoctorProbeResult {
  return { name, status, summary, fixCommand, details };
}

export function runDoctor(options: DoctorOptions = {}): DoctorResult {
  const paths = options.paths ?? computeFacetPaths();
  const fs = options.fs ?? { exists: existsSync, stat: statSync };
  const databaseReader = options.databaseReader ?? defaultDbReader;
  const lockReader = options.lockReader ?? readLockMetadata;
  const pidAlive = options.pidAlive ?? isPidAlive;
  const lockStale = options.lockStale ?? isLockStale;
  const shellBinary =
    options.shellBinary === undefined ? resolveShellBinary() : options.shellBinary;
  const netns = options.netns ?? probeNetnsSupport();
  const probes: DoctorProbeResult[] = [];
  const bunVersion = options.bunVersion ?? Bun.version;

  probes.push(
    bunVersion === BUN_VERSION
      ? probe("bun", "pass", bunVersion, null, { version: bunVersion, expected: BUN_VERSION })
      : probe(
          "bun",
          "fail",
          `${bunVersion}, expected ${BUN_VERSION}`,
          `curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"`,
          {
            version: bunVersion,
            expected: BUN_VERSION,
          },
        ),
  );
  probes.push(
    shellBinary === null
      ? probe("chrome-headless-shell", "fail", "pinned shell not found", shellFix, { found: false })
      : probe("chrome-headless-shell", "pass", shellBinary, null, {
          found: true,
          path: shellBinary,
        }),
  );
  probes.push(
    netns.available
      ? probe("netns-userns", "pass", "available", null, { available: true })
      : probe("netns-userns", "fail", netns.reason ?? "unavailable", netnsFix, {
          available: false,
          reason: netns.reason,
        }),
  );

  if (!fs.exists(paths.database)) {
    probes.push(
      probe("database", "fail", "database missing", "facet status --start", { present: false }),
    );
  } else {
    try {
      const db = databaseReader(paths.database);
      if (db.quickCheck !== "ok") {
        probes.push(
          probe("database", "fail", `quick_check ${db.quickCheck}`, "facet status --start", {
            quickCheck: db.quickCheck,
          }),
        );
      } else if (db.version !== CURRENT_STORAGE_VERSION) {
        probes.push(
          probe(
            "database",
            "fail",
            `schema v${db.version ?? "unknown"}, expected v${CURRENT_STORAGE_VERSION}`,
            "facet status --start",
            {
              version: db.version,
              expected: CURRENT_STORAGE_VERSION,
            },
          ),
        );
      } else {
        probes.push(
          probe("database", "pass", `schema v${db.version}`, null, {
            quickCheck: db.quickCheck,
            version: db.version,
          }),
        );
      }
    } catch (error) {
      probes.push(
        probe(
          "database",
          "fail",
          error instanceof Error ? error.message : String(error),
          "facet status --start",
        ),
      );
    }
  }

  const installToken = paths.token.replace(/promote\.token$/, "install.token");
  const tokenPaths = [installToken, paths.token];
  const tokenModes = tokenPaths.map((path) => ({ path, mode: modeOf(fs, path) }));
  const tokenBad = tokenModes.find(({ mode }) => mode !== null && mode !== 0o600);
  const installMode = modeOf(fs, installToken);
  probes.push(
    tokenBad
      ? probe(
          "token-permissions",
          "fail",
          `${tokenBad.path} mode ${tokenBad.mode?.toString(8)}`,
          'chmod 600 "$FACET_HOME/secrets/install.token" "$FACET_HOME/secrets/promote.token"',
          { path: tokenBad.path, mode: tokenBad.mode },
        )
      : installMode === null
        ? probe("token-permissions", "fail", `${installToken} missing`, "facet status --start", {
            path: installToken,
            present: false,
          })
        : probe("token-permissions", "pass", "token files mode 600", null, { mode: 0o600 }),
  );

  const evidenceMode = modeOf(fs, paths.evidence);
  probes.push(
    evidenceMode === 0o700
      ? probe("evidence-permissions", "pass", "mode 700", null, { mode: evidenceMode })
      : probe(
          "evidence-permissions",
          "fail",
          evidenceMode === null ? "evidence root missing" : `mode ${evidenceMode.toString(8)}`,
          `mkdir -p "$FACET_HOME/evidence" && chmod 700 "$FACET_HOME/evidence"`,
          { mode: evidenceMode },
        ),
  );

  const lock = lockReader(paths.lock);
  if (lock === null) {
    probes.push(probe("service-lock", "pass", "dormant · no lock", null, { state: "dormant" }));
  } else if (lockStale(lock) || !pidAlive(lock.pid)) {
    probes.push(
      probe("service-lock", "fail", "stale or dead lock", "facet status --start", {
        pid: lock.pid,
        stale: true,
      }),
    );
  } else if (lock.contractVersion !== FACET_SCHEMA_VERSION) {
    probes.push(
      probe(
        "service-lock",
        "fail",
        `cross-version lock ${lock.contractVersion}`,
        "facet status --start",
        { contractVersion: lock.contractVersion },
      ),
    );
  } else if (options.statusCheck !== undefined && !options.statusCheck(lock)) {
    probes.push(
      probe("service-lock", "fail", "live service status request failed", "facet status --start", {
        pid: lock.pid,
      }),
    );
  } else {
    probes.push(
      probe("service-lock", "pass", `active · pid ${lock.pid}`, null, {
        pid: lock.pid,
        state: "active",
      }),
    );
  }

  return { command: "doctor", allPassed: probes.every((item) => item.status === "pass"), probes };
}
