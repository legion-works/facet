import type { RenderStatus } from "../shared/contracts/validation";
import { RenderStatusSchema } from "../shared/contracts/validation";

export type FaviconTint = "teal" | "amber" | "red" | "amber-red" | "grey";

export const FAVICON_TINT_BY_STATUS = {
  ok: "teal",
  error: "red",
  "partial:layout_unverified": "amber",
  "partial:opaque_content": "amber",
  "partial:external_resources": "amber",
  "partial:unstable": "amber",
  tampered: "red",
  timeout: "red",
  shim_only: "grey",
  probe_only: "grey",
  "insecure:unvalidated": "amber-red",
} as const satisfies Record<RenderStatus, FaviconTint>;

const FAVICON_COLOR_BY_TINT: Record<FaviconTint, string> = {
  teal: "#86e1fc",
  amber: "#ffc777",
  red: "#ff6e6e",
  "amber-red": "#ff9b6e",
  grey: "#77809a",
};

export function faviconTint(state: RenderStatus | "idle" | "expired" | "unverified"): FaviconTint {
  if (!RenderStatusSchema.options.includes(state as RenderStatus)) return "grey";
  return FAVICON_TINT_BY_STATUS[state as RenderStatus];
}

export function renderFavicon(tint: FaviconTint): string | null {
  try {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.fillStyle = FAVICON_COLOR_BY_TINT[tint];
    context.font = "24px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("◆", 16, 16);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
