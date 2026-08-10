import { z } from "zod";

/**
 * Every command verb the protocol recognizes. `RESERVED_COMMANDS` is empty
 * today; the reserved mechanism remains so a future verb can be described
 * by the wire schema before its handler is shipped.
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
