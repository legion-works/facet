/**
 * Canonical timestamp helper.
 *
 * Every persisted record stamps itself with `new Date().toISOString()`
 * — single source of truth so wire timestamps and DB timestamps share
 * the same shape (RFC 3339, millisecond precision, trailing `Z`).
 */

export function now(): string {
  return new Date().toISOString();
}
