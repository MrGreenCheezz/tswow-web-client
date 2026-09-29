/**
 * Stock MacroFrame (Blizzard_MacroUI, load-on-demand) as the macro window: its gate and its lazy
 * owner. Nothing of the add-on is read at boot; the first open loads it beside the icon list
 * (FrameXmlMacroIcons.ts) and shows MacroFrame through the client's own MacroFrame_Show.
 */

import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import {
  createFrameXmlLodWindowOwner, frameXmlLodChild, frameXmlLodSilentProbe,
  type FrameXmlLodWindowOwner,
} from "./FrameXmlMacroBindingLod.js";

export const FRAMEXML_MACRO_ADDON = "Blizzard_MacroUI";

/** MAX_ACCOUNT_MACROS and NUM_MACRO_ICONS_SHOWN in Blizzard_MacroUI.lua. */
const MACRO_BUTTONS = 36;
const MACRO_POPUP_BUTTONS = 20;

const MACRO_FRAME_CHILDREN: readonly (readonly [name: string, type: string, clickable: boolean])[] = [
  ["MacroFrameSelectedMacroButton", "CheckButton", true],
  ["MacroButtonScrollFrame", "ScrollFrame", false],
  ["MacroButtonContainer", "Frame", false],
  ["MacroFrameScrollFrame", "ScrollFrame", false],
  ["MacroFrameText", "EditBox", false],
  ["MacroFrameTextButton", "Button", true],
  ["MacroEditButton", "Button", true],
  ["MacroFrameTab1", "Button", true],
  ["MacroFrameTab2", "Button", true],
  ["MacroDeleteButton", "Button", true],
  ["MacroNewButton", "Button", true],
  ["MacroExitButton", "Button", true],
  ["MacroFrameCloseButton", "Button", true],
];

const MACRO_POPUP_CHILDREN: readonly (readonly [name: string, type: string, clickable: boolean])[] = [
  ["MacroPopupEditBox", "EditBox", false],
  ["MacroPopupScrollFrame", "ScrollFrame", false],
  ["MacroPopupOkayButton", "Button", true],
  ["MacroPopupCancelButton", "Button", true],
];

function rootFrame(boot: FrameXmlBoot, renderer: FrameXmlDomRenderer, name: string): { frame: FrameXmlFrame; element: HTMLElement } | undefined {
  const frame = boot.bridge.getFrame(name);
  const uiParent = boot.bridge.getFrame("UIParent");
  const element = frame ? renderer.elementFor(frame) : undefined;
  if (!frame || frame.type !== "Frame" || !uiParent || frame.parent !== uiParent || !element
    || element.getAttribute("data-framexml-name") !== name
    || !["OnShow", "OnHide"].every((script) => boot.bridge.hasScript(frame, script))) return undefined;
  return { frame, element };
}

/**
 * Structural, rendered and behavioural proof that stock MacroFrame can be the macro window.
 *
 * MacroFrame and MacroPopupFrame must be the named Frames under UIParent with their stock scripts;
 * the 20 icon buttons, the edit boxes, tabs and command buttons must be rendered inside them with
 * their OnClick; the seam must carry the macro model. The 36 MacroButtons are Lua's own
 * (MacroButtonContainer_OnLoad creates them while the add-on loads, under a hidden frame, so the
 * renderer draws them on the first show): they must exist inside MacroFrame with their OnClick,
 * and be drawn inside it after one silent Show — MacroFrame_OnShow runs MacroFrame_Update over the
 * real C API — which, with the Hide after it, must raise no Lua error or bridge diagnostic. Ends
 * hidden.
 */
export function frameXmlMacroGate(
  seam: Pick<FrameXmlWorldSeam, "macros">,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): FrameXmlFrame | undefined {
  try {
    if (!seam.macros) return undefined;
    const macro = rootFrame(boot, renderer, "MacroFrame");
    const popup = rootFrame(boot, renderer, "MacroPopupFrame");
    if (!macro || !popup || !boot.bridge.hasScript(macro.frame, "OnLoad")) return undefined;
    const check = (root: { frame: FrameXmlFrame; element: HTMLElement }, name: string, type: string, clickable: boolean): boolean => {
      const child = frameXmlLodChild(boot, renderer, root.frame, root.element, name, type);
      return child !== undefined && (!clickable || boot.bridge.hasScript(child, "OnClick"));
    };
    for (let index = 1; index <= MACRO_POPUP_BUTTONS; index += 1) {
      if (!check(popup, `MacroPopupButton${index}`, "CheckButton", true)) return undefined;
    }
    for (const [name, type, clickable] of MACRO_FRAME_CHILDREN) if (!check(macro, name, type, clickable)) return undefined;
    for (const [name, type, clickable] of MACRO_POPUP_CHILDREN) if (!check(popup, name, type, clickable)) return undefined;
    const buttons: FrameXmlFrame[] = [];
    for (let index = 1; index <= MACRO_BUTTONS; index += 1) {
      const button = boot.bridge.getFrame(`MacroButton${index}`);
      let ancestor = button?.parent;
      while (ancestor && ancestor !== macro.frame) ancestor = ancestor.parent;
      if (!button || button.type !== "CheckButton" || !ancestor || !boot.bridge.hasScript(button, "OnClick")) return undefined;
      buttons.push(button);
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const shown = frameXmlLodSilentProbe(boot, "webclient/macro-gate-show", ["PlaySound"],
      "MacroFrame:Show() return MacroFrame:IsShown() and 1 or 0", 1);
    renderer.sync();
    const drawn = buttons.every((button) =>
      frameXmlLodChild(boot, renderer, macro.frame, macro.element, button.name ?? "", "CheckButton") === button);
    const hidden = frameXmlLodSilentProbe(boot, "webclient/macro-gate-hide", ["PlaySound"],
      "MacroFrame:Hide() return MacroFrame:IsShown() and 1 or 0, MacroPopupFrame:IsShown() and 1 or 0", 2);
    renderer.sync();
    if (!shown || shown[0] !== 1 || !drawn || !hidden || hidden[0] !== 0 || hidden[1] !== 0
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return boot.bridge.isVisible(macro.frame) ? undefined : macro.frame;
  } catch {
    return undefined;
  }
}

/**
 * The «Символы: N/255» counter under the macro text. Two widget-layer gaps meet here: an EditBox's
 * GetNumLetters answers nil (measured: the counter printed «Символы: NaN/255»), and SetText does not
 * fire OnTextChanged, where the client fires it (so the counter kept the previous macro's count after
 * MacroFrame_Update's SetText). MacroFrameText gets a GetNumLetters of its own that counts UTF-8
 * characters, only while the widget's answers nil, and the counter is repainted after every
 * MacroFrame_Update. Retire both when the widget layer has GetNumLetters and fires OnTextChanged
 * for SetText.
 *
 * A third: the renderer never fires an EditBox's OnCursorChanged, which is where
 * ScrollingEdit_OnCursorChanged records `cursorOffset`; ScrollingEdit_OnUpdate, run by
 * OnTextChanged on every typed character, then did arithmetic on nil (UIPanelTemplates.lua:365) —
 * one Lua error per keystroke, measured. The caret starts at the top here, as it would after the
 * client's first OnCursorChanged of an empty box; the scroll does not follow it until the renderer
 * reports the caret.
 *
 * And the text's backdrop: MacroFrameTextBackground is MacroFrameScrollFrame's sibling, declared
 * after it. In the client the text is the scroll frame's scroll child, one frame level above both,
 * so it draws over the backdrop; the renderer stacks the two siblings by declaration order, and
 * the backdrop's translucent black lay over the text (measured: white text painted grey). The
 * scroll frame is put one level above the backdrop, the order the client draws them in.
 */
const MACRO_TEXT_SOURCE = `
if MacroFrameScrollFrame:GetFrameLevel() <= MacroFrameTextBackground:GetFrameLevel() then
  MacroFrameScrollFrame:SetFrameLevel(MacroFrameTextBackground:GetFrameLevel() + 1)
end
if MacroFrameText.cursorOffset == nil then
  MacroFrameText.cursorOffset = 0
  MacroFrameText.cursorHeight = 0
end
if MacroFrameText:GetNumLetters() == nil then
  MacroFrameText.GetNumLetters = function(self)
    return (select(2, string.gsub(self:GetText() or "", "[^\\128-\\191]", "")))
  end
end
hooksecurefunc("MacroFrame_Update", function()
  MacroFrameCharLimitText:SetFormattedText(MACROFRAME_CHAR_LIMIT, MacroFrameText:GetNumLetters())
end)
`;

/**
 * The lazy owner. `openNative` is the native window's open, for a failed load or gate while the
 * player is waiting; `onFailure` lets the mount record the demotion.
 */
export function createLazyFrameXmlMacroOwner(
  seam: Pick<FrameXmlWorldSeam, "macros">,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  openNative: () => void,
  onFailure?: () => void,
): FrameXmlLodWindowOwner {
  return createFrameXmlLodWindowOwner(boot, renderer, {
    addon: FRAMEXML_MACRO_ADDON,
    prepare: () => seam.macros?.loadIcons() ?? Promise.resolve(),
    gate: (gateBoot, gateRenderer) => frameXmlMacroGate(seam, gateBoot, gateRenderer),
    adopt: (adoptBoot) => {
      adoptBoot.vm.executeReported(MACRO_TEXT_SOURCE, "@webclient/macro-adopt");
    },
    showSource: "MacroFrame_Show()",
    hideSource: "HideUIPanel(MacroFrame)",
    onFailure: (wanted) => {
      onFailure?.();
      console.warn("[FrameXML macros] stock MacroFrame failed to load, gate or open; the native window stays");
      if (wanted) openNative();
    },
  });
}
