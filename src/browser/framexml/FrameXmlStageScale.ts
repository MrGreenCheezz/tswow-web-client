/**
 * 3.52: how the in-world interface's 768-unit stage is scaled to the window.
 *
 * With `transform: scale(s)` every widget was laid out — and Chrome snapped every picture to whole
 * pixels — in UI units, and only then scaled, so the edge two adjoining pictures share landed on a
 * fractional device pixel. Chrome draws a picture's edges anti-aliased: on that pixel each of the
 * two covers a fraction, the composite lets the page behind through, and every join of a stock
 * window became a thin dark line — the quest window's parchment (`QuestFramePanelTemplate`: four
 * pieces meeting at 256 units, the frame at y = -104) worst of all. Measured with headless Chrome
 * (two 128-grey pictures on black, joins at the quest window's positions): the join pixels came out
 * 96–114 at the scales 1.40625 (1080 lines), 1.265625, 1.171875 (900) and 0.9375, against 128 inside.
 *
 * `zoom` lays the stage out at its drawn size instead, so the snapping happens in device pixels and
 * two pictures that share an edge in UI units share it on the screen: every join came out 128 at all
 * four scales, centred windows (`translateX(-50%)`) included. Wow.exe has no such line either: D3D
 * rasterises each quad without edge anti-aliasing, and two quads sharing an edge cover every pixel
 * exactly once. Nothing else moves: Chrome's standardized zoom keeps `offset*` in UI units and client
 * rectangles in CSS pixels (measured equal to the transform's), which is what the renderer's
 * conversions and the sibling-anchor offset chain read; `isolation` keeps the stacking context the
 * transform made, so the ADD-blended pictures still blend inside the interface.
 */
export function scaleFrameXmlStage(stage: HTMLElement, scale: number): void {
  stage.style.zoom = String(scale);
  stage.style.transform = "";
  stage.style.isolation = "isolate";
}
