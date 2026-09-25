import type { RenderStatus } from "./validation";

export const PROMOTION_GATE = {
  ok: "allow",
  error: "refuse",
  "partial:layout_unverified": "allow",
  "partial:opaque_content": "allow",
  "partial:external_resources": "allow",
  "partial:unstable": "allow",
  "partial:empty_render": "refuse",
  tampered: "refuse",
  timeout: "refuse",
  shim_only: "refuse",
  probe_only: "refuse",
  "insecure:unvalidated": "refuse",
} as const satisfies Record<RenderStatus, "allow" | "refuse">;
