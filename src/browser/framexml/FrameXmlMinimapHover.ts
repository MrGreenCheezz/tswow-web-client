import type { GlueLuaRef, GlueLuaVm } from "../glue/GlueLua.js";
import type { MinimapHoverHost } from "../ui/Minimap.js";

/**
 * 3.13 (07.11): the GameTooltip half of the minimap tooltip (ui/MinimapHover.ts has the rules).
 *
 * Wow.exe's CGMinimapFrame writes the tooltip from the engine (0x0057c720): GameTooltip:SetOwner(Minimap,
 * "ANCHOR_CURSOR") — anchor 8 of 0x0061eb40's list —, the text as its first line in NORMAL_FONT_COLOR (0x006201c0, the
 * colour 0x00ad2d2c is 0xffffd200), Show; Hide when nothing is under the pointer any more. The same calls from Lua, each
 * guarded so a vertical without GameTooltip or Minimap is a tooltip that does not appear rather than an error.
 */
export function compileFrameXmlMinimapHover(
  vm: Pick<GlueLuaVm, "compileFunction" | "call" | "globalString">,
): MinimapHoverHost {
  const show = vm.compileFunction(`
    if not (GameTooltip and Minimap) then return end
    local text = ...
    GameTooltip:SetOwner(Minimap, "ANCHOR_CURSOR")
    local color = NORMAL_FONT_COLOR or { r = 1.0, g = 0.82, b = 0 }
    GameTooltip:SetText(text, color.r, color.g, color.b)
    GameTooltip:Show()
  `, "webclient/minimap-hover-show", []);
  const hide = vm.compileFunction(`
    if GameTooltip then GameTooltip:Hide() end
  `, "webclient/minimap-hover-hide", []);
  const colorblind = vm.compileFunction(`
    return GetCVarBool and GetCVarBool("colorblindMode") and true or false
  `, "webclient/minimap-hover-colorblind", []);
  const run = (ref: GlueLuaRef | undefined, args: readonly unknown[] = [], results = 0): readonly unknown[] =>
    ref ? vm.call(ref, args, results) : [];
  return {
    show: (text) => { run(show, [text]); },
    hide: () => { run(hide); },
    globalString: (name) => vm.globalString(name),
    colorblind: () => run(colorblind, [], 1)[0] === true,
  };
}
