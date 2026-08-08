/**
 * `facet pin` — pin or unpin a revision.
 *
 * `--pinned true|false` is parsed as a boolean; anything else is a
 * usage error before the wire.
 */

import { generateRequestId } from "../../shared/util/time";
import type { PinRequest } from "../../shared/contracts/commands/requests";

function parsePinned(raw: string | boolean | undefined): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    if (raw === "true") return true;
    if (raw === "false") return false;
  }
  throw new Error("--pinned must be 'true' or 'false'");
}

export function buildPinRequest(args: Readonly<Record<string, string | boolean>>): PinRequest {
  const revisionId = args["revision-id"];
  if (typeof revisionId !== "string" || revisionId.length === 0) {
    throw new Error("--revision-id is required for pin");
  }
  return {
    command: "pin",
    requestId: generateRequestId(),
    revisionId,
    pinned: parsePinned(args["pinned"]),
  };
}
