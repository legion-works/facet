export const RENDERERS = ["svg", "canvas"] as const;
export type Renderer = (typeof RENDERERS)[number];

export function isRenderer(value: unknown): value is Renderer {
  return typeof value === "string" && (RENDERERS as readonly string[]).includes(value);
}
