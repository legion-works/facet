/**
 * `facet create` — register a new artifact.
 *
 * The CLI maps the public verb (`create`) to the wire command
 * (`create`) and builds a strict `CreateRequest` from the parsed
 * argv. Required flags: `--project-id`, `--slug`, `--title`. The
 * request id is minted here so the response envelope carries the
 * CLI-side correlation id (the service echoes the request id back
 * in its own envelope).
 */

import { generateRequestId } from "../../shared/util/time";
import type { CreateRequest } from "../../shared/contracts/commands/requests";

export function buildCreateRequest(
  args: Readonly<Record<string, string | boolean>>,
): CreateRequest {
  const projectId = args["project-id"];
  const slug = args["slug"];
  const title = args["title"];
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new Error("--project-id is required for create");
  }
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("--slug is required for create");
  }
  if (typeof title !== "string" || title.length === 0) {
    throw new Error("--title is required for create");
  }
  return {
    command: "create",
    requestId: generateRequestId(),
    projectId,
    slug,
    title,
  };
}
