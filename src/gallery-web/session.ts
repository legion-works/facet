/**
 * Session persistence for the gallery shell.
 *
 * The gallery's bootstrap token is single-use: once the shell exchanges
 * it for a lease, the URL fragment is dead. A tab refresh re-submits
 * the consumed token, the service rejects it, and the shell dies.
 *
 * To survive refresh, the shell persists the granted lease to
 * `sessionStorage` (same-origin, per-tab, survives F5, never reaches the
 * URL) AFTER a successful bootstrap exchange. On load the order is:
 *   1. If the URL still carries a fresh `bootstrap=…` token, exchange it.
 *   2. Otherwise, look up the persisted session and validate it against
 *      the service (cheap authed source request). A live lease re-renders
 *      the artifact exactly as before; an expired or service-restart
 *      lease renders the typed "session expired" state.
 *
 * The lease manager is in-memory: a service restart invalidates every
 * outstanding lease. The persisted session therefore reports a TTL
 * window — if the service came back within the lease's nominal expiry
 * the session is still live; otherwise it is honestly expired and the
 * shell tells the user to run `facet open` again.
 *
 * The persisted payload carries the bearer authorization plus the lease
 * id. They are scoped to the same loopback origin and never leave the
 * tab; replacing the tab closes the channel. This matches the existing
 * security rule that leases stay header-only (`X-Gallery-Lease`) and
 * never reach a URL.
 */

export const GALLERY_SESSION_STORAGE_KEY = "facet:gallery-session";

export interface GallerySession {
  readonly authorization: string;
  readonly artifactId: string;
  readonly revisionSha: string;
  readonly lease: { readonly leaseId: string; readonly expiresAt: number };
}

/**
 * Minimal `sessionStorage`-shaped surface used by the persistence helpers.
 * Production callers pass `window.sessionStorage`; tests pass an in-memory
 * shim so the helpers stay free of any browser global reference.
 */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

export function persistSession(storage: SessionStorageLike, session: GallerySession): void {
  storage.setItem(GALLERY_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(storage: SessionStorageLike): void {
  storage.removeItem(GALLERY_SESSION_STORAGE_KEY);
}

export function readPersistedSession(storage: SessionStorageLike): GallerySession | null {
  const raw = storage.getItem(GALLERY_SESSION_STORAGE_KEY);
  if (raw === null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isGallerySession(parsed)) return null;
  return parsed;
}

export type SessionValidation =
  | { readonly valid: true; readonly session: GallerySession }
  | { readonly valid: false; readonly reason: "expired" | "missing" };

export function validatePersistedSession(
  session: GallerySession,
  now: number = Date.now(),
): SessionValidation {
  if (session.lease.expiresAt <= now) return { valid: false, reason: "expired" };
  return { valid: true, session };
}

function isGallerySession(value: unknown): value is GallerySession {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record["authorization"] !== "string") return false;
  if (typeof record["artifactId"] !== "string") return false;
  if (typeof record["revisionSha"] !== "string") return false;
  const lease = record["lease"];
  if (lease === null || typeof lease !== "object") return false;
  const leaseRecord = lease as Record<string, unknown>;
  if (typeof leaseRecord["leaseId"] !== "string") return false;
  if (typeof leaseRecord["expiresAt"] !== "number") return false;
  return true;
}
