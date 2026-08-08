/**
 * `facet list` — list artifacts for a project.
 *
 * Supports optional `--slug-prefix` and `--limit` filters. The
 * service applies its own `MAX_LIST_LIMIT` cap, so the CLI does
 * NOT clamp — a too-large limit surfaces as a typed `invalid_request`
 * from the service and the envelope carries the typed code.
 */

import { generateRequestId } from "../../shared/util/time";
import type { ListRequest } from "../../shared/contracts/commands/requests";

export function buildListRequest(args: Readonly<Record<string, string | boolean>>): ListRequest {
  const projectId = args["project-id"];
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new Error("--project-id is required for list");
  }
  const slugPrefix = args["slug-prefix"];
  const limit = args["limit"];
  const limitNumber = typeof limit === "string" ? Number(limit) : undefined;
  return {
    command: "list",
    requestId: generateRequestId(),
    projectId,
    ...(typeof slugPrefix === "string" ? { slugPrefix } : {}),
    ...(limitNumber !== undefined && Number.isFinite(limitNumber) ? { limit: limitNumber } : {}),
  };
}
