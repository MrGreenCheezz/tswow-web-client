/**
 * Plan item 3.48 (12.10): a frame's title region — `Frame:CreateTitleRegion()`, `Frame:GetTitleRegion()` and the
 * XML `<TitleRegion>` — and the drag it gives the frame, as Wow.exe 3.3.5a 12340 has them.
 *
 * Wow.exe (read-only Ghidra, .runtime/re-2026-10-11/glue-1110/a347-1…12.txt):
 * - CreateTitleRegion (0x0049e630) makes the frame's one title region (frame +0xa8, a 0xa0-byte region with vtable
 *   0x009eb2b0) when it has none and gives it the frame's visibility (0x0048a520); a frame that has one gets that
 *   one back with its points cleared (0x0048a200, ClearAllPoints). GetTitleRegion (0x0049e5b0) answers it or nil.
 *   The region's GetObjectType (vtable +0x1c, 0x004881c0) is "Region": a plain region in Lua, its methods the
 *   Region ones (SetPoint, SetAllPoints, SetWidth, Show, Hide…). It is no layered region and no child frame.
 * - The frame loader (0x004932c0) builds a new one for each `<TitleRegion>` child and loads the element into it
 *   (its own `setAllPoints`, `<Size>`, `<Anchors>`): LootFrame, MovieProgressFrame and FloatingChatFrameTemplate
 *   declare `<TitleRegion setAllPoints="true"/>`.
 * - The UI root's mouse-down (0x00495470, event 0xc) takes the frame under the mouse — the topmost one taking the
 *   mouse (+0x78), or one holding it (+0x7c) — and when it has a title region that is shown and holds the point
 *   (0x00489270: region flag 0x100, then 0x00488d40), starts moving that frame from the point (0x00494060 with mode
 *   2) and is done: no OnMouseDown, no drag registration, any button. Neither the start nor the moves
 *   (0x004945a0 → 0x00493ce0 → 0x0048abd0 case 4: the first anchor shifted by the delta) test `movable`.
 *   The mouse-up (0x004947a0, event 0xf) ends a move of mode 1 or 2 (0x0048a840) and is spent there: no
 *   OnMouseUp, no click. A frame that does not take the mouse never reaches 0x00495470, so the chat frames'
 *   (enableMouse="false") title region is inert.
 */
import type { FrameXmlFrame, FrameXmlRect } from "./FrameXmlTypes.js";

/** Frame → its title region (frame +0xa8); the region is the frame's, never one of its `children`. */
const titleRegions = new WeakMap<FrameXmlFrame, FrameXmlFrame>();

/** The frame's title region, or undefined (GetTitleRegion's nil). */
export function frameXmlTitleRegion(frame: FrameXmlFrame | undefined): FrameXmlFrame | undefined {
  return frame === undefined ? undefined : titleRegions.get(frame);
}

/** Makes `region` the frame's title region (0x0049e630 and the loader's `+0xa8` store). */
export function setFrameXmlTitleRegion(frame: FrameXmlFrame, region: FrameXmlFrame): void {
  titleRegions.set(frame, region);
}

/** What the hit test reads of the bridge: the region's visibility, the anchor walk and the cursor. */
export interface FrameXmlTitleRegionGeometry {
  isVisible(frame: FrameXmlFrame): boolean;
  geometry(frame: FrameXmlFrame): FrameXmlRect;
  effectiveScale(frame: FrameXmlFrame): number;
  readonly mousePosition: readonly [number, number];
}

/**
 * Whether the cursor (`mousePosition`, unscaled UI units, Y upward) is inside `frame`'s shown title region —
 * 0x00489270. The region is never drawn, so its box is the bridge's anchor walk, moved by where the frame itself
 * is drawn (`drawn`, the renderer's box for the frame in the same units; without it, the walk's): a region anchored
 * to its frame follows the frame wherever a drag or the screen clamp put it.
 */
export function frameXmlTitleRegionHit(
  bridge: FrameXmlTitleRegionGeometry, frame: FrameXmlFrame, drawn: FrameXmlRect | undefined,
): boolean {
  const region = frameXmlTitleRegion(frame);
  if (region === undefined || !bridge.isVisible(region)) return false;
  const regionScale = bridge.effectiveScale(region);
  const box = bridge.geometry(region);
  if (!(box.width > 0 && box.height > 0)) return false;
  const frameScale = bridge.effectiveScale(frame);
  const walked = bridge.geometry(frame);
  const dx = drawn === undefined ? 0 : drawn.left - walked.left * frameScale;
  const dy = drawn === undefined ? 0 : drawn.bottom - walked.bottom * frameScale;
  const [x, y] = bridge.mousePosition;
  return x >= box.left * regionScale + dx && x <= box.right * regionScale + dx
    && y >= box.bottom * regionScale + dy && y <= box.top * regionScale + dy;
}
