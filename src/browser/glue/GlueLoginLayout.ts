import { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";

/**
 * The optional login module's lgzg.lua creates LoginScene, one frame per scene, and its Model
 * children at their initial width. The texture is anchored to LoginScene and follows its width;
 * the models and their parent have explicit sizes and must be resized when the display mode changes.
 * Re-running LoginScreen_OnLoad would create a second scene, models, timers and audio state.
 */
export function resizeAuthoredLoginScene(
  bridge: FrameXmlUiBridge,
  candidate: FrameXmlFrame | undefined,
  virtualWidth: number,
): boolean {
  const scene = bridge.resolve(candidate);
  const nextWidth = Math.round(virtualWidth);
  if (!scene || scene.type !== "Frame" || scene.parent?.name !== "AccountLogin"
      || !Number.isFinite(nextWidth) || nextWidth <= 0) return false;
  const previousWidth = Number(scene.attributes["width"]);
  if (!Number.isFinite(previousWidth) || previousWidth <= 0 || previousWidth === nextWidth) return false;

  // Only the module's anonymous scene groups contain anonymous Model children. Leave any other
  // frames a patch places below LoginScene to their own authored layout.
  const groups = scene.children.filter((child) => child.type === "Frame" && !child.named
    && child.children.some((model) => model.type === "Model" && !model.named));
  const ratio = nextWidth / previousWidth;
  bridge.runInMutationBatch(() => {
    bridge.update(scene, (mutable) => { mutable.setAttribute("width", String(nextWidth)); });
    for (const group of groups) {
      const groupWidth = Number(group.attributes["width"]);
      if (Number.isFinite(groupWidth) && groupWidth > 0) {
        bridge.update(group, (mutable) => { mutable.setAttribute("width", String(groupWidth * ratio)); });
      }
      for (const model of group.children) {
        if (model.type !== "Model" || model.named) continue;
        const modelWidth = Number(model.attributes["width"]);
        if (Number.isFinite(modelWidth) && modelWidth > 0) {
          bridge.update(model, (mutable) => { mutable.setAttribute("width", String(modelWidth * ratio)); });
        }
      }
    }
  });
  return true;
}
