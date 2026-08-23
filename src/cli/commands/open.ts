/**
 * `facet open` — issue a gallery lease + frame URL for a revision.
 *
 * The frame URL does NOT carry the lease id; the lease is delivered
 * out-of-band in the response body. The CLI prints the envelope
 * verbatim and lets the adapter carry the lease to its own
 * transport.
 *
 * Input-validation errors throw `FacetError("invalid_request", ...)`
 * so the envelope preserves the typed `invalid_request` code.
 */

import { generateRequestId } from "../../shared/util/time";
import { FacetError } from "../../shared/errors/facet-error";
import type { OpenRequest } from "../../shared/contracts/commands/requests";
import { spawn } from "node:child_process";

export type OpenLauncher = (url: string) => void | Promise<void>;

export interface DisplayOpenResult {
  readonly frameUrl: string;
  readonly installToken?: string;
}

function launchWithXdgOpen(url: string): void {
  const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function launchDisplay(
  result: DisplayOpenResult,
  launcher: OpenLauncher = launchWithXdgOpen,
): Promise<boolean> {
  if (result.installToken !== undefined && result.frameUrl.includes(result.installToken)) {
    throw new FacetError("invalid_envelope", "Display URL contains the install token", {
      retryable: false,
    });
  }
  const parsed = new URL(result.frameUrl);
  if (parsed.hostname !== "127.0.0.1") {
    throw new FacetError("invalid_envelope", "Display URL must be loopback-only", {
      retryable: false,
    });
  }
  try {
    await launcher(result.frameUrl);
    return true;
  } catch {
    return false;
  }
}

export function buildOpenRequest(args: Readonly<Record<string, string | boolean>>): OpenRequest {
  const artifactId = args["artifact-id"];
  const revisionSha = args["revision-sha"];
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new FacetError("invalid_request", "--artifact-id is required for open", {
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
    command: "open",
    requestId: generateRequestId(),
    artifactId,
    ...(revisionSha === undefined ? {} : { revisionSha }),
  };
}
