/**
 * `facet status` — return revision / pin / template counts for one artifact.
 *
 * Input-validation errors throw `FacetError("invalid_request", ...)`
 * so the envelope preserves the typed `invalid_request` code.
 */

import { generateRequestId } from "../../shared/util/time";
import { FacetError } from "../../shared/errors/facet-error";
import type { StatusRequest } from "../../shared/contracts/commands/requests";

export function buildStatusRequest(
  args: Readonly<Record<string, string | boolean>>,
): StatusRequest {
  const artifactId = args["artifact-id"];
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new FacetError("invalid_request", "--artifact-id is required for status", {
      retryable: false,
    });
  }
  return {
    command: "status",
    requestId: generateRequestId(),
    artifactId,
  };
}
