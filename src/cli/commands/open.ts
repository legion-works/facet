/**
 * `facet open` — issue a gallery lease + frame URL for a revision.
 *
 * The frame URL does NOT carry the lease id; the lease is delivered
 * out-of-band in the response body. The CLI prints the envelope
 * verbatim and lets the adapter carry the lease to its own
 * transport.
 */

import { generateRequestId } from "../../shared/util/time";
import type { OpenRequest } from "../../shared/contracts/commands/requests";

export function buildOpenRequest(args: Readonly<Record<string, string | boolean>>): OpenRequest {
  const artifactId = args["artifact-id"];
  const revisionSha = args["revision-sha"];
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new Error("--artifact-id is required for open");
  }
  if (typeof revisionSha !== "string" || !/^[a-f0-9]{64}$/.test(revisionSha)) {
    throw new Error("--revision-sha must be a 64-char hex sha256");
  }
  return {
    command: "open",
    requestId: generateRequestId(),
    artifactId,
    revisionSha,
  };
}
