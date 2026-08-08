/**
 * Recursive redaction. Any property whose KEY (case-insensitive) matches
 * one of the names below has its VALUE replaced with `REDACT_PLACEHOLDER`.
 * Values themselves are NEVER inspected for substring matches — only key
 * names. This keeps accidental "value contained the word 'token'" leaks
 * out of the redaction path and makes the policy predictable.
 */

export const REDACT_PLACEHOLDER = "[REDACTED]" as const;

const REDACTED_KEYS = new Set(
  [
    "token",
    "authorization",
    "source",
    "content",
    "html",
    "svg",
    "screenshot",
    "dom",
    "console",
  ].map((k) => k.toLowerCase()),
);

function shouldRedactKey(key: string): boolean {
  return REDACTED_KEYS.has(key.toLowerCase());
}

function scrub(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shouldRedactKey(k) ? REDACT_PLACEHOLDER : scrub(v);
    }
    return out;
  }
  return value;
}

/**
 * Return a redacted deep-copy of `value`. Primitives pass through;
 * arrays and objects are walked recursively. See the file header for
 * the exact redaction policy.
 */
export function redact(value: unknown): unknown {
  return scrub(value);
}
