/**
 * Stock LFDParentFrame as the dungeon finder: the gate, the published owner and the stock toggle
 * routes. The C API itself is FrameXmlLfd.ts.
 *
 * LFGFrame.xml, LFDFrame.xml and LFRFrame.xml load after ArenaFrame.xml (stock TOC 130-132). LFR
 * must load even though nothing routes to it: LFGFrame.lua's event tail touches `LFRParentFrame`
 * and the LFR role buttons unconditionally (measured without it: «global 'LFRParentFrame'»).
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlLfdModel } from "./FrameXmlLfd.js";
import type { FrameXmlLfdOwner } from "./FrameXmlLfdController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

/** `NUM_LFD_CHOICE_BUTTONS` (LFDFrame.lua:5). */
const LFD_LIST_BUTTONS = 15;

/** Named stock frames the finder needs, with their widget type and the scripts it must carry. */
const LFD_FRAMES: readonly (readonly [name: string, type: string, scripts: readonly string[]])[] = [
  ["LFDParentFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["LFDQueueFrame", "Frame", ["OnShow", "OnHide"]],
  ["LFDQueueFrameSpecific", "Frame", []],
  ["LFDQueueFrameRandom", "Frame", []],
  ["LFDQueueFrameTypeDropDown", "Frame", ["OnShow"]],
  ["LFDQueueFrameRoleButtonTank", "Button", ["OnClick"]],
  ["LFDQueueFrameRoleButtonHealer", "Button", ["OnClick"]],
  ["LFDQueueFrameRoleButtonDPS", "Button", ["OnClick"]],
  ["LFDQueueFrameRoleButtonLeader", "Button", ["OnClick"]],
  ["LFDQueueFrameFindGroupButton", "Button", ["OnClick"]],
  ["LFDQueueFrameCancelButton", "Button", ["OnClick"]],
  ["LFDDungeonReadyPopup", "Frame", ["OnShow", "OnHide"]],
  ["LFDDungeonReadyDialogEnterDungeonButton", "Button", ["OnClick"]],
  ["LFDDungeonReadyDialogLeaveQueueButton", "Button", ["OnClick"]],
  ["LFDRoleCheckPopup", "Frame", ["OnShow"]],
  ["LFDRoleCheckPopupAcceptButton", "Button", ["OnClick"]],
  ["LFDRoleCheckPopupDeclineButton", "Button", ["OnClick"]],
  ["LFDSearchStatus", "Frame", ["OnEvent", "OnShow"]],
  ["LFGEventFrame", "Frame", ["OnLoad", "OnEvent"]],
  ["MiniMapLFGFrame", "Button", ["OnClick", "OnEnter"]],
  ["LFRParentFrame", "Frame", []],
];

/** Events the stock frames must have registered in OnLoad for the pump to reach them. */
const LFD_EVENTS: readonly (readonly [frame: string, events: readonly string[]])[] = [
  ["LFGEventFrame", ["LFG_UPDATE", "LFG_LOCK_INFO_RECEIVED", "LFG_ROLE_CHECK_ROLE_CHOSEN", "LFG_UPDATE_RANDOM_INFO"]],
  ["LFDParentFrame", ["LFG_PROPOSAL_SHOW", "LFG_PROPOSAL_UPDATE", "LFG_PROPOSAL_FAILED", "LFG_PROPOSAL_SUCCEEDED",
    "LFG_ROLE_CHECK_SHOW", "LFG_ROLE_CHECK_HIDE", "LFG_BOOT_PROPOSAL_UPDATE", "LFG_ROLE_UPDATE"]],
  ["LFDSearchStatus", ["LFG_QUEUE_STATUS_UPDATE"]],
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

export interface FrameXmlLfdGateResult {
  readonly frame: FrameXmlFrame;
  /** Measured by the probe: rows in LFDDungeonList after two updates, and visible list buttons. */
  readonly listed: number;
  readonly rows: number;
}

/**
 * Structural, rendered and transactional proof that stock LFD can own the dungeon finder.
 *
 * The catalog must be ready first: the probe's first LFDQueueFrame_Update latches
 * LFGDungeonList_Setup for the session. The probe then shows LFDParentFrame on the specific list,
 * runs LFDQueueFrame_Update twice, counts the listed ids and visible list buttons, and restores the
 * type, panes and hidden frame — silently (no PlaySound) and without a packet (the model is muted,
 * so OnShow's RequestLFDPlayerLockInfo sends nothing). Any new Lua error or bridge diagnostic, or a
 * visible-row count that disagrees with the list, fails the gate and leaves the native finder.
 */
export function frameXmlLfdGate(
  seam: { readonly lfd?: FrameXmlLfdModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlLfdGateResult | undefined {
  try {
    const lfd = seam.lfd;
    if (!lfd?.ready()) return undefined;
    const frames = new Map<string, FrameXmlFrame>();
    for (const [name, type, scripts] of LFD_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || !scripts.every((script) => boot.bridge.hasScript(frame, script))) {
        return undefined;
      }
      frames.set(name, frame);
    }
    const parent = frames.get("LFDParentFrame")!;
    if (parent.parent?.name !== "UIParent" || parent.visible
      || frames.get("LFRParentFrame")!.visible
      || !frameDescendsFrom(frames.get("LFDQueueFrame")!, parent)
      || frames.get("LFDSearchStatus")!.parent?.name !== "MiniMapLFGFrame") return undefined;
    for (let index = 1; index <= LFD_LIST_BUTTONS; index += 1) {
      const button = boot.bridge.getFrame(`LFDQueueFrameSpecificListButton${index}`);
      if (!button || !frameDescendsFrom(button, parent)) return undefined;
    }
    for (const name of ["LFDParentFrame", "LFDDungeonReadyPopup", "LFDRoleCheckPopup", "MiniMapLFGFrame"]) {
      const frame = frames.get(name)!;
      if (!renderedFrameElement(renderer.elementFor(frame), frame)) return undefined;
    }
    for (const [name, events] of LFD_EVENTS) {
      const frame = frames.get(name)!;
      if (!events.every((event) => frame.registeredEvents.has(event))) return undefined;
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = lfd.muted(() => frameXmlSilentProbe(boot, "webclient/lfd-gate", `
      local savedType = LFDQueueFrame.type
      local specificShown, randomShown = LFDQueueFrameSpecific:IsShown(), LFDQueueFrameRandom:IsShown()
      ShowUIPanel(LFDParentFrame)
      local shown = LFDParentFrame:IsShown() and 1 or 0
      LFDQueueFrame_SetType("specific")
      LFDQueueFrame_Update()
      LFDQueueFrame_Update()
      local rows = 0
      for index = 1, NUM_LFD_CHOICE_BUTTONS do
        if _G["LFDQueueFrameSpecificListButton" .. index]:IsVisible() then rows = rows + 1 end
      end
      local listed = #LFDDungeonList
      local known = 0
      for _ in pairs(LFGDungeonInfo or {}) do known = known + 1 end
      HideUIPanel(LFDParentFrame)
      LFDQueueFrame.type = savedType
      UIDropDownMenu_SetSelectedValue(LFDQueueFrameTypeDropDown, savedType)
      if specificShown then LFDQueueFrameSpecific:Show() else LFDQueueFrameSpecific:Hide() end
      if randomShown then
        LFDQueueFrameRandom:Show()
        LFDQueueFrameBackground:SetTexture("Interface\\\\LFGFrame\\\\UI-LFG-BACKGROUND-QUESTPAPER")
      else
        LFDQueueFrameRandom:Hide()
      end
      return shown, rows, listed, known, LFDParentFrame:IsShown() and 1 or 0
    `, 5));
    if (!probe) return undefined;
    const [shown, rows, listed, known, stillShown] = probe.map((value) => Number(value));
    if (shown !== 1 || stillShown !== 0 || parent.visible
      || known !== lfd.choiceIds().length || known === 0
      || rows !== Math.min(listed ?? 0, LFD_LIST_BUTTONS)
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return { frame: parent, listed: listed ?? 0, rows: rows ?? 0 };
  } catch {
    return undefined;
  }
}

/**
 * The published owner. `show` is stock ToggleLFDParentFrame's open branch (UIParent.lua:413-421):
 * below SHOW_LFD_LEVEL (15) nothing opens, as in the client. The global ToggleLFDParentFrame is
 * rebound to the host route so MiniMapLFGFrame's click and any add-on reach this same owner.
 *
 * The owner also answers for LFRParentFrame, which loads beside it with no route: `isOpen` counts it
 * and `hide` closes it, so an add-on's direct ShowUIPanel(LFRParentFrame) still ends at Escape
 * (Windows.ts polls this owner) instead of leaving a window no native close path knows.
 */
export function createFrameXmlLfdOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
): FrameXmlLfdOwner {
  const raid = boot.bridge.getFrame("LFRParentFrame");
  const raidOpen = (): boolean => raid !== undefined && boot.bridge.isVisible(raid);
  return {
    isOpen: () => boot.bridge.isVisible(frame) || raidOpen(),
    show: () => {
      boot.vm.executeReported(
        "if UnitLevel(\"player\") >= SHOW_LFD_LEVEL then ShowUIPanel(LFDParentFrame) end",
        "@webclient/lfd-show",
      );
    },
    hide: () => {
      if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(LFDParentFrame)", "@webclient/lfd-hide");
      if (raidOpen()) boot.vm.executeReported("HideUIPanel(LFRParentFrame)", "@webclient/lfr-hide");
    },
  };
}

/**
 * Route stock ToggleLFDParentFrame (UIParent.lua:413) through the host toggle, and close the raid
 * browser's door. LFRFrame.xml loads only because LFGFrame.lua touches it, and TrinityCore 3.3.5
 * has no SearchLFG protocol behind it; stock ToggleLFRParentFrame (UIParent.lua:423) — reached from
 * SlashCmdList.RAIDBROWSER (ChatFrame.lua:2107: /raidbrowser, /lfr, /rb, /пр, /ищр,
 * /просмотррейдов) and the eye's "listed" click — opened an empty 425x527 «Список рейдов» that the
 * native Escape chain did not know (measured). It now does nothing, like the rest of the raid
 * browser API (FrameXmlLfd.ts answers "nothing listed"), and says so once in the console.
 */
export function installFrameXmlLfdToggle(boot: Pick<FrameXmlBoot, "vm">, toggle: () => unknown): void {
  boot.vm.registerGlobal("ToggleLFDParentFrame", () => {
    try { void toggle(); } catch (error) { console.warn(`[FrameXML LFD] toggle: ${String(error)}`); }
    return [];
  });
  let told = false;
  boot.vm.registerGlobal("ToggleLFRParentFrame", () => {
    if (!told) {
      told = true;
      console.info("[FrameXML LFD] the raid browser has no TrinityCore 3.3.5 protocol; ToggleLFRParentFrame does nothing");
    }
    return [];
  });
}
