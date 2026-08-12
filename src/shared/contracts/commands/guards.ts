import { z } from "zod";

import type { Renderer } from "../renderers";
import { FacetError } from "../../errors/facet-error";

import {
  CommandNameSchema,
  IMPLEMENTED_COMMANDS,
  RESERVED_COMMANDS,
  type CommandName,
} from "./names";
import { PublishArtifactTypeSchema } from "./requests";

export {
  CommandNameSchema,
  IMPLEMENTED_COMMANDS,
  RESERVED_COMMANDS,
  type CommandName,
  PublishArtifactTypeSchema,
};

/**
 * Returns a `reserved_not_implemented` FacetError for any reserved verb and
 * `null` for every implemented verb. The command dispatcher calls this before
 * running any handler.
 */
export function checkCommandImplemented(name: CommandName): FacetError | null {
  if ((RESERVED_COMMANDS as readonly CommandName[]).includes(name)) {
    return new FacetError(
      "reserved_not_implemented",
      `Command '${name}' is reserved and not implemented in this build`,
      { retryable: false, details: { command: name } },
    );
  }
  return null;
}

/**
 * Future reserved artifact types return `unsupported_reserved_type`; every
 * known type currently returns `null`. The publish dispatcher calls this
 * before passing bytes into the store.
 */
export function checkArtifactTypeSupported(_type: string): FacetError | null {
  return null;
}

/** Returns `invalid_request` when a renderer is incompatible with the artifact type. */
export function checkRendererSupported(
  artifactType: string,
  renderer: Renderer,
): FacetError | null {
  if (renderer === "canvas" && artifactType !== "chart") {
    return new FacetError(
      "invalid_request",
      `Renderer '${renderer}' is only supported for artifact type 'chart'`,
      { retryable: false, details: { artifactType, renderer } },
    );
  }
  return null;
}

/**
 * Returns `invalid_request` when an `interactive` execution is set on a
 * non-TSX artifact. `static` is the default and is silently accepted on
 * every type (mirroring how `renderer: "svg"` is accepted on every
 * artifact type — it is the canonical default). Callers see a typed
 * error before any service round-trip or storage write; the publish
 * dispatcher calls this before passing the request into the store.
 */
export function checkExecutionSupported(
  artifactType: string,
  execution: string | undefined,
): FacetError | null {
  if (execution === "interactive" && artifactType !== "tsx") {
    return new FacetError(
      "invalid_request",
      `Execution mode 'interactive' is only supported for artifact type 'tsx' (got '${artifactType}')`,
      { retryable: false, details: { artifactType, execution } },
    );
  }
  return null;
}

// Re-export zod here so the barrel's `import { z } from "zod"` callers
// keep working without re-importing.
export { z };
