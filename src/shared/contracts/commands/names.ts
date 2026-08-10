import { z } from "zod";

/**
 * Every command verb the protocol recognizes. `export` is reserved (it
 * parses cleanly here so the schema can describe the wire) but the
 * dispatcher must consult `checkCommandImplemented` and return
 * `reserved_not_implemented` before any handler logic runs.
 */
export const CommandNameSchema = z.enum([
  "create",
  "publish",
  "list",
  "readBack",
  "status",
  "open",
  "promote",
  "instantiate",
  "pin",
  "export",
]);
export type CommandName = z.infer<typeof CommandNameSchema>;

export const IMPLEMENTED_COMMANDS: readonly CommandName[] = [
  "create",
  "publish",
  "list",
  "readBack",
  "status",
  "open",
  "promote",
  "instantiate",
  "pin",
  "export",
];

export const RESERVED_COMMANDS: readonly CommandName[] = [];
