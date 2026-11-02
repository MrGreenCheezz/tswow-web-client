/** One logical viewport for CSS anchors and the original Lua GetScreen/UIParent APIs. */
export function frameXmlViewport(width: number, height: number, uiScale: number): {
  width: number; height: number; scale: number;
} {
  const scale = height / 768 * uiScale / 100;
  return { width: Math.round(width / (scale || 1)), height: Math.round(height / (scale || 1)), scale };
}
