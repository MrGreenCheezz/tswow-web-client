import type { GlueLuaVm } from "../glue/GlueLua.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlMap } from "./FrameXmlMap.js";

/**
 * `WorldMapFrame.xml` does not declare the player arrow. In 3.3.5a the C client creates it when
 * `WorldMapFrame_OnLoad` calls `CreateWorldMapArrowFrame`; stock Lua then sets its alpha and level.
 * The browser owns that same child widget and uses the client's actual MinimapArrow asset.
 */
export function installFrameXmlWorldMapArrowBindings(
  vm: GlueLuaVm,
  bridge: FrameXmlUiBridge,
  map: () => FrameXmlMap | undefined,
): void {
  let arrow: FrameXmlFrame | undefined;
  let icon: FrameXmlFrame | undefined;

  vm.registerGlobal("CreateWorldMapArrowFrame", (args) => {
    const parent = bridge.resolve(args[0] as FrameXmlFrame | undefined);
    if (!parent || parent.name !== "WorldMapFrame") return [];
    arrow = bridge.getFrame("PlayerArrowEffectFrame")
      ?? bridge.CreateFrame("Frame", "PlayerArrowEffectFrame", parent);
    if (!arrow) return [];
    bridge.update(arrow, (frame) => {
      frame.setAttribute("width", "32");
      frame.setAttribute("height", "32");
    });
    icon = arrow.children.find((child) => child.type === "Texture")
      ?? bridge.createChild(arrow, "Texture", undefined, "OVERLAY");
    if (icon) {
      bridge.SetTexture(icon, "Interface\\Minimap\\MinimapArrow");
      bridge.update(icon, (texture) => {
        texture.setAttribute("width", "32");
        texture.setAttribute("height", "32");
      });
      bridge.SetPoint(icon, "CENTER", arrow, "CENTER", 0, 0);
    }
    bridge.Hide(arrow);
    return [];
  });

  vm.registerGlobal("PositionWorldMapArrowFrame", (args) => {
    if (!arrow) return [];
    const point = args[0];
    const target = args[1];
    const relativePoint = args[2];
    const x = args[3];
    const y = args[4];
    if (typeof point !== "string" || typeof target !== "string"
      || typeof relativePoint !== "string" || typeof x !== "number" || !Number.isFinite(x)
      || typeof y !== "number" || !Number.isFinite(y)) return [];
    const relativeTo = bridge.getFrame(target);
    if (!relativeTo) return [];
    const existing = arrow.points.find((entry) => entry.point === point);
    if (existing?.relativeTo !== relativeTo || existing.relativePoint !== relativePoint
      || existing.x !== x || existing.y !== y) {
      bridge.SetPoint(arrow, point, relativeTo, relativePoint, x, y);
    }
    return [];
  });

  vm.registerGlobal("ShowWorldMapArrowFrame", (args) => {
    if (!arrow) return [];
    const visible = args[0] !== undefined && args[0] !== false && args[0] !== 0;
    if (visible && !arrow.visible) bridge.Show(arrow);
    else if (!visible && arrow.visible) bridge.Hide(arrow);
    return [];
  });

  vm.registerGlobal("UpdateWorldMapArrowFrames", () => {
    const facing = map()?.playerFacing;
    if (icon && facing !== undefined && icon.textureRotation !== facing) {
      bridge.update(icon, (texture) => { texture.textureRotation = facing; });
    }
    return [];
  });
}
