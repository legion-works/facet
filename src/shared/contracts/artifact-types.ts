export const ARTIFACT_TYPES = ["markdown", "mermaid", "svg", "chart", "html"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
