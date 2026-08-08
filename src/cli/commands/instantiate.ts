/**
 * `facet instantiate` — create a new artifact from a named template.
 */

import { generateRequestId } from "../../shared/util/time";
import type { InstantiateRequest } from "../../shared/contracts/commands/requests";

export function buildInstantiateRequest(
  args: Readonly<Record<string, string | boolean>>,
): InstantiateRequest {
  const name = args["name"];
  const newSlug = args["new-slug"];
  const promotedBy = args["promoted-by"];
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("--name is required for instantiate");
  }
  if (typeof newSlug !== "string" || newSlug.length === 0) {
    throw new Error("--new-slug is required for instantiate");
  }
  if (typeof promotedBy !== "string" || promotedBy.length === 0) {
    throw new Error("--promoted-by is required for instantiate");
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
