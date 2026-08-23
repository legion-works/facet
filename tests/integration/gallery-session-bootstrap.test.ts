import { describe, expect, test } from "bun:test";

import { resolveGalleryBootstrap } from "../../src/gallery-web/app";
import {
  GALLERY_SESSION_STORAGE_KEY,
  type GallerySession,
  type SessionStorageLike,
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

describe("resolveGalleryBootstrap", () => {
  test("consumes a fresh bootstrap token when the URL fragment carries one", async () => {
    const storage = new MemoryStorage();
    const exchanges: unknown[] = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      exchanges.push({ url, init });
      if (url.endsWith("/bootstrap"))
        return Response.json({
          authorization: "Bearer session-token",
          artifactId: "artifact-1",
          revisionSha: "a".repeat(64),
          lease: { leaseId: "lease-1", expiresAt: Date.now() + 60_000 },
        });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const result = await resolveGalleryBootstrap({
      location: "http://127.0.0.1:43123/gallery#bootstrap=fresh-token",
      storage,
      fetchImpl,
      validateLease: async () => true,
    });
    expect(result.outcome).toBe("bootstrapped");
    if (result.outcome === "bootstrapped") {
      expect(result.session.lease.leaseId).toBe("lease-1");
    }
    expect(storage.getItem(GALLERY_SESSION_STORAGE_KEY)).not.toBeNull();
    expect(exchanges).toHaveLength(1);
  });

  test("replaces a persisted session when a bootstrap token names a newer artifact", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      GALLERY_SESSION_STORAGE_KEY,
      JSON.stringify(
        makeSession({
          artifactId: "artifact-a",
          revisionSha: "a".repeat(64),
          lease: { leaseId: "lease-a", expiresAt: Date.now() + 60_000 },
        }),
      ),
    );
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.endsWith("/bootstrap"))
        return Response.json({
          authorization: "Bearer session-b",
          artifactId: "artifact-b",
          revisionSha: "b".repeat(64),
          lease: { leaseId: "lease-b", expiresAt: Date.now() + 60_000 },
        });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await resolveGalleryBootstrap({
      location: "http://127.0.0.1:43123/gallery#bootstrap=artifact-b-token",
      storage,
      fetchImpl,
      validateLease: async () => true,
    });

    expect(result).toMatchObject({
      outcome: "bootstrapped",
      session: { artifactId: "artifact-b", revisionSha: "b".repeat(64) },
    });
    expect(JSON.parse(storage.getItem(GALLERY_SESSION_STORAGE_KEY) ?? "{}")).toMatchObject({
      artifactId: "artifact-b",
      revisionSha: "b".repeat(64),
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe("http://127.0.0.1:43123/api/v1/gallery/release");
    const releaseHeaders = new Headers(requests[1]?.init?.headers);
    expect(releaseHeaders.get("x-gallery-lease")).toBe("lease-a");
    expect(releaseHeaders.get("x-gallery-artifact")).toBe("artifact-a");
  });

  test("maps a consumed bootstrap token 401 to the typed expired outcome", async () => {
    const result = await resolveGalleryBootstrap({
      location: "http://127.0.0.1:43123/gallery#bootstrap=consumed-token",
      storage: new MemoryStorage(),
      fetchImpl: (async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
      validateLease: async () => true,
    });
    expect(result).toEqual({ outcome: "expired", reason: "invalid" });
  });

  test("reuses a persisted session on refresh when the lease validates", async () => {
    const storage = new MemoryStorage();
    storage.setItem(GALLERY_SESSION_STORAGE_KEY, JSON.stringify(makeSession()));
    const exchanges: unknown[] = [];
    const fetchImpl = (async (input: URL | RequestInfo) => {
      exchanges.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const result = await resolveGalleryBootstrap({
      location: "http://127.0.0.1:43123/gallery",
      storage,
      fetchImpl,
      validateLease: async () => true,
    });
    expect(result.outcome).toBe("reused");
    if (result.outcome === "reused") {
      expect(result.session.artifactId).toBe("artifact-1");
    }
    expect(exchanges).toHaveLength(0);
  });

  test("reports expired when the persisted lease validation fails", async () => {
    const storage = new MemoryStorage();
    storage.setItem(GALLERY_SESSION_STORAGE_KEY, JSON.stringify(makeSession()));
    const result = await resolveGalleryBootstrap({
      location: "http://127.0.0.1:43123/gallery",
      storage,
      fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
      validateLease: async () => false,
    });
    expect(result.outcome).toBe("expired");
    if (result.outcome === "expired") {
      expect(result.reason).toBe("invalid");
    }
    // The persisted session is cleared so a retry re-collects the token.
    expect(storage.getItem(GALLERY_SESSION_STORAGE_KEY)).toBeNull();
  });

  test("reports expired when no persisted session and no token", async () => {
    const storage = new MemoryStorage();
    const result = await resolveGalleryBootstrap({
      location: "http://127.0.0.1:43123/gallery",
      storage,
      fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
      validateLease: async () => true,
    });
    expect(result.outcome).toBe("expired");
    if (result.outcome === "expired") {
      expect(result.reason).toBe("missing");
    }
  });
});
