/**
 * `facet promote` — promote a revision to a named template.
 *
 * Promote requires the operator token (enforced by the service at
 * the router level — install-bearer callers receive 403). The CLI
 * does NOT inject the operator token; out-of-band provisioning is
 * the only path to a working promote, by design (ADR 0001 D4).
 */

import { generateRequestId } from "../../shared/util/time";
import type { PromoteRequest } from "../../shared/contracts/commands/requests";

export function buildPromoteRequest(
  args: Readonly<Record<string, string | boolean>>,
): PromoteRequest {
  const revisionId = args["revision-id"];
  const name = args["name"];
  const promotedBy = args["promoted-by"];
  if (typeof revisionId !== "string" || revisionId.length === 0) {
    throw new Error("--revision-id is required for promote");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("--name is required for promote");
  }
  if (typeof promotedBy !== "string" || promotedBy.length === 0) {
    throw new Error("--promoted-by is required for promote");
  }
  const artifactId = args["artifact-id"];
  const description = args["description"];
  return {
    command: "promote",
    requestId: generateRequestId(),
    revisionId,
    name,
    promotedBy,
    ...(typeof artifactId === "string" ? { artifactId } : {}),
    ...(typeof description === "string" ? { description } : {}),
  };
}
