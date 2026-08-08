/**
 * Canonical timestamp + id helpers.
 *
 * Every persisted record stamps itself with `new Date().toISOString()`
 * — single source of truth so wire timestamps and DB timestamps share
 * the same shape (RFC 3339, millisecond precision, trailing `Z`).
 *
 * `generateRequestId` was duplicated between the service's
 * `http-utils.ts` and the CLI; both files now import from here so the
 * format (`req-<uuid>`) cannot drift.
 */

import { randomUUID } from "node:crypto";

export function now(): string {
  return new Date().toISOString();
}

export function generateRequestId(): string {
  return `req-${randomUUID()}`;
}
