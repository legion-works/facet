import { ARTIFACT_TYPES, type ArtifactType } from "../../shared/contracts/artifact-types";
import type { Renderer } from "../../shared/contracts/artifact";
import type { LexicalCounters, TsxExecutionMode } from "../../shared/contracts/validation";

export interface WorkerInput {
  readonly schemaVersion: "facet.tier0.v2";
  readonly requestId: string;
  readonly revisionSha: string;
  readonly artifactType: ArtifactType;
  readonly renderer: Renderer;
  readonly source: Uint8Array;
  readonly lexical: LexicalCounters;
  readonly execution?: TsxExecutionMode;
}

interface WorkerInputJson {
  readonly schemaVersion?: unknown;
  readonly requestId?: unknown;
  readonly revisionSha?: unknown;
  readonly artifactType?: unknown;
  readonly renderer?: unknown;
  readonly sourceBase64?: unknown;
  readonly lexical?: unknown;
  readonly execution?: unknown;
}

export function parseWorkerInput(text: string): WorkerInput {
  const raw = JSON.parse(text) as WorkerInputJson;
  if (raw.schemaVersion !== "facet.tier0.v2") {
    throw new Error(`unknown schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (typeof raw.requestId !== "string" || raw.requestId.length === 0)
    throw new Error("invalid requestId");
  if (typeof raw.revisionSha !== "string" || !/^[a-f0-9]{64}$/.test(raw.revisionSha)) {
    throw new Error("invalid revisionSha");
  }
  if (
    typeof raw.artifactType !== "string" ||
    !ARTIFACT_TYPES.includes(raw.artifactType as ArtifactType)
  ) {
    throw new Error(`invalid artifactType: ${String(raw.artifactType)}`);
  }
  if (raw.renderer !== "svg" && raw.renderer !== "canvas") {
    throw new Error(`invalid renderer: ${String(raw.renderer)}`);
  }
  if (typeof raw.sourceBase64 !== "string") throw new Error("missing sourceBase64");
  const lexical = raw.lexical as LexicalCounters | undefined;
  if (
    lexical === undefined ||
    typeof lexical.rendererRootSvgCount !== "number" ||
    (typeof lexical.mermaidNodeCount !== "number" && lexical.mermaidNodeCount !== null) ||
    typeof lexical.visibleSvgCount !== "number"
  ) {
    throw new Error("invalid lexical counters");
  }
  const source = Uint8Array.from(Buffer.from(raw.sourceBase64, "base64"));
  const execution =
    raw.execution === "static" || raw.execution === "interactive" ? raw.execution : undefined;
  if (raw.artifactType === "tsx" && execution !== "static" && execution !== "interactive") {
    throw new Error("TSX input requires execution mode");
  }
  if (raw.artifactType !== "tsx" && raw.execution !== undefined) {
    throw new Error("execution is only valid for TSX input");
  }
  return {
    schemaVersion: "facet.tier0.v2",
    requestId: raw.requestId,
    revisionSha: raw.revisionSha,
    artifactType: raw.artifactType as ArtifactType,
    renderer: raw.renderer,
    source,
    lexical,
    ...(execution === undefined ? {} : { execution }),
  };
}
