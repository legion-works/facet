export const OBSERVED_COUNT_KEYS = [
  "rendererRootSvgCount",
  "graphCount",
  "mermaidNodeCount",
  "visibleSvgCount",
  "opaqueRegionCount",
  "externalImageCount",
  "errorCount",
] as const;
export type ObservedCountKey = (typeof OBSERVED_COUNT_KEYS)[number];

export const HTML_OBSERVED_COUNT_KEYS = [
  "rendererRootCount",
  "headingCount",
  "tableCount",
  "listCount",
  "imageCount",
  "canvasCount",
  "externalImageCount",
] as const;
