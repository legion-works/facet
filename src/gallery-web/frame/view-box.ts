export interface SvgViewBox {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface NativeViewState {
  readonly zoom: number;
  readonly panX?: number;
  readonly panY?: number;
}

export function applySvgViewBox(
  original: SvgViewBox,
  viewport: ViewportSize,
  state: NativeViewState,
): SvgViewBox {
  const zoom = state.zoom;
  const panX = state.panX ?? 0;
  const panY = state.panY ?? 0;
  return {
    minX: original.minX - (panX * original.width) / viewport.width / zoom,
    minY: original.minY - (panY * original.height) / viewport.height / zoom,
    width: original.width / zoom,
    height: original.height / zoom,
  };
}
