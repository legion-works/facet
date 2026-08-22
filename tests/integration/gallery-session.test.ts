import { describe, expect, test } from "bun:test";

import {
  persistSession,
  readPersistedSession,
  validatePersistedSession,
  type SessionStorageLike,
  type GallerySession,
} from "../../src/gallery-web/session";

class MemoryStorage implements SessionStorageLike {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

function makeSession(overrides: Partial<GallerySession> = {}): GallerySession {
  return {
    authorization: "Bearer session-token",
    artifactId: "artifact-1",
    revisionSha: "a".repeat(64),
    lease: { leaseId: "lease-1", expiresAt: Date.now() + 60_000 },
    theme: "system",
    ...overrides,
  };
}

describe("gallery session persistence", () => {
  test("persistSession writes JSON without the bearer token in a query-like shape", () => {
    const storage = new MemoryStorage();
    const session = makeSession();
    persistSession(storage, session);
    const stored = storage.getItem("facet:gallery-session");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored ?? "{}") as GallerySession;
    expect(parsed.artifactId).toBe("artifact-1");
    expect(parsed.revisionSha).toBe(session.revisionSha);
    expect(parsed.lease.leaseId).toBe("lease-1");
    expect(parsed.authorization).toBe(session.authorization);
  });

  test("readPersistedSession returns null for an empty or malformed slot", () => {
    const empty = new MemoryStorage();
    expect(readPersistedSession(empty)).toBeNull();
    const malformed = new MemoryStorage();
    malformed.setItem("facet:gallery-session", "not-json");
    expect(readPersistedSession(malformed)).toBeNull();
  });

  test("readPersistedSession returns null when fields are missing", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "facet:gallery-session",
      JSON.stringify({ artifactId: "artifact-1", revisionSha: "a".repeat(64) }),
    );
    expect(readPersistedSession(storage)).toBeNull();
  });

  test("normalizes legacy and unknown theme values to system without discarding a live lease", () => {
    const legacy = new MemoryStorage();
    const { theme: _theme, ...legacySession } = makeSession();
    legacy.setItem("facet:gallery-session", JSON.stringify(legacySession));
    expect((readPersistedSession(legacy) as unknown as { theme?: string } | null)?.theme).toBe(
      "system",
    );

    const unknown = new MemoryStorage();
    unknown.setItem("facet:gallery-session", JSON.stringify({ ...makeSession(), theme: "sepia" }));
    const restored = readPersistedSession(unknown) as unknown as {
      authorization: string;
      lease: { leaseId: string };
      theme?: string;
    } | null;
    expect(restored).not.toBeNull();
    expect(restored?.authorization).toBe("Bearer session-token");
    expect(restored?.lease.leaseId).toBe("lease-1");
    expect(restored?.theme).toBe("system");
  });

  test("round-trips each supported gallery theme mode", () => {
    for (const theme of ["system", "dark", "light"] as const) {
      const storage = new MemoryStorage();
      persistSession(storage, { ...makeSession(), theme } as unknown as GallerySession);
      expect((readPersistedSession(storage) as unknown as { theme?: string } | null)?.theme).toBe(
        theme,
      );
    }
  });

  test("validatePersistedSession accepts a session whose lease is still in the future", () => {
    const session = makeSession();
    const result = validatePersistedSession(session, Date.now());
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.session).toBe(session);
  });

  test("validatePersistedSession rejects a session whose lease has expired", () => {
    const session = makeSession({ lease: { leaseId: "lease-1", expiresAt: 1_000 } });
    const result = validatePersistedSession(session, 2_000);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("expired");
  });

  test("validatePersistedSession rejects an expired session regardless of lease values", () => {
    const session = makeSession();
    const result = validatePersistedSession(session, session.lease.expiresAt + 1);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("expired");
  });
});
