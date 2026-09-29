/**
 * Whether the production world route should mount the FrameXML HUD.
 *
 * The native DOM interface optionally hosts TSWoW addon widgets when enabled in settings.
 * The saved preference selects the UI. Explicit URL overrides remain useful for diagnostics.
 */
export function frameXmlFlagEnabled(search: string, savedPreference = false): boolean {
  const value = new URLSearchParams(search).get("framexml");
  return value === null ? savedPreference : value === "1";
}

/** One logical viewport for CSS anchors and the original Lua GetScreen/UIParent APIs. */
export function frameXmlViewport(width: number, height: number, uiScale: number): {
  width: number; height: number; scale: number;
} {
  const scale = height / 768 * uiScale / 100;
  return { width: Math.round(width / (scale || 1)), height: Math.round(height / (scale || 1)), scale };
}
