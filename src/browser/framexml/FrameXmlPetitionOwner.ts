/**
 * Stock PetitionFrame as the charter window (view, sign, offer, rename): the gate and the published
 * owner. The C API is FrameXmlPetition.ts.
 *
 * PetitionFrame.xml loads at its retail slot after GuildRegistrarFrame.xml (stock TOC line 114); the
 * frame is `parent="UIParent" hidden="true"` and a `left` UI panel (UIParent.lua:38). Its rename
 * dialogs are StaticPopup.lua's RENAME_GUILD/RENAME_ARENA_TEAM, already in the vertical.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlPetitionModel, FrameXmlPetitionProbe } from "./FrameXmlPetition.js";
import type { FrameXmlCharterOwner } from "./FrameXmlPetitionController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import {
  frameXmlNpcClean, frameXmlNpcFrames, frameXmlNpcRegistered, frameXmlNpcRendered,
  type FrameXmlNpcFrameSpec,
} from "./FrameXmlGossipGateKit.js";

/** PetitionFrame.xml declares nine member lines (PetitionFrameMemberName1..9). */
const PETITION_MEMBER_LINES = 9;

const PETITION_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["PetitionFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["PetitionFrameCharterTitle", "FontString", []],
  ["PetitionFrameCharterName", "FontString", []],
  ["PetitionFrameMasterTitle", "FontString", []],
  ["PetitionFrameMasterName", "FontString", []],
  ["PetitionFrameInstructions", "FontString", []],
  ["PetitionFrameNpcNameText", "FontString", []],
  ...Array.from({ length: PETITION_MEMBER_LINES }, (_, index): FrameXmlNpcFrameSpec =>
    [`PetitionFrameMemberName${index + 1}`, "FontString", []]),
  ["PetitionFrameSignButton", "Button", ["OnClick"]],
  ["PetitionFrameRequestButton", "Button", ["OnClick"]],
  ["PetitionFrameRenameButton", "Button", ["OnClick"]],
  ["PetitionFrameCancelButton", "Button", ["OnClick"]],
  ["PetitionFrameCloseButton", "Button", ["OnClick"]],
];

/** A two-signature guild charter someone else owns, one signer so far. Never sent anywhere. */
const PROBE: FrameXmlPetitionProbe = Object.freeze({
  info: Object.freeze({
    petitionId: 1, ownerGuid: 2n, name: "WebClient", minSignatures: 2, maxSignatures: 2, index: 0, arena: false,
  }),
  signatures: Object.freeze({ petitionGuid: 1n, ownerGuid: 2n, petitionId: 1, signers: [3n] }),
  names: new Map([[2n, "WebClient"], [3n, "WebClient"]]),
  self: 4n,
});

export interface FrameXmlPetitionGateResult {
  readonly frame: FrameXmlFrame;
}

/**
 * Structural, rendered and transactional proof that stock PetitionFrame can show charters: the
 * probe runs PetitionFrame's PETITION_SHOW branch (ShowUIPanel, PetitionFrame_Update) over a
 * synthetic charter, requires the charter's and owner's names, one signer and one «not yet signed»
 * line and an enabled Sign button, then hides it (muted ClosePetition), with no new Lua error or diagnostic.
 */
export function frameXmlPetitionGate(
  seam: { readonly petition?: FrameXmlPetitionModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlPetitionGateResult | undefined {
  try {
    const petition = seam.petition;
    if (!petition) return undefined;
    const frames = frameXmlNpcFrames(boot, PETITION_FRAMES);
    const frame = frames?.get("PetitionFrame");
    if (!frames || !frame || !frameXmlNpcRendered(renderer, frame)) return undefined;
    if (!frameXmlNpcRegistered(frame, ["PETITION_SHOW", "PETITION_CLOSED"])) return undefined;
    const probe = frameXmlNpcClean(boot, () => petition.probe(PROBE, () =>
      frameXmlSilentProbe(boot, "webclient/petition-gate", `
        if type(StaticPopupDialogs) ~= "table" or not StaticPopupDialogs.RENAME_GUILD then return 0, 0, 0, 0, 1 end
        ShowUIPanel(PetitionFrame)
        PetitionFrame_Update(PetitionFrame)
        local shown = PetitionFrame:IsShown() and 1 or 0
        local named = PetitionFrameCharterName:GetText() == "WebClient" and PetitionFrameMasterName:GetText() == "WebClient"
          and PetitionFrameMemberName1:GetText() == "WebClient" and PetitionFrameMemberName2:GetText() == NOT_YET_SIGNED
        local sign = PetitionFrameSignButton:IsShown() and PetitionFrameSignButton:IsEnabled() and not PetitionFrameRequestButton:IsShown()
        HideUIPanel(PetitionFrame)
        return shown, named and 1 or 0, sign and 1 or 0, 1, PetitionFrame:IsShown() and 1 or 0
      `, 5)));
    if (!probe) return undefined;
    const [shown, named, sign, dialogs, still] = probe.map((value) => Number(value));
    if (shown !== 1 || named !== 1 || sign !== 1 || dialogs !== 1 || still !== 0 || frame.visible) return undefined;
    return { frame };
  } catch {
    return undefined;
  }
}

export interface FrameXmlPetitionMountOwner extends FrameXmlCharterOwner {
  /** Unmount: hide without ClosePetition, so the native charter window can repaint. */
  dispose(): void;
}

export function createFrameXmlPetitionOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
  petition: FrameXmlPetitionModel,
): FrameXmlPetitionMountOwner {
  const hide = (): void => {
    if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(PetitionFrame)", "@webclient/petition-close");
  };
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    sync: () => petition.sync(),
    close: hide,
    dispose: () => {
      petition.muted(hide);
      petition.owned = false;
    },
  };
}
