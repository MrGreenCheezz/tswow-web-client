/**
 * Stock StaticPopup dialogs and ReadyCheckFrame as the owners of the server's confirmations: the
 * post-load adapters, the gate and the published owner. The C API and the events are
 * FrameXmlPopups.ts.
 *
 * StaticPopup.xml (retail TOC slot after AutoComplete.xml) and ReadyCheck.xml (after VoiceChat.xml)
 * are already in FRAMEXML_VERTICAL_TOC — the trainer and the LFD boot/continue dialogs use them —
 * so owning the confirmations adds no file, byte or widget to the corpus: four StaticPopup frames,
 * ReadyCheckFrame and UIParent's event branches were loaded and dormant.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlPopupsModel } from "./FrameXmlPopups.js";
import { FRAMEXML_POPUPS_EVENTS } from "./FrameXmlPopups.js";
import type { FrameXmlPopupsOwner } from "./FrameXmlPopupsController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import { FRAMEXML_HOST_HOOK_GLOBAL, withFrameXmlHostHooks } from "./FrameXmlHostHooks.js"; // L5b 3.27

/** `STATICPOPUP_NUMDIALOGS` (StaticPopup.lua:1). */
export const FRAMEXML_STATIC_POPUP_COUNT = 4;

/** Every StaticPopupDialogs entry the model's events show; the gate requires each to exist. */
export const FRAMEXML_POPUPS_DIALOGS: readonly string[] = Object.freeze([
  "PARTY_INVITE", "DUEL_REQUESTED", "DUEL_OUTOFBOUNDS", "RESURRECT", "RESURRECT_NO_SICKNESS",
  "RESURRECT_NO_TIMER", "DEATH", "RECOVER_CORPSE", "RECOVER_CORPSE_INSTANCE", "CONFIRM_SUMMON",
  "GUILD_INVITE", "ARENA_TEAM_INVITE", "TRADE", "CAMP", "QUIT", "CONFIRM_BATTLEFIELD_ENTRY", "XP_LOSS",
  "XP_LOSS_NO_DURABILITY", "XP_LOSS_NO_SICKNESS", "XP_LOSS_NO_SICKNESS_NO_DURABILITY", "DELETE_ITEM",
  "DELETE_GOOD_ITEM", "CONFIRM_BINDER", "CONFIRM_TALENT_WIPE", "INSTANCE_LOCK",
]);

/** ReadyCheck.xml's named frames, their widget type and the scripts the flow runs. */
const READY_CHECK_FRAMES: readonly (readonly [name: string, type: string, scripts: readonly string[]])[] = [
  ["ReadyCheckFrame", "Frame", ["OnLoad", "OnEvent", "OnHide"]],
  ["ReadyCheckListenerFrame", "Frame", ["OnShow"]],
  ["ReadyCheckFrameYesButton", "Button", ["OnClick"]],
  ["ReadyCheckFrameNoButton", "Button", ["OnClick"]],
];

function frameDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  let current: FrameXmlFrame | undefined = frame;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function dataAttribute(element: HTMLElement, name: string): string | null {
  const value = element.getAttribute(name);
  if (value !== null) return value;
  const key = name.slice(5).replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
  return element.dataset?.[key] ?? null;
}

function renderedFrameElement(element: HTMLElement | undefined, frame: FrameXmlFrame): element is HTMLElement {
  return !!element && dataAttribute(element, "data-framexml-name") === frame.name
    && dataAttribute(element, "data-framexml-type") === frame.type;
}

/**
 * Whether stock would show CONFIRM_BATTLEFIELD_ENTRY: BattlefieldFrame loaded with its OnEvent and
 * UPDATE_BATTLEFIELD_STATUS registered — the only route to that dialog (BattlefieldFrame.lua:21/289;
 * UIParent does not register the event). Asked live, not once: the PvP gate keeps BattlefieldFrame
 * as a hidden closure with every event unregistered (FrameXmlWorldMount.ts frameXmlPvpGate), which
 * on the rich route measured `registeredEvents` empty after mount, so the native «Войти в бой» row
 * must keep the invitation — and a later owner that registers the event hands it to stock.
 */
export function frameXmlPopupsBattlefieldEntryReady(bridge: Pick<FrameXmlBoot["bridge"], "getFrame" | "hasScript">): boolean {
  const battlefield = bridge.getFrame("BattlefieldFrame");
  return !!battlefield && battlefield.type === "Frame" && bridge.hasScript(battlefield, "OnEvent")
    && battlefield.registeredEvents.has("UPDATE_BATTLEFIELD_STATUS");
}

/**
 * Five after-load adapters, each where stock leans on something only the C side of the client
 * knows. Answers how many were installed (5 on the stock corpus).
 *
 * - CAMP and QUIT count the server's twenty seconds from the grant. Stock sets `timeleft` to the
 *   dialog's `timeout` (20) when it opens (StaticPopup.lua:3242); PLAYER_CAMPING/PLAYER_QUITING can
 *   reach a freshly published popup owner mid-countdown, so an OnShow — neither has one in stock —
 *   resets it to what is left of the server's clock. One adapter each.
 * - ShowReadyCheck (ReadyCheck.lua:11) takes the initiator's *name* and asks UnitIsUnit and
 *   SetPortraitTexture about it; the client resolves group members' names as units and the seam's
 *   unit functions do not. The wrapper runs stock's own initiator branch for the player who
 *   started the check (no listener, no chime), shows nothing again to a player who already
 *   answered on either surface (FrameXmlPopupsAnswered.ts), and otherwise runs stock and points
 *   the portrait at the initiator's unit token. It reads the role and the unit through the
 *   globals on every call, so the gate's probe can stand in a world with no check running.
 * - StaticPopup_Resize sizes a dialog from `text:GetHeight()` right after SetFormattedText
 *   (StaticPopup.lua:2922). The text is 290 wide and 0 high — auto height, the wrapped lines — and
 *   the bridge's answer at Show is not the wrapped height: measured 0 on the rich route (every
 *   dialog opened 61 high, its text under the buttons), and in node now 12 — one unwrapped line —
 *   for a 348-wide string; the renderer's measure a frame later is right (12 for one line, 24 for
 *   two). Whenever the text's measured height changes, the dialog is resized
 *   again, as stock's own DISPLAY_SIZE_CHANGED handler does (StaticPopup_OnEvent) — the dialogs
 *   whose text OnUpdate fills in later (CONFIRM_SUMMON, DEATH, CAMP: " " at Show) and XP_LOSS's
 *   second question included. One GetHeight per shown dialog per frame. Retire it once
 *   FontString:GetHeight measures wrapped text when it is set.
 * - A group invitation that cannot be accepted (SMSG_GROUP_INVITE canAccept 0) is a chat line in
 *   the client, ERR_INVITED_ALREADY_IN_GROUP_SS; a hidden frame prints it on the model's private
 *   WEBCLIENT_PARTY_INVITE_REFUSED event through the stock DEFAULT_CHAT_FRAME, in the SYSTEM colour.
 */
export function installFrameXmlPopupsAdapters(boot: Pick<FrameXmlBoot, "vm" | "bridge">): number { // L5b 3.27: bridge
  // L5b 3.27: the text measure's hooks are the host's (FrameXmlHostHooks.ts): an add-on's SetScript keeps them.
  const installed = withFrameXmlHostHooks(boot, () => frameXmlSilentProbe(boot, "webclient/popups-adapters", `
    local installed = 0
    local campLeft = WebClientCampTimeLeft
    for _, which in ipairs({ "CAMP", "QUIT" }) do
      local dialog = type(StaticPopupDialogs) == "table" and StaticPopupDialogs[which] or nil
      if type(dialog) == "table" and dialog.OnShow == nil and type(campLeft) == "function" then
        dialog.OnShow = function(self)
          local left = campLeft()
          if left ~= nil then self.timeleft = left end
        end
        installed = installed + 1
      end
    end
    local stockShow = ShowReadyCheck
    if type(stockShow) == "function" and ReadyCheckFrame and ReadyCheckListenerFrame
      and type(WebClientReadyCheckRole) == "function" and type(WebClientReadyCheckUnit) == "function" then
      ShowReadyCheck = function(initiator, timeLeft)
        local role, unitOf = WebClientReadyCheckRole, WebClientReadyCheckUnit
        local mine = type(role) == "function" and role() or nil
        if initiator and mine == "initiator" then
          ReadyCheckFrame.initiator = "player"
          ReadyCheckFrame:Show()
          ReadyCheckListenerFrame:Hide()
          return
        end
        if mine == "answered" then return end
        stockShow(initiator, timeLeft)
        local unit = type(unitOf) == "function" and unitOf() or nil
        if unit and ReadyCheckListenerFrame:IsShown() then SetPortraitTexture(ReadyCheckPortrait, unit) end
      end
      installed = installed + 1
    end
    local resize = StaticPopup_Resize
    if type(resize) == "function" and _G.StaticPopup1 and _G.StaticPopup1.HookScript then
      for index = 1, STATICPOPUP_NUMDIALOGS or 0 do
        local dialog = _G["StaticPopup" .. index]
        local text = _G["StaticPopup" .. index .. "Text"]
        ${FRAMEXML_HOST_HOOK_GLOBAL}(dialog, "OnShow", function(self) self.webclientTextHeight = nil end) -- L5b 3.27 (was dialog:HookScript)
        ${FRAMEXML_HOST_HOOK_GLOBAL}(dialog, "OnUpdate", function(self) -- L5b 3.27 (was dialog:HookScript)
          if not self.which then return end
          local height = text:GetHeight()
          if height <= 0 or height == self.webclientTextHeight then return end
          -- The first measurement replaces the height stock took from an unmeasured text; later
          -- ones keep stock's grow-only maxHeightSoFar, as its own OnUpdate re-sizes do.
          if self.webclientTextHeight == nil then self.maxHeightSoFar = 0 end
          self.webclientTextHeight = height
          resize(self, self.which)
        end)
      end
      installed = installed + 1
    end
    if type(CreateFrame) == "function" then
      local refused = CreateFrame("Frame")
      refused:RegisterEvent("WEBCLIENT_PARTY_INVITE_REFUSED")
      refused:SetScript("OnEvent", function(_, _, inviter)
        local info = ChatTypeInfo and ChatTypeInfo["SYSTEM"]
        if DEFAULT_CHAT_FRAME and info and ERR_INVITED_ALREADY_IN_GROUP_SS and inviter then
          DEFAULT_CHAT_FRAME:AddMessage(format(ERR_INVITED_ALREADY_IN_GROUP_SS, inviter, inviter),
            info.r, info.g, info.b, info.id)
        end
      end)
      installed = installed + 1
    end
    return installed
  `, 1)); // L5b 3.27: withFrameXmlHostHooks
  return Number(installed?.[0] ?? 0);
}

export interface FrameXmlPopupsGateResult {
  /** StaticPopup1..4 as loaded. */
  readonly dialogs: readonly FrameXmlFrame[];
  readonly readyCheck: FrameXmlFrame;
  /** Measured by the probe: the dialog text PARTY_INVITE formatted with the probe's name. */
  readonly inviteText: string;
  /**
   * `frameXmlPopupsBattlefieldEntryReady` when the gate ran. The published owner asks it again on
   * every use; false keeps the native «Войти в бой» row while the rest of the dialogs are stock's.
   */
  readonly battlefieldEntry: boolean;
}

/**
 * Structural, rendered and transactional proof that stock can own the confirmations.
 *
 * The four StaticPopup frames must be hidden Frames under UIParent with their OnShow, OnHide and
 * OnUpdate, each with Button1/Button2 carrying OnClick, all rendered; every dialog the model can
 * show must be in StaticPopupDialogs; UIParent must have registered every event the model fires
 * that stock shows a dialog for, and ReadyCheckFrame READY_CHECK/READY_CHECK_FINISHED. A silent,
 * muted probe (no sound, no packet) then shows PARTY_INVITE, DEATH and CONFIRM_SUMMON — which read
 * GetReleaseTimeRemaining, HasSoulstone, IsActiveBattlefieldArena, GetSummonConfirmTimeLeft/
 * AreaName/Summoner and PlayerCanTeleport through the new bindings — and a ready check through the
 * wrapped ShowReadyCheck, hides them all, and must end with no dialog up, no new Lua error and no
 * bridge diagnostic. CAMP and QUIT are deliberately not probed: their OnHide would ask CancelLogout.
 *
 * The probe proves the dialogs, not the moment it runs in: StaticPopup_Show refuses a dialog
 * without `whileDead` to a dead or ghost player and one without `interruptCinematic` during a
 * cinematic (StaticPopup.lua:2949-2961), and the ShowReadyCheck adapter answers the live check's
 * role. A mount after a /reload while dead, or while a ready check the player started or already
 * answered is running, failed the gate for the rest of that session (measured by the review's
 * probe) — so for the probe's length UnitIsDeadOrGhost, InCinematic and the two ready-check
 * accessors answer "no one, nothing running", and are restored raw, as they were, whatever the
 * probe does.
 */
export function frameXmlPopupsGate(
  seam: { readonly popups?: FrameXmlPopupsModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlPopupsGateResult | undefined {
  try {
    const popups = seam.popups;
    if (!popups) return undefined;
    const uiParent = boot.bridge.getFrame("UIParent");
    if (!uiParent) return undefined;
    const dialogs: FrameXmlFrame[] = [];
    for (let index = 1; index <= FRAMEXML_STATIC_POPUP_COUNT; index += 1) {
      const dialog = boot.bridge.getFrame(`StaticPopup${index}`);
      if (!dialog || dialog.type !== "Frame" || dialog.parent?.name !== "UIParent" || dialog.visible
        || !["OnShow", "OnHide", "OnUpdate"].every((script) => boot.bridge.hasScript(dialog, script))
        || !renderedFrameElement(renderer.elementFor(dialog), dialog)) return undefined;
      for (const suffix of ["Button1", "Button2"]) {
        const button = boot.bridge.getFrame(`StaticPopup${index}${suffix}`);
        if (!button || button.type !== "Button" || !frameDescendsFrom(button, dialog)
          || !boot.bridge.hasScript(button, "OnClick")) return undefined;
      }
      dialogs.push(dialog);
    }
    const readyFrames = new Map<string, FrameXmlFrame>();
    for (const [name, type, scripts] of READY_CHECK_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || !scripts.every((script) => boot.bridge.hasScript(frame, script))) {
        return undefined;
      }
      readyFrames.set(name, frame);
    }
    const readyCheck = readyFrames.get("ReadyCheckFrame")!;
    if (readyCheck.parent?.name !== "UIParent" || readyCheck.visible
      || !frameDescendsFrom(readyFrames.get("ReadyCheckFrameYesButton")!, readyCheck)
      || !renderedFrameElement(renderer.elementFor(readyCheck), readyCheck)
      || !["READY_CHECK", "READY_CHECK_FINISHED"].every((event) => readyCheck.registeredEvents.has(event))
      || !FRAMEXML_POPUPS_EVENTS.every((event) => uiParent.registeredEvents.has(event))) return undefined;
    const battlefieldEntry = frameXmlPopupsBattlefieldEntryReady(boot.bridge);
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = popups.muted(() => frameXmlSilentProbe(boot, "webclient/popups-gate", `
      local shadowed = { "UnitIsDeadOrGhost", "InCinematic", "WebClientReadyCheckRole", "WebClientReadyCheckUnit" }
      local saved = {}
      for index, name in ipairs(shadowed) do
        saved[index] = rawget(_G, name)
        rawset(_G, name, function() return nil end)
      end
      local results = { pcall(function()
      local missing = 0
      for _, which in ipairs({ ${FRAMEXML_POPUPS_DIALOGS.map((which) => `"${which}"`).join(", ")} }) do
        if type(StaticPopupDialogs[which]) ~= "table" then missing = missing + 1 end
      end
      local invite = StaticPopup_Show("PARTY_INVITE", "WebClientProbe")
      local inviteShown = invite and invite:IsShown() and 1 or 0
      local inviteText = invite and invite.text:GetText() or ""
      local buttons = invite and ((invite.button1:IsShown() and 1 or 0) + (invite.button2:IsShown() and 1 or 0)) or 0
      StaticPopup_Hide("PARTY_INVITE")
      local death = StaticPopup_Show("DEATH")
      local deathShown = death and death:IsShown() and 1 or 0
      StaticPopup_Hide("DEATH")
      local summon = StaticPopup_Show("CONFIRM_SUMMON")
      local summonShown = summon and summon:IsShown() and 1 or 0
      StaticPopup_Hide("CONFIRM_SUMMON")
      ReadyCheckFrame_OnEvent(ReadyCheckFrame, "READY_CHECK", "WebClientProbe", 35)
      local readyShown = ReadyCheckListenerFrame:IsShown() and 1 or 0
      ReadyCheckFrame:Hide()
      local visible = ReadyCheckFrame:IsShown() and 1 or 0
      for index = 1, STATICPOPUP_NUMDIALOGS do
        if _G["StaticPopup" .. index]:IsShown() then visible = visible + 1 end
      end
      return missing, inviteShown, inviteText, buttons, deathShown, summonShown, readyShown, visible
      end) }
      for index, name in ipairs(shadowed) do rawset(_G, name, saved[index]) end
      if not results[1] then error(results[2], 0) end
      return select(2, table.unpack(results, 1, 9))
    `, 8));
    if (!probe) return undefined;
    const inviteText = probe[2];
    const [missing, inviteShown, , buttons, deathShown, summonShown, readyShown, visible] = probe.map((value) => Number(value));
    if (missing !== 0 || inviteShown !== 1 || typeof inviteText !== "string" || !inviteText.includes("WebClientProbe")
      || buttons !== 2 || deathShown !== 1 || summonShown !== 1 || readyShown !== 1 || visible !== 0
      || dialogs.some((dialog) => dialog.visible) || readyCheck.visible
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return { dialogs, readyCheck, inviteText, battlefieldEntry };
  } catch {
    return undefined;
  }
}

/**
 * The published owner: Escape reaches stock `StaticPopup_EscapePressed` (StaticPopup.lua:3535),
 * which runs each escapable dialog's own cancel — DeclineGroup, CancelDuel, CancelTrade, CAMP's
 * CancelLogout — and leaves DEATH, RECOVER_CORPSE and CONFIRM_BATTLEFIELD_ENTRY's answer alone.
 * With the model it also takes the native «Разрушить» and a world drop of the stock cursor's item
 * (DELETE_ITEM_CONFIRM), and answers whether stock asks the battleground entry now.
 */
export function createFrameXmlPopupsOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  popups?: FrameXmlPopupsModel,
): FrameXmlPopupsOwner {
  const escapable = (): boolean => {
    const values = frameXmlSilentProbe(boot, "webclient/popups-open", `
      for _, frame in pairs(StaticPopup_DisplayedFrames or {}) do
        if frame:IsShown() and frame.hideOnEscape then return 1 end
      end
      return 0
    `, 1);
    return Number(values?.[0]) === 1;
  };
  return {
    isOpen: escapable,
    close: () => {
      if (escapable()) boot.vm.executeReported("StaticPopup_EscapePressed()", "@webclient/popups-escape");
    },
    battlefieldEntry: () => frameXmlPopupsBattlefieldEntryReady(boot.bridge),
    destroyItem: (bag, slot) => popups?.destroyItem(bag, slot) ?? false,
    dropCursorItem: () => popups?.confirmDeleteCursorItem() ?? false,
  };
}
