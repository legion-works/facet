/**
 * Payload + view-state helpers shared by the frame's two coexisting
 * entry paths (bootstrap channel + direct API). One copy instead of
 * two — divergence while both paths are installed is the drift this
 * module exists to prevent.
 */

import type { TsxExecutionMode } from "../../shared/tsx/execution";
import type { SvgViewBox } from "./view-box";

/**
 * Payload the shell sends to the frame's direct render API. Bytes are
 * always Uint8Array by the time this crosses that boundary — the
 * service delivers bytes, so a string payload here is a bug to
 * surface, not a form to accept. One definition; both the frame
 * runtime and the shell import it instead of re-declaring.
 */
export interface FrameRenderPayload {
  readonly artifactType: string;
  readonly renderer: string;
  readonly bytes: Uint8Array;
  readonly execution?: TsxExecutionMode;
}

export interface FrameViewState {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

/**
 * Whether the frame's wheel/drag gesture listeners are live. `native`
 * leaves wheel/pointer events untouched (document scroll, text
 * selection); `panzoom` installs wheel-zoom-at-cursor and drag-pan and
 * suppresses the rendered root's own pointer events so a drag can't
 * also select text or click through. Standalone diagram artifacts
 * (mermaid/svg/chart) default to `panzoom`; documents default to
 * `native` with a shell toolbar toggle — see `installGalleryFrameApi`.
 */
export const GESTURE_MODES = ["native", "panzoom"] as const;
export type GestureMode = (typeof GESTURE_MODES)[number];

export function isGestureMode(value: unknown): value is GestureMode {
  return typeof value === "string" && (GESTURE_MODES as readonly string[]).includes(value);
}

/** Cross-realm-safe — frame payloads arrive via postMessage from other realms. */
export function isUint8Array(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

export function decodePayloadBytes(bytes: Uint8Array | string): Uint8Array {
  if (typeof bytes !== "string") return new Uint8Array(bytes);
  // Base64 form (used by hosts that must embed bytes as text).
  const binary = atob(bytes);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function parseViewBox(value: string | null): SvgViewBox | null {
  if (value === null) return null;
  const values = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    values.length !== 4 ||
    values.some((entry) => !Number.isFinite(entry)) ||
    values[2]! <= 0 ||
    values[3]! <= 0
  )
    return null;
  return { minX: values[0]!, minY: values[1]!, width: values[2]!, height: values[3]! };
}

export function isFrameViewState(value: unknown): value is FrameViewState {
  if (value === null || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.zoom === "number" &&
    Number.isFinite(state.zoom) &&
    state.zoom > 0 &&
    typeof state.panX === "number" &&
    Number.isFinite(state.panX) &&
    typeof state.panY === "number" &&
    Number.isFinite(state.panY)
  );
}
