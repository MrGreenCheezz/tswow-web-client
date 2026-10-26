/**
 * 26.10: how the glue stage (768 UI units tall) is scaled to the window — CSS `zoom`, as the
 * in-world interface since 3.52 (`FrameXmlStageScale.ts`).
 *
 * With `transform: scale()` Chrome snapped every picture to whole pixels in UI units and only then
 * scaled the stage, so the edge two adjoining pictures share landed between device pixels and drew
 * as a line: the login fields' Backdrop showed one at every join of its corners and sides (the
 * owner's screenshot of 26.10). `zoom` lays the stage out at its drawn size, so the snapping happens
 * in device pixels. The vertical scale is the zoom; past 16:9 `glueStageMapping` stretches the width
 * further, and only that remainder is still a transform (its seams are vertical joins only).
 */
export function scaleGlueStage(stage: HTMLElement, scaleX: number, scaleY: number): void {
  stage.style.zoom = String(scaleY);
  const stretch = scaleX / scaleY;
  stage.style.transform = Math.abs(stretch - 1) < 1e-9 ? "" : `scale(${stretch}, 1)`;
  stage.style.transformOrigin = "top left";
  // The stacking context the transform made: the ADD-blended pictures still blend inside the stage.
  stage.style.isolation = "isolate";
}
