/**
 * `facet read-back` — fetch a verdict for a revision.
 *
 * The public tier surface is `0 | 1 | "visual"`; the CLI accepts the
 * same. The service normalizes "visual" to 1 via
 * `normalizeReadBackTier`. Default tier when omitted is 0 (the
 * browser-free parser path).
 */

import { generateRequestId } from "../../shared/util/time";
import type { ReadBackRequest } from "../../shared/contracts/commands/requests";
import type { ReadBackTier } from "../../shared/contracts/commands/_shared";

const TIER_VALUES = new Set(["0", "1", "visual"]);

function parseTier(raw: string | boolean | undefined): ReadBackTier {
  if (typeof raw !== "string") return 0;
  if (!TIER_VALUES.has(raw)) {
    throw new Error(`--tier must be one of: 0, 1, visual (got '${raw}')`);
  }
  if (raw === "visual") return "visual";
  return Number(raw) as 0 | 1;
}

export function buildReadBackRequest(
  args: Readonly<Record<string, string | boolean>>,
): ReadBackRequest {
  const artifactId = args["artifact-id"];
  const revisionSha = args["revision-sha"];
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new Error("--artifact-id is required for read-back");
  }
  if (typeof revisionSha !== "string" || !/^[a-f0-9]{64}$/.test(revisionSha)) {
    throw new Error("--revision-sha must be a 64-char hex sha256");
  }
  return {
    command: "readBack",
    requestId: generateRequestId(),
    artifactId,
    revisionSha,
    tier: parseTier(args["tier"]),
  };
}
