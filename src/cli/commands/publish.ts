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
import { ARTIFACT_TYPES } from "../../shared/contracts/artifact-types";
import { isRenderer } from "../../shared/contracts/renderers";
import { isTsxExecutionMode } from "../../shared/tsx/execution";
import { generateRequestId } from "../../shared/util/time";
import type { PublishRequest } from "../../shared/contracts/commands/requests";
import type { ArtifactType } from "../../shared/contracts/artifact";

const VALID_TYPES: ReadonlySet<ArtifactType> = new Set(ARTIFACT_TYPES);

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
  const rendererValue = args["renderer"] ?? "svg";
  if (!isRenderer(rendererValue)) {
    throw new FacetError(
      "invalid_request",
      `--renderer must be one of: svg, canvas (got '${String(rendererValue)}')`,
      { retryable: false, details: { reason: "invalid_renderer" } },
    );
  }
  const executionValue = args["execution"];
  if (
    executionValue !== undefined &&
    (typeof executionValue !== "string" || !isTsxExecutionMode(executionValue))
  ) {
    throw new FacetError(
      "invalid_request",
      `--execution must be one of: static, interactive (got '${String(executionValue)}')`,
      { retryable: false, details: { reason: "invalid_execution" } },
    );
  }
  // Mirror the dispatcher's `checkExecutionSupported` guard: an
  // explicit `interactive` execution on a non-tsx type is rejected at
  // the CLI boundary so the typed `invalid_request` surfaces before
  // any service round-trip. `static` is the canonical default and is
  // silently accepted on every type (just like `renderer: "svg"`).
  if (executionValue === "interactive" && type !== "tsx") {
    throw new FacetError(
      "invalid_request",
      `--execution interactive is only allowed with --type tsx (got '${String(type)}')`,
      { retryable: false, details: { reason: "execution_requires_tsx" } },
    );
  }
  // D2: TSX execution defaults to `static` at the CLI boundary so a
  // downstream consumer that reads the wire request never sees
  // `execution: undefined` for a tsx artifact.
  const resolvedExecution =
    executionValue === "interactive" ? "interactive" : type === "tsx" ? "static" : undefined;
  return {
    command: "publish",
    requestId: generateRequestId(),
    artifactId,
    artifactType: type as ArtifactType,
    renderer: rendererValue,
    bytes: Buffer.from(sourceBytes).toString("base64"),
    ...(typeof noteValue === "string" ? { note: noteValue } : {}),
    ...(typeof parentValue === "string" ? { parentRevisionId: parentValue } : {}),
    ...(resolvedExecution !== undefined
      ? { execution: resolvedExecution as PublishRequest["execution"] }
      : {}),
  };
}
