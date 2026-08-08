/**
 * `facet instantiate` — create a new artifact from a named template.
 *
 * Input-validation errors throw `FacetError("invalid_request", ...)`
 * so the envelope preserves the typed `invalid_request` code.
 */

import { generateRequestId } from "../../shared/util/time";
import { FacetError } from "../../shared/errors/facet-error";
import type { InstantiateRequest } from "../../shared/contracts/commands/requests";

export function buildInstantiateRequest(
  args: Readonly<Record<string, string | boolean>>,
): InstantiateRequest {
  const name = args["name"];
  const newSlug = args["new-slug"];
  const promotedBy = args["promoted-by"];
  if (typeof name !== "string" || name.length === 0) {
    throw new FacetError("invalid_request", "--name is required for instantiate", {
      retryable: false,
    });
  }
  if (typeof newSlug !== "string" || newSlug.length === 0) {
    throw new FacetError("invalid_request", "--new-slug is required for instantiate", {
      retryable: false,
    });
  }
  if (typeof promotedBy !== "string" || promotedBy.length === 0) {
    throw new FacetError("invalid_request", "--promoted-by is required for instantiate", {
      retryable: false,
    });
  }
  const projectId = args["project-id"];
  return {
    command: "instantiate",
    requestId: generateRequestId(),
    name,
    newSlug,
    promotedBy,
    ...(typeof projectId === "string" ? { projectId } : {}),
  };
}
