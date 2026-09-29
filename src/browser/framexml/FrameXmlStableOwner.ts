/**
 * Stock PetStableFrame as the hunter's stable: SetPetStablePaperdoll's Lua half, the gate and the
 * published owner. The C API itself is FrameXmlStable.ts.
 *
 * PetStable.xml loads at its retail slot after MailFrame.xml (stock TOC line 120); the frame is
 * `parent="UIParent" hidden="true"` and a `left` UI panel (UIParent.lua:43). Its purchase dialog is
 * StaticPopup.lua's CONFIRM_BUY_STABLE_SLOT (:2725), already in the vertical.
 *
 * The 3D pet is not drawn in the full HUD. PetStableModel is a PlayerModel; SetPetStablePaperdoll
 * hands it the selected pet's creature entry through `SetCreature`, the same state the add-on
 * model stage (FrameXmlModelPreview.ts) draws from — but the world mount runs that stage only for
 * the add-ons-only presentation, so here the model box stays empty. Every slot, text, price and
 * command works without it.
 *
 * Dragging: the slots' OnDragStart lifts a pet (PickupStablePet); the DOM host dispatches no
 * OnReceiveDrag, so the drop is the next click on a slot (its OnClick runs the same ClickStablePet
 * the stock OnReceiveDrag would). The lifted pet is not drawn on the mouse cursor.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { STABLED_PET_ACTIVE, STABLED_PET_STABLED } from "../../world/StableProtocol.js";
import type { FrameXmlStableModel, FrameXmlStableProbe } from "./FrameXmlStable.js";
import type { FrameXmlStableOwner } from "./FrameXmlStableController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import {
  frameXmlNpcClean, frameXmlNpcFrames, frameXmlNpcRegistered, frameXmlNpcRendered,
  type FrameXmlNpcFrameSpec,
} from "./FrameXmlGossipGateKit.js";

const STABLE_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["PetStableFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["PetStableFramePortrait", "Texture", []],
  ["PetStableTitleLabel", "FontString", []],
  ["PetStableLevelText", "FontString", []],
  ["PetStableSlotText", "FontString", []],
  ["PetStableCostLabel", "FontString", []],
  ["PetStableModel", "PlayerModel", []],
  ["PetStablePetInfo", "Frame", ["OnEnter"]],
  ["PetStableCurrentPet", "CheckButton", ["OnClick", "OnDragStart"]],
  ...[1, 2, 3, 4].map((id): FrameXmlNpcFrameSpec => [`PetStableStabledPet${id}`, "CheckButton", ["OnClick", "OnDragStart"]]),
  ["PetStablePurchaseButton", "Button", ["OnClick"]],
  ["PetStableMoneyFrame", "Frame", []],
  ["PetStableCostMoneyFrame", "Frame", []],
  ["PetStableFrameCloseButton", "Button", ["OnClick"]],
];

/**
 * SetPetStablePaperdoll(model) (PetStable.lua:32, :100, :135, :147): the selected pet's creature on
 * the PlayerModel, cleared when there is none. Installed as a real global over the stub floor.
 */
const PAPERDOLL = `
local entry = rawget(_G, "__fxSeam_WebClientStablePaperdoll")
if not entry then return 0 end
rawset(_G, "SetPetStablePaperdoll", function(model)
  if type(model) ~= "table" then return end
  local creature = entry()
  if creature and type(model.SetCreature) == "function" then
    model:SetCreature(creature)
  elseif type(model.ClearModel) == "function" then
    model:ClearModel()
  end
end)
return 1
`;

export function installFrameXmlStablePaperdoll(boot: Pick<FrameXmlBoot, "vm">): boolean {
  const values = frameXmlSilentProbe(boot, "@webclient/stable-paperdoll", PAPERDOLL, 1);
  return Number(values?.[0]) === 1;
}

/** A stable to draw: one pet out, two stabled of three bought slots. Never sent anywhere. */
const PROBE_MASTER = 0xF13000000000FFFEn;
const PROBE: FrameXmlStableProbe = Object.freeze({
  list: Object.freeze({
    npcGuid: PROBE_MASTER,
    stableSlots: 3,
    pets: [
      Object.freeze({ petNumber: 1, creatureId: 1, level: 10, name: "WebClient", flags: STABLED_PET_ACTIVE }),
      Object.freeze({ petNumber: 2, creatureId: 2, level: 20, name: "WebClientA", flags: STABLED_PET_STABLED }),
      Object.freeze({ petNumber: 3, creatureId: 3, level: 30, name: "WebClientB", flags: STABLED_PET_STABLED }),
    ],
  }),
  pets: new Map([1, 2, 3].map((entry) => [entry, Object.freeze({
    icon: "Interface\\Icons\\INV_Misc_QuestionMark", family: "WebClient", talent: "WebClient",
  })])),
  slotPrice: 500,
});

export interface FrameXmlStableGateResult {
  readonly frame: FrameXmlFrame;
}

/**
 * Structural, rendered and transactional proof that stock PetStableFrame can be the stable.
 *
 * The probe raises PET_STABLE_SHOW over a synthetic stable (muted: no command reaches the world),
 * requires the frame shown, the second stabled pet listed and selectable, the fourth slot beyond
 * the three bought, and — unless the player's own pet is one stock refuses (PetStable.lua:45) — the
 * stabled icons drawn; then hides it, with zero new Lua errors or bridge diagnostics.
 */
export function frameXmlStableGate(
  seam: { readonly stable?: FrameXmlStableModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlStableGateResult | undefined {
  try {
    const stable = seam.stable;
    if (!stable) return undefined;
    const frames = frameXmlNpcFrames(boot, STABLE_FRAMES);
    const frame = frames?.get("PetStableFrame");
    if (!frames || !frame || !frameXmlNpcRendered(renderer, frame)) return undefined;
    if (!frameXmlNpcRegistered(frame, ["PET_STABLE_SHOW", "PET_STABLE_UPDATE", "PET_STABLE_UPDATE_PAPERDOLL",
      "PET_STABLE_CLOSED"])) return undefined;
    if (!installFrameXmlStablePaperdoll(boot)) return undefined;
    const probe = frameXmlNpcClean(boot, () => stable.probe(PROBE, () =>
      frameXmlSilentProbe(boot, "webclient/stable-gate", `
        if type(StaticPopupDialogs) ~= "table" or not StaticPopupDialogs.CONFIRM_BUY_STABLE_SLOT then return 0, 0, 0, 0, 1 end
        PetStable_OnEvent(PetStableFrame, "PET_STABLE_SHOW")
        local shown = PetStableFrame:IsShown() and 1 or 0
        local hasPetUI, isHunterPet = HasPetUI()
        local refused = UnitExists("pet") and hasPetUI and not isHunterPet
        local drawn = refused or (PetStableStabledPet2IconTexture:GetTexture() or "") ~= ""
        local function enabled(button) local value = button:IsEnabled() return value == 1 or value == true end
        local listed = select(2, GetStablePetInfo(2)) == "WebClientB" and GetStablePetInfo(3) == nil
          and enabled(PetStableStabledPet3) and not enabled(PetStableStabledPet4)
        local picked = ClickStablePet(2) and GetSelectedStablePet() == 2
        HideUIPanel(PetStableFrame)
        return shown, (drawn and listed) and 1 or 0, picked and 1 or 0, 1, PetStableFrame:IsShown() and 1 or 0
      `, 5)));
    if (!probe) return undefined;
    const [shown, drawn, picked, dialogs, still] = probe.map((value) => Number(value));
    if (shown !== 1 || drawn !== 1 || picked !== 1 || dialogs !== 1 || still !== 0 || frame.visible) return undefined;
    return { frame };
  } catch {
    return undefined;
  }
}

export interface FrameXmlStableMountOwner extends FrameXmlStableOwner {
  /** Unmount: hide without ClosePetStables, so the native rows keep the master. */
  dispose(): void;
}

/** The published owner. Opening is the server's; the host only syncs, closes and disposes. */
export function createFrameXmlStableOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
  stable: FrameXmlStableModel,
): FrameXmlStableMountOwner {
  const hide = (): void => {
    if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(PetStableFrame)", "@webclient/stable-close");
  };
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    sync: () => stable.sync(),
    close: hide,
    dispose: () => {
      stable.muted(hide);
      stable.owned = false;
    },
  };
}
