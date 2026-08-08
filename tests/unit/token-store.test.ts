/**
 * Token store tests.
 *
 * Two separate token files: install token (created at first start,
 * mode 0600) and operator promote token (NOT provisioned here —
 * absence is a typed error). The install token is rotated on demand
 * (used by the disconnect-reconnect auth rotation contract).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInstallTokenStore,
  createPromoteTokenStore,
  generateInstallToken,
} from "../../src/service/security/token-store";

const scratchDir = join(tmpdir(), `facet-token-${crypto.randomUUID()}`);

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function freshPath(name: string): string {
  mkdirSync(scratchDir, { recursive: true });
  return join(scratchDir, `${name}.token`);
}

describe("generateInstallToken", () => {
  test("produces a non-empty string of at least 32 characters", () => {
    const token = generateInstallToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  test("produces a different value each call", () => {
    const a = generateInstallToken();
    const b = generateInstallToken();
    expect(a).not.toBe(b);
  });
});

describe("createInstallTokenStore", () => {
  test("creates a 0600 file on first read", () => {
    const path = freshPath("install");
    const store = createInstallTokenStore({ tokenPath: path });
    const token = store.read();
    expect(token).not.toBeNull();
    expect(token!.length).toBeGreaterThanOrEqual(32);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).length).toBeGreaterThan(0);
    const stat = require("node:fs").statSync(path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("returns the same token on subsequent reads (stable)", () => {
    const path = freshPath("install");
    const store = createInstallTokenStore({ tokenPath: path });
    const a = store.read();
    const b = store.read();
    expect(a).toBe(b);
  });

  test("rotate() generates a new token and persists it", () => {
    const path = freshPath("install");
    const store = createInstallTokenStore({ tokenPath: path });
    const before = store.read();
    const after = store.rotate();
    expect(after).not.toBe(before);
    expect(store.read()).toBe(after);
    expect(readFileSync(path, "utf8").trim()).toBe(after);
  });

  test("tightens permissions on an existing 0644 file on first read", () => {
    const path = freshPath("install");
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(path, "preexisting-token-value-here-that-is-long-enough");
    chmodSync(path, 0o644);
    const store = createInstallTokenStore({ tokenPath: path });
    expect(store.read()).toBe("preexisting-token-value-here-that-is-long-enough");
    const stat = require("node:fs").statSync(path);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("createPromoteTokenStore", () => {
  test("exists() reports false when the file is missing", () => {
    const store = createPromoteTokenStore({ tokenPath: freshPath("promote") });
    expect(store.exists()).toBe(false);
  });

  test("exists() reports true when the file exists", () => {
    const path = freshPath("promote");
    writeFileSync(path, "promote-token", { mode: 0o600 });
    const store = createPromoteTokenStore({ tokenPath: path });
    expect(store.exists()).toBe(true);
  });

  test("read() returns null when the file is missing (absence is a state, not a generated default)", () => {
    const store = createPromoteTokenStore({ tokenPath: freshPath("promote") });
    expect(store.read()).toBeNull();
  });

  test("read() returns the persisted token when present", () => {
    const path = freshPath("promote");
    writeFileSync(path, "operator-secret", { mode: 0o600 });
    const store = createPromoteTokenStore({ tokenPath: path });
    expect(store.read()).toBe("operator-secret");
  });
});
