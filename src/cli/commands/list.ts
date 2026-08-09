/**
 * `facet list` — list artifacts for a project.
 *
 * Supports optional `--slug-prefix` and `--limit` filters. The
 * service applies its own 500-item cap, so the CLI does
 * NOT clamp — a too-large limit surfaces as a typed `invalid_request`
 * from the service and the envelope carries the typed code.
 *
 * Input-validation errors throw `FacetError("invalid_request", ...)`
 * so the envelope preserves the typed `invalid_request` code; the
 * main catch recognises a pre-existing FacetError and passes its
 * body through unchanged.
 */

import { generateRequestId } from "../../shared/util/time";
import { FacetError } from "../../shared/errors/facet-error";
import type { ListRequest } from "../../shared/contracts/commands/requests";

export function buildListRequest(args: Readonly<Record<string, string | boolean>>): ListRequest {
  const projectId = args["project-id"];
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new FacetError("invalid_request", "--project-id is required for list", {
      retryable: false,
    });
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
