/**
 * `facet read-back` — fetch a verdict for a revision.
 *
 * The public tier surface is `0 | 1 | "visual"`; the CLI accepts the
 * same. The service normalizes "visual" to 1 via
 * `normalizeReadBackTier`. Default tier when omitted is 0 (the
 * browser-free parser path).
 *
 * Input-validation errors throw `FacetError("invalid_request", ...)`
 * so the envelope preserves the typed `invalid_request` code.
 */

import { generateRequestId } from "../../shared/util/time";
import { FacetError } from "../../shared/errors/facet-error";
import type { ReadBackRequest } from "../../shared/contracts/commands/requests";
import type { ReadBackTier } from "../../shared/contracts/commands/_shared";

const TIER_VALUES = new Set(["0", "1", "visual"]);

function parseTier(raw: string | boolean | undefined): ReadBackTier {
  if (typeof raw !== "string") return 0;
  if (!TIER_VALUES.has(raw)) {
    throw new FacetError("invalid_request", `--tier must be one of: 0, 1, visual (got '${raw}')`, {
      retryable: false,
    });
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
    throw new FacetError("invalid_request", "--artifact-id is required for read-back", {
      retryable: false,
    });
  }
  if (
    revisionSha !== undefined &&
    (typeof revisionSha !== "string" || !/^[a-f0-9]{64}$/.test(revisionSha))
  ) {
    throw new FacetError("invalid_request", "--revision-sha must be a 64-char hex sha256", {
      retryable: false,
    });
  }
  return {
    command: "readBack",
    requestId: generateRequestId(),
    artifactId,
    ...(typeof revisionSha === "string" ? { revisionSha } : {}),
    tier: parseTier(args["tier"]),
  };
}
