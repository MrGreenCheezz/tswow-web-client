/** CSS dimensions used by the two portrait canvas families. */
export const HUD_PORTRAIT_CSS_PIXELS = 58;
export const UNIT_FRAME_PORTRAIT_CSS_PIXELS = 42;

/** A browser-independent DPR value for canvas backing-store calculations. */
export function effectiveDevicePixelRatio(value: number | undefined =
  typeof window === "undefined" ? undefined : window.devicePixelRatio): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : 1;
}

/**
 * Converts a CSS portrait size to its backing-store size without reading layout.
 *
 * Reading clientWidth here would return zero for a frame hidden by `display:none`, which would
 * make a later reveal resize the WebGL target unexpectedly. The caller supplies the CSS size.
 */
export function portraitCanvasBackingPixels(cssPixels: number, dpr?: number): number {
  const css = Number.isFinite(cssPixels) && cssPixels > 0 ? cssPixels : 1;
  return Math.max(1, Math.round(css * effectiveDevicePixelRatio(dpr)));
}

/** Sets only the backing store; CSS dimensions remain owned by the stylesheet. */
export function setPortraitCanvasBackingStore(
  canvas: HTMLCanvasElement,
  cssPixels: number,
  dpr?: number,
): number {
  const pixels = portraitCanvasBackingPixels(cssPixels, dpr);
  if (canvas.width !== pixels) canvas.width = pixels;
  if (canvas.height !== pixels) canvas.height = pixels;
  return pixels;
}
