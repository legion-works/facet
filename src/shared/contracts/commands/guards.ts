import { z } from "zod";

import { RESERVED_ARTIFACT_TYPE } from "../artifact";
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
 * Returns a `reserved_not_implemented` FacetError for any reserved verb
 * (currently just `export`) and `null` for every implemented verb. The
 * command dispatcher calls this before running any handler.
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
 * Returns `unsupported_reserved_type` for the reserved `html` artifact
 * type and `null` for every implemented type. The publish dispatcher
 * calls this before passing the bytes into the store.
 */
export function checkArtifactTypeSupported(type: string): FacetError | null {
  if (type === RESERVED_ARTIFACT_TYPE) {
    return new FacetError(
      "unsupported_reserved_type",
      `Artifact type '${type}' is reserved and not supported in this build`,
      { retryable: false, details: { artifactType: type } },
    );
  }
  return null;
}

// Re-export zod here so the barrel's `import { z } from "zod"` callers
// keep working without re-importing.
export { z };
