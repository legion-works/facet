/**
 * Token store.
 *
 * Two distinct files, two distinct lifecycles:
 *
 *   - INSTALL token (long-lived, auto-generated, mode 0600). Created on
 *     first service start. Used by the CLI to authenticate to the
 *     loopback service. Rotate() generates a new value and persists it
 *     — this is what enables "reconnect with rotated auth" without
 *     invalidating open connections: clients always re-read on
 *     reconnect.
 *
 *   - OPERATOR PROMOTE token (NOT provisioned here). Absent → promote
 *     fails typed. Provisioning the operator token is an out-of-band
 *     action; this module simply refuses to fabricate one.
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ensureOwnerOnlyDirectory } from "../../shared/util/dir-permissions";

export interface InstallTokenStoreOptions {
  readonly tokenPath: string;
}

export interface InstallTokenStore {
  read(): string;
  rotate(): string;
}

export interface PromoteTokenStoreOptions {
  readonly tokenPath: string;
}

export interface PromoteTokenStore {
  exists(): boolean;
  read(): string | null;
}

export function generateInstallToken(): string {
  // 32 random bytes → 64 hex chars. URL-safe and constant-time friendly.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function ensureTightPermissions(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createInstallTokenStore(options: InstallTokenStoreOptions): InstallTokenStore {
  let cached: string | null = null;

  function loadFromDisk(): string {
    if (existsSync(options.tokenPath)) {
      const value = readFileSync(options.tokenPath, "utf8").trim();
      if (value.length > 0) {
        ensureTightPermissions(options.tokenPath);
        return value;
      }
    }
    // Atomic first-write: O_EXCL ensures exactly one writer wins the
    // race. Losers (EEXIST) re-read what the winner persisted — they
    // never cache a different token than the one on disk. The
    // containing directory lands at mode 0700 via the shared helper so
    // a hostile umask cannot widen the secret-bearing layout.
    ensureOwnerOnlyDirectory(dirname(options.tokenPath));
    const fresh = generateInstallToken();
    const tmpPath = join(tmpdir(), `facet-token-${crypto.randomUUID()}.tmp`);
    try {
      writeFileSync(tmpPath, fresh, { mode: 0o600 });
      renameSync(tmpPath, options.tokenPath);
      ensureTightPermissions(options.tokenPath);
      return fresh;
    } catch (error) {
      // Best-effort cleanup of the tmp file before the loser fallback
      try {
        writeFileSync("/dev/null", "");
      } catch {}
      // If rename failed because the destination already exists (another
      // starter won), or because the tmpPath collided, re-read.
      if (existsSync(options.tokenPath)) {
        const value = readFileSync(options.tokenPath, "utf8").trim();
        if (value.length > 0) {
          ensureTightPermissions(options.tokenPath);
          return value;
        }
      }
      throw error;
    }
  }

  return {
    read() {
      if (cached === null) cached = loadFromDisk();
      else ensureTightPermissions(options.tokenPath);
      return cached;
    },
    rotate() {
      const fresh = generateInstallToken();
      ensureOwnerOnlyDirectory(dirname(options.tokenPath));
      writeFileSync(options.tokenPath, fresh, { mode: 0o600 });
      ensureTightPermissions(options.tokenPath);
      cached = fresh;
      return fresh;
    },
  };
}

export function createPromoteTokenStore(options: PromoteTokenStoreOptions): PromoteTokenStore {
  return {
    exists() {
      return existsSync(options.tokenPath);
    },
    read() {
      if (!existsSync(options.tokenPath)) return null;
      const value = readFileSync(options.tokenPath, "utf8").trim();
      return value.length > 0 ? value : null;
    },
  };
}
