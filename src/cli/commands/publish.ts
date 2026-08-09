/**
 * `facet publish` — upload a new revision.
 *
 * Source bytes come from `--file <path>` (read from disk) or from
 * stdin when `--file -` is passed or when stdin is piped. The CLI
 * NEVER imports a parser or renderer — it only base64-encodes the
 * raw bytes the user pointed at, then hands them to the service
 * via the wire contract.
 *
 * The service enforces `SOURCE_CAP_BYTES` (5 MiB) on the decoded
 * length; the CLI surfaces the typed `payload_too_large` response
 * as a normal envelope. Required flags: `--artifact-id`, `--type`,
 * and either `--file` or piped stdin.
 */

import { readFileSync } from "node:fs";

import { FacetError } from "../../shared/errors/facet-error";
import { generateRequestId } from "../../shared/util/time";
import type { PublishRequest } from "../../shared/contracts/commands/requests";
import type { ArtifactType } from "../../shared/contracts/artifact";

const VALID_TYPES: ReadonlySet<ArtifactType> = new Set(["markdown", "mermaid", "svg", "chart"]);

export interface ResolveSourceInput {
  readonly fileFlag: string | undefined;
  /** Bytes the caller has already buffered from stdin (empty when not piped). */
  readonly stdinBytes: Uint8Array;
}

export function resolveSourceBytes(input: ResolveSourceInput): Uint8Array {
  const flag = input.fileFlag;
  if (flag === undefined || flag === "-") {
    if (input.stdinBytes.length === 0) {
      throw new FacetError(
        "invalid_request",
        "publish: no source bytes — pass --file <path> or pipe bytes on stdin",
        { retryable: false, details: { reason: "no_source_bytes" } },
      );
    }
    return input.stdinBytes;
  }
  return new Uint8Array(readFileSync(flag));
}

export function buildPublishRequest(
  args: Readonly<Record<string, string | boolean>>,
  sourceBytes: Uint8Array,
): PublishRequest {
  const artifactId = args["artifact-id"];
  const type = args["type"];
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new FacetError("invalid_request", "--artifact-id is required for publish", {
      retryable: false,
    });
  }
  if (typeof type !== "string" || !VALID_TYPES.has(type as ArtifactType)) {
    throw new FacetError(
      "invalid_request",
      `--type must be one of: ${[...VALID_TYPES].join(", ")} (got '${String(type)}')`,
      { retryable: false, details: { reason: "invalid_artifact_type" } },
    );
  }
  if (sourceBytes.length === 0) {
    throw new FacetError("invalid_request", "publish bytes are empty", {
      retryable: false,
      details: { reason: "empty_bytes" },
    });
  }
  const noteValue = args["note"];
  const parentValue = args["parent-revision-id"];
  return {
    command: "publish",
    requestId: generateRequestId(),
    artifactId,
    artifactType: type as ArtifactType,
    renderer: "svg",
    bytes: Buffer.from(sourceBytes).toString("base64"),
    ...(typeof noteValue === "string" ? { note: noteValue } : {}),
    ...(typeof parentValue === "string" ? { parentRevisionId: parentValue } : {}),
  };
}
