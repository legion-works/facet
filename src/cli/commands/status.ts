/**
 * `facet status` — return revision / pin / template counts for one artifact.
 */

import { generateRequestId } from "../../shared/util/time";
import type { StatusRequest } from "../../shared/contracts/commands/requests";

export function buildStatusRequest(
  args: Readonly<Record<string, string | boolean>>,
): StatusRequest {
  const artifactId = args["artifact-id"];
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new Error("--artifact-id is required for status");
  }
  return {
    command: "status",
    requestId: generateRequestId(),
    artifactId,
  };
}
