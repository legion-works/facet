/**
 * `facet create` — register a new artifact.
 *
 * The CLI maps the public verb (`create`) to the wire command
 * (`create`) and builds a strict `CreateRequest` from the parsed
 * argv. Required flags: `--project-id`, `--slug`, `--title`. The
 * request id is minted here so the response envelope carries the
 * CLI-side correlation id (the service echoes the request id back
 * in its own envelope).
 *
 * Input-validation errors throw `FacetError("invalid_request", ...)`
 * so the envelope preserves the typed `invalid_request` code (the
 * house pattern for argv-shape failures) — the main catch recognises
 * a pre-existing FacetError and passes `toBody()` through unchanged.
 */

import { generateRequestId } from "../../shared/util/time";
import { FacetError } from "../../shared/errors/facet-error";
import type { CreateRequest } from "../../shared/contracts/commands/requests";

export function buildCreateRequest(
  args: Readonly<Record<string, string | boolean>>,
): CreateRequest {
  const projectId = args["project-id"];
  const slug = args["slug"];
  const title = args["title"];
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new FacetError("invalid_request", "--project-id is required for create", {
      retryable: false,
    });
  }
  if (typeof slug !== "string" || slug.length === 0) {
    throw new FacetError("invalid_request", "--slug is required for create", {
      retryable: false,
    });
  }
  if (typeof title !== "string" || title.length === 0) {
    throw new FacetError("invalid_request", "--title is required for create", {
      retryable: false,
    });
  }
  return {
    command: "create",
    requestId: generateRequestId(),
    projectId,
    slug,
    title,
  };
}
