/**
 * Stock TabardFrame as the guild emblem designer: the TabardModel methods it calls, the gate and the
 * published owner. The C API itself is FrameXmlTabard.ts.
 *
 * TabardFrame.xml loads at its retail slot after ComboFrame.xml (stock TOC line 112); the frame is
 * `parent="UIParent" hidden="true"` and a `left` UI panel (UIParent.lua:34).
 *
 * The 3D preview is not drawn. TabardModel is a Model widget whose `SetUnit("player")` would show the
 * player wearing the design; this client's model stage draws file, creature and display models
 * (FrameXmlModelPreview.ts) but has no player-with-a-composited-tabard path. The design is still
 * visible where stock shows it outside the model — the four watermark halves behind it — and every
 * control works; the model area stays empty.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlTabardModel, FrameXmlTabardProbe } from "./FrameXmlTabard.js";
import type { FrameXmlCharterOwner } from "./FrameXmlPetitionController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import {
  frameXmlNpcClean, frameXmlNpcFrames, frameXmlNpcRegistered, frameXmlNpcRendered,
  type FrameXmlNpcFrameSpec,
} from "./FrameXmlGossipGateKit.js";

const TABARD_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["TabardFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["TabardModel", "TabardModel", []],
  ["TabardFramePortrait", "Texture", []],
  ["TabardFrameNameText", "FontString", []],
  ["TabardFrameGreetingText", "FontString", []],
  ["TabardFrameEmblemTopLeft", "Texture", []],
  ["TabardFrameEmblemTopRight", "Texture", []],
  ["TabardFrameEmblemBottomLeft", "Texture", []],
  ["TabardFrameEmblemBottomRight", "Texture", []],
  ["TabardFrameCostMoneyFrame", "Frame", []],
  ["TabardFrameAcceptButton", "Button", ["OnClick"]],
  ["TabardFrameCancelButton", "Button", ["OnClick"]],
  ["TabardFrameCloseButton", "Button", ["OnClick"]],
  ...[1, 2, 3, 4, 5].flatMap((id): FrameXmlNpcFrameSpec[] => [
    [`TabardFrameCustomization${id}`, "Frame", []],
    [`TabardFrameCustomization${id}LeftButton`, "Button", ["OnClick"]],
    [`TabardFrameCustomization${id}RightButton`, "Button", ["OnClick"]],
  ]),
];

/**
 * The six TabardModel methods TabardFrame calls (TabardFrame.lua:30, 79, 85, 90-93, 103; the Accept
 * button's `TabardModel:Save()`), set on the one TabardModel instance so they shadow the widget
 * layer's recorded no-ops. Each calls the hidden `WebClientTabard*` seam name (FrameXmlTabard.ts).
 */
const TABARD_MODEL_METHODS = `
local model = rawget(_G, "TabardModel")
local function seam(name) return rawget(_G, "__fxSeam_" .. name) end
local initialize, cycle, emblem = seam("WebClientTabardInitialize"), seam("WebClientTabardCycle"), seam("WebClientTabardEmblem")
local canSave, save = seam("WebClientTabardCanSave"), seam("WebClientTabardSave")
if type(model) ~= "table" or not (initialize and cycle and emblem and canSave and save) then return 0 end
local function paint(texture, half)
  if type(texture) == "table" and texture.SetTexture then texture:SetTexture(emblem(half)) end
end
model.InitializeTabardColors = function() initialize() end
model.CycleVariation = function(_, id, delta) cycle(id, delta) end
model.GetUpperEmblemTexture = function(_, texture) paint(texture, "upper") end
model.GetLowerEmblemTexture = function(_, texture) paint(texture, "lower") end
model.CanSaveTabardNow = function() return canSave() and true or false end
model.Save = function() save() end
return 1
`;

export function installFrameXmlTabardModel(boot: Pick<FrameXmlBoot, "vm">): boolean {
  const values = frameXmlSilentProbe(boot, "@webclient/tabard-model", TABARD_MODEL_METHODS, 1);
  return Number(values?.[0]) === 1;
}

/** A guild emblem to design from: never sent anywhere. */
const PROBE: FrameXmlTabardProbe = Object.freeze({
  guild: Object.freeze({ emblemStyle: 1, emblemColor: 2, borderStyle: 0, borderColor: 3, backgroundColor: 4 }),
});

export interface FrameXmlTabardGateResult {
  readonly frame: FrameXmlFrame;
}

/**
 * Structural, rendered and transactional proof that stock TabardFrame can be the designer.
 *
 * The probe runs TabardFrame_OnEvent's OPEN_TABARD_FRAME over a synthetic guild emblem (muted:
 * CloseTabardCreation and Save send nothing), requires the watermark halves to be drawn, one arrow
 * to change them, then hides the frame, with zero new Lua errors or bridge diagnostics.
 */
export function frameXmlTabardGate(
  seam: { readonly tabard?: FrameXmlTabardModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlTabardGateResult | undefined {
  try {
    const tabard = seam.tabard;
    if (!tabard) return undefined;
    const frames = frameXmlNpcFrames(boot, TABARD_FRAMES);
    const frame = frames?.get("TabardFrame");
    if (!frames || !frame || !frameXmlNpcRendered(renderer, frame)) return undefined;
    if (!frameXmlNpcRegistered(frame, ["OPEN_TABARD_FRAME", "CLOSE_TABARD_FRAME", "TABARD_CANSAVE_CHANGED", "TABARD_SAVE_PENDING"])) {
      return undefined;
    }
    if (!installFrameXmlTabardModel(boot)) return undefined;
    const probe = frameXmlNpcClean(boot, () => tabard.probe(PROBE, () =>
      frameXmlSilentProbe(boot, "webclient/tabard-gate", `
        TabardFrame_OnEvent(TabardFrame, "OPEN_TABARD_FRAME")
        local shown = TabardFrame:IsShown() and 1 or 0
        local before = TabardFrameEmblemTopLeft:GetTexture() or ""
        local lower = TabardFrameEmblemBottomRight:GetTexture() or ""
        TabardCustomization_Right(1)
        local after = TabardFrameEmblemTopLeft:GetTexture() or ""
        local canSave = TabardModel:CanSaveTabardNow() and 1 or 0
        HideUIPanel(TabardFrame)
        return shown, (before ~= "" and lower ~= "" and before ~= lower) and 1 or 0,
          (after ~= "" and after ~= before) and 1 or 0, canSave, TabardFrame:IsShown() and 1 or 0
      `, 5)));
    if (!probe) return undefined;
    const [shown, drawn, cycled, canSave, still] = probe.map((value) => Number(value));
    if (shown !== 1 || drawn !== 1 || cycled !== 1 || canSave !== 1 || still !== 0 || frame.visible) return undefined;
    return { frame };
  } catch {
    return undefined;
  }
}

export interface FrameXmlTabardMountOwner extends FrameXmlCharterOwner {
  /** Unmount: hide without CloseTabardCreation, so the native designer can repaint. */
  dispose(): void;
}

/** The published owner. Opening is the server's; the host only syncs, closes and disposes. */
export function createFrameXmlTabardOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
  tabard: FrameXmlTabardModel,
): FrameXmlTabardMountOwner {
  const hide = (): void => {
    if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(TabardFrame)", "@webclient/tabard-close");
  };
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    sync: () => tabard.sync(),
    close: hide,
    dispose: () => {
      tabard.muted(hide);
      tabard.owned = false;
    },
  };
}
