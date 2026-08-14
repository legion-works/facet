/**
 * Per-frame nonce for the Tier 1 verification harness.
 *
 * Cryptographically random; the harness pins it into the CSP meta and
 * the <script nonce> for the same srcdoc so only that inlined bundle
 * executes. A regression that reuses a nonce across builds would let a
 * stale bundle survive a CSP bypass attempt.
 *
 * Kept separate from gallery-web so the gallery frame bundle cannot
 * accidentally pull in any Tier 1 import.
 */

export function freshHarnessNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
