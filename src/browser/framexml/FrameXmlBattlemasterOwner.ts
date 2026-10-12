/**
 * 3.24 (12.10): stock BattlefieldFrame as the battlemaster's battleground list — the gate and the published
 * owner (controller: FrameXmlBattlemasterController.ts; the list and its C API: FrameXmlBattlefieldList.ts).
 *
 * BattlefieldFrame.xml is at its retail TOC slot (52) and the frame is a hidden `left` UI panel
 * (UIParent.lua:42). The PvP gate (FrameXmlWorldMount.ts frameXmlPvpGate) unregisters every event its
 * OnLoad registered (BattlefieldFrame.lua:17-34) and gives back only UPDATE_BATTLEFIELD_STATUS. Once this
 * gate passes it gives back the list's three: BATTLEFIELDS_SHOW opens the frame unless the list is an
 * arena's (`not IsBattlefieldArena()`, BattlefieldFrame.lua:40-53 — ArenaFrame takes those),
 * BATTLEFIELDS_CLOSED closes it (:54-55), PARTY_LEADER_CHANGED repaints the group button (:124-126).
 *
 * The stock list as Wow.exe draws it: the first row is always FIRST_AVAILABLE, then «<name> <instance>»
 * per GetBattlefieldInstanceInfo (:403-424); a click selects (SetSelectedBattlefield, :568-572); «Вступить»
 * and «Вступить группой» call JoinBattlefield(GetSelectedBattlefield()[, 1]) and hide the frame (:574-584),
 * whose OnHide calls CloseBattlefield (BattlefieldFrame.xml:644-648).
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { BattlefieldList } from "../../world/PvpProtocol.js";
import type { FrameXmlBattlefieldListState } from "./FrameXmlBattlefieldList.js";
import type { FrameXmlBattlemasterOwner } from "./FrameXmlBattlemasterController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import {
  frameXmlNpcClean, frameXmlNpcFrames, frameXmlNpcRendered, type FrameXmlNpcFrameSpec,
} from "./FrameXmlGossipGateKit.js";

const BATTLEMASTER_FRAMES: readonly FrameXmlNpcFrameSpec[] = [
  ["BattlefieldFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["BattlefieldFrameFrameLabel", "FontString", []],
  ...[1, 2, 3, 4, 5].map((id): FrameXmlNpcFrameSpec => [`BattlefieldZone${id}`, "Button", ["OnClick"]]),
  ["BattlefieldListScrollFrame", "ScrollFrame", []],
  ["BattlefieldFrameInfoScrollFrame", "ScrollFrame", []],
  ["BattlefieldFrameInfoScrollFrameChildFrameDescription", "FontString", []],
  ["BattlefieldFrameInfoScrollFrameChildFrameRewardsInfo", "Frame", []],
  ["BattlefieldFrameJoinButton", "Button", ["OnClick"]],
  ["BattlefieldFrameGroupJoinButton", "Button", ["OnClick"]],
  ["BattlefieldFrameCancelButton", "Button", ["OnClick"]],
  ["BattlefieldFrameCloseButton", "Button", []],
];

/** The list's events BattlefieldFrame_OnLoad registered, given back once the gate passes. */
export const FRAMEXML_BATTLEMASTER_EVENTS = ["BATTLEFIELDS_SHOW", "BATTLEFIELDS_CLOSED", "PARTY_LEADER_CHANGED"] as const;

/** A battlemaster's Warsong Gulch list with two running instances. Never sent anywhere. */
const PROBE_LIST: BattlefieldList = Object.freeze({
  battlemasterGuid: 0xF13000000000FFFDn, fromWhere: 0, bgTypeId: 2,
  hasWin: false, winHonor: 0, winArena: 0, lossHonor: 0,
  random: false, randomHasWin: false, randomWinHonor: 0, randomWinArena: 0, randomLossHonor: 0,
  instances: Object.freeze([3, 7]) as number[],
});

export interface FrameXmlBattlemasterGateResult {
  readonly frame: FrameXmlFrame;
}

type GateSeam = {
  readonly battlefieldListState?: FrameXmlBattlefieldListState | undefined;
  battlegroundCatalogReady(): boolean;
};

/**
 * Structural, rendered and transactional proof that stock BattlefieldFrame can be the battlemaster's list.
 *
 * Over a synthetic two-instance list (the seam's list swapped for the probe and restored), stock's own
 * BATTLEFIELDS_SHOW branch must open the frame titled by GetBattlefieldInfo, with FIRST_AVAILABLE and
 * «<name> 3», «<name> 7» as the three rows and the fourth hidden; a click on the last row must select it
 * (GetSelectedBattlefield() = 2); HideUIPanel must close it — with CloseBattlefield stubbed for the probe
 * so no BATTLEFIELDS_CLOSED reaches the world nor an open arena list is retired, and IsBattlefieldArena
 * answering nil so an arena battlemaster's list open at mount cannot refuse the probe — and no new Lua
 * error or bridge diagnostic. Nothing joins.
 */
export function frameXmlBattlemasterGate(
  seam: GateSeam,
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlBattlemasterGateResult | undefined {
  try {
    const state = seam.battlefieldListState;
    if (!state || !seam.battlegroundCatalogReady()) return undefined;
    const frames = frameXmlNpcFrames(boot, BATTLEMASTER_FRAMES);
    const frame = frames?.get("BattlefieldFrame");
    if (!frames || !frame || !frameXmlNpcRendered(renderer, frame)) return undefined;
    if (!frame.registeredEvents.has("UPDATE_BATTLEFIELD_STATUS")) return undefined;
    const probe = frameXmlNpcClean(boot, () => state.probe(PROBE_LIST, () =>
      frameXmlSilentProbe(boot, "webclient/battlemaster-gate", `
        local close, arena = CloseBattlefield, IsBattlefieldArena
        CloseBattlefield = function() end
        IsBattlefieldArena = function() return nil end
        local ok, shown, rows, picked = pcall(function()
          BattlefieldFrame_OnEvent(BattlefieldFrame, "BATTLEFIELDS_SHOW")
          local name = GetBattlefieldInfo()
          local shown = BattlefieldFrame:IsShown() and BattlefieldFrameFrameLabel:GetText() == name
          local rows = BattlefieldZone1:GetText() == FIRST_AVAILABLE and BattlefieldZone2:GetText() == name .. " 3"
            and BattlefieldZone3:IsShown() and BattlefieldZone3:GetText() == name .. " 7" and not BattlefieldZone4:IsShown()
            and GetNumBattlefields() == 2 and GetSelectedBattlefield() == 0
          BattlefieldZone3:Click()
          local picked = GetSelectedBattlefield() == 2
          HideUIPanel(BattlefieldFrame)
          return shown, rows, picked
        end)
        CloseBattlefield, IsBattlefieldArena = close, arena
        if not ok then error(shown, 0) end
        return shown and 1 or 0, rows and 1 or 0, picked and 1 or 0, BattlefieldFrame:IsShown() and 1 or 0
      `, 4)));
    if (!probe) return undefined;
    const [shown, rows, picked, still] = probe.map((value) => Number(value));
    if (shown !== 1 || rows !== 1 || picked !== 1 || still !== 0 || frame.visible) return undefined;
    return { frame };
  } catch {
    return undefined;
  }
}

/** The published owner: opening is the server's (BATTLEFIELDS_SHOW); the host only closes. */
export function createFrameXmlBattlemasterOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
): FrameXmlBattlemasterOwner {
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    close: () => {
      if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(BattlefieldFrame)", "@webclient/battlemaster-close");
    },
  };
}

/**
 * The world mount's one call, after the PvP gate kept the battleground page: the gate, then the list's
 * events back on BattlefieldFrame. Undefined (BattlefieldFrame stays silent, the native list stays) when
 * the gate refuses.
 */
export function mountFrameXmlBattlemaster(
  seam: GateSeam,
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlBattlemasterOwner | undefined {
  const gate = frameXmlBattlemasterGate(seam, boot, renderer);
  if (!gate) return undefined;
  for (const event of FRAMEXML_BATTLEMASTER_EVENTS) boot.bridge.RegisterEvent(gate.frame, event);
  return createFrameXmlBattlemasterOwner(boot, gate.frame);
}
