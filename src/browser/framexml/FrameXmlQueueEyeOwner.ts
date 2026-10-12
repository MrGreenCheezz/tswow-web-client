/**
 * 3.24 (12.10): the stock queue eye's gate — MiniMapBattlefieldFrame (Minimap.xml:165-273), its tooltip
 * and MiniMapBattlefieldDropDown, all driven by BattlefieldFrame (BattlefieldFrame.lua:36-127, 204-360,
 * 586-774). Controller: FrameXmlQueueEyeController.ts; the Wintergrasp queue: FrameXmlWorldPvpQueue.ts.
 *
 * The PvP gate (FrameXmlWorldMount.ts frameXmlPvpGate) leaves BattlefieldFrame hearing only
 * UPDATE_BATTLEFIELD_STATUS. With the eye's C API in place this gate gives back the rest of what
 * BattlefieldFrame_OnLoad registered (:18-31): PLAYER_ENTERING_WORLD (the dropdown's initializer and a
 * status pass), ZONE_CHANGED/ZONE_CHANGED_NEW_AREA (CanHearthAndResurrectFromArea's «leave Wintergrasp» row,
 * :226-234) and the six BATTLEFIELD_MGR_* events (the BFMGR_* StaticPopups, :60-122).
 *
 * The eye's clicks are stock's: right button — the dropdown (leave a queue, enter a battle, leave the
 * battleground or Wintergrasp); left on a running battleground — ToggleWorldStateScoreFrame; shift-left —
 * ToggleBattlefieldMinimap (Minimap.xml:256-270).
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlWorldPvpModel } from "./FrameXmlWorldPvpQueue.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import { frameXmlNpcClean, frameXmlNpcRendered } from "./FrameXmlGossipGateKit.js";

/** What BattlefieldFrame_OnLoad registered besides the list's events and the queue status. */
export const FRAMEXML_QUEUE_EYE_EVENTS = [
  "PLAYER_ENTERING_WORLD", "ZONE_CHANGED", "ZONE_CHANGED_NEW_AREA",
  "BATTLEFIELD_MGR_QUEUE_REQUEST_RESPONSE", "BATTLEFIELD_MGR_QUEUE_INVITE", "BATTLEFIELD_MGR_ENTRY_INVITE",
  "BATTLEFIELD_MGR_EJECT_PENDING", "BATTLEFIELD_MGR_EJECTED", "BATTLEFIELD_MGR_ENTERED",
] as const;

type Status = readonly [string, string | undefined, number, number, number, number, boolean];

type GateSeam = {
  readonly worldPvp?: FrameXmlWorldPvpModel | undefined;
  battlefieldStatus(index: number): Status;
};

const PROBE_QUEUE: Status = Object.freeze(["queued", "WebClient", 0, 10, 19, 0, false] as const);
const NO_QUEUE: Status = Object.freeze(["none", undefined, 0, 0, 0, 0, false] as const);

function isButton(frame: FrameXmlFrame | undefined): frame is FrameXmlFrame {
  return frame?.type === "Button";
}

/**
 * Structural and transactional proof that the stock eye can hold the queues: the named eye with its
 * scripts, its dropdown and DropDownList1, BattlefieldFrame hearing UPDATE_BATTLEFIELD_STATUS, the BFMGR
 * dialogs defined; then, over one synthetic queued slot (the seam's status shadowed for the probe), stock's
 * tooltip pass must name the queue and the dropdown must offer LEAVE_QUEUE under the queue's title, close
 * again, and the real status be put back — no new Lua error or bridge diagnostic. Nothing is clicked.
 */
export function frameXmlQueueEyeGate(
  seam: GateSeam,
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): { readonly frame: FrameXmlFrame } | undefined {
  try {
    if (!seam.worldPvp) return undefined;
    const eye = boot.bridge.getFrame("MiniMapBattlefieldFrame");
    const dropdown = boot.bridge.getFrame("MiniMapBattlefieldDropDown");
    const list = boot.bridge.getFrame("DropDownList1");
    const battlefield = boot.bridge.getFrame("BattlefieldFrame");
    if (!isButton(eye) || !dropdown || dropdown.parent !== eye || !list || !battlefield
      || !["OnClick", "OnEnter", "OnLeave"].every((script) => boot.bridge.hasScript(eye, script))
      || !frameXmlNpcRendered(renderer, eye)
      || !battlefield.registeredEvents.has("UPDATE_BATTLEFIELD_STATUS")) return undefined;
    const shadow = seam as GateSeam & { battlefieldStatus: (index: number) => Status };
    const own = Object.prototype.hasOwnProperty.call(seam, "battlefieldStatus");
    const real = seam.battlefieldStatus;
    let probe: readonly unknown[] | undefined;
    try {
      shadow.battlefieldStatus = (index) => (index === 1 ? PROBE_QUEUE : NO_QUEUE);
      probe = frameXmlNpcClean(boot, () => frameXmlSilentProbe(boot, "webclient/queue-eye-gate", `
        local dialogs = type(StaticPopupDialogs) == "table" and StaticPopupDialogs.BFMGR_INVITED_TO_ENTER
          and StaticPopupDialogs.BFMGR_INVITED_TO_QUEUE and StaticPopupDialogs.BFMGR_CONFIRM_WORLD_PVP_QUEUED
        if not dialogs or type(MiniMapBattlefieldDropDown_Initialize) ~= "function" then return 0, 0, 1 end
        BattlefieldFrame_UpdateStatus(1)
        local tip = MiniMapBattlefieldFrame.tooltip
        local named = type(tip) == "string" and tip:find("WebClient", 1, true) ~= nil
        ToggleDropDownMenu(1, nil, MiniMapBattlefieldDropDown, "MiniMapBattlefieldFrame", 0, -5)
        local menu = DropDownList1:IsShown() and DropDownList1Button1:GetText() == "WebClient"
          and DropDownList1Button2:GetText() == LEAVE_QUEUE
        CloseDropDownMenus()
        return named and 1 or 0, menu and 1 or 0, DropDownList1:IsShown() and 1 or 0
      `, 3));
    } finally {
      if (own) shadow.battlefieldStatus = real;
      else delete (shadow as { battlefieldStatus?: unknown }).battlefieldStatus;
      // The real queues' tooltip and status back on the eye (the probe pass only touched those two).
      frameXmlSilentProbe(boot, "webclient/queue-eye-restore", "BattlefieldFrame_UpdateStatus(1)", 0);
    }
    if (!probe) return undefined;
    const [named, menu, still] = probe.map((value) => Number(value));
    if (named !== 1 || menu !== 1 || still !== 0) return undefined;
    return { frame: eye };
  } catch {
    return undefined;
  }
}

/** The world mount's one call: the gate, then BattlefieldFrame's remaining events. False when refused. */
export function mountFrameXmlQueueEye(
  seam: GateSeam,
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): boolean {
  if (!frameXmlQueueEyeGate(seam, boot, renderer)) return false;
  const battlefield = boot.bridge.getFrame("BattlefieldFrame");
  if (!battlefield) return false;
  for (const event of FRAMEXML_QUEUE_EYE_EVENTS) boot.bridge.RegisterEvent(battlefield, event);
  return true;
}
