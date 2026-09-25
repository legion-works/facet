import { generateRequestId } from "../../shared/util/time";
import { FacetError } from "../../shared/errors/facet-error";
import { MAX_LIST_LIMIT } from "../../shared/config/limits";
import type { TemplatesRequest } from "../../shared/contracts/commands/requests";

export function buildTemplatesRequest(
  args: Readonly<Record<string, string | boolean>>,
): TemplatesRequest {
  const limit = args["limit"];
  const limitNumber = typeof limit === "string" ? Number(limit) : undefined;
  if (
    limitNumber !== undefined &&
    (!Number.isSafeInteger(limitNumber) || limitNumber < 1 || limitNumber > MAX_LIST_LIMIT)
  ) {
    throw new FacetError(
      "invalid_request",
      `--limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
    );
  }
  return {
    command: "templates",
    requestId: generateRequestId(),
    ...(limitNumber === undefined ? {} : { limit: limitNumber }),
  };
}
