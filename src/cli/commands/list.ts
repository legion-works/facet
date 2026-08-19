/**
 * `facet list` — list artifacts for a project.
 *
 * Supports optional `--slug-prefix` and `--limit` filters. The
 * service applies its own `MAX_LIST_LIMIT` cap, so the CLI does
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
import { MAX_LIST_LIMIT } from "../../shared/config/limits";
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
  if (
    limitNumber !== undefined &&
    (!Number.isSafeInteger(limitNumber) || limitNumber < 1 || limitNumber > MAX_LIST_LIMIT)
  ) {
    throw new FacetError(
      "invalid_request",
      `--limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
      {
        retryable: false,
      },
    );
  }
  return {
    command: "list",
    requestId: generateRequestId(),
    projectId,
    ...(typeof slugPrefix === "string" ? { slugPrefix } : {}),
    ...(limitNumber !== undefined ? { limit: limitNumber } : {}),
  };
}
