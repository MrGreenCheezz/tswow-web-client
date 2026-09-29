/**
 * Stock LootFrame and GroupLootFrame1-4 as the loot window and the group-loot roll dialogs: the
 * gate, the published owner and one small adapter (the roll frames' UIParent parent). The C API
 * itself is FrameXmlLoot.ts.
 *
 * LootFrame.xml loads after ContainerFrame.xml, its retail FrameXML.toc slot (line 97). Its
 * GroupLootFrame_OnShow/OnHide call AlertFrame_FixAnchors from AlertFrames.xml, which this vertical
 * does not load; the stub floor answers that name as a no-op (there are no alert frames to
 * re-anchor), measured with no Lua error.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { LootSlot } from "../../world/LootProtocol.js";
import {
  FRAMEXML_LOOT_UNKNOWN_ICON,
  type FrameXmlLootModel,
  type FrameXmlLootProbeFixture,
} from "./FrameXmlLoot.js";
import { publishFrameXmlLoot, type FrameXmlLootOwner } from "./FrameXmlLootController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

/** `NUM_GROUP_LOOT_FRAMES` and `LOOTFRAME_NUMBUTTONS` (LootFrame.lua:1-2). */
const GROUP_LOOT_FRAMES = 4;
const LOOT_BUTTONS = 4;
/** The roll id the gate's synthetic roll answers to; real ids start at 1. */
const PROBE_ROLL_ID = -1;
/** The gate's synthetic item entry, answered only from the probe fixture. */
const PROBE_ITEM = 1;
const PROBE_NAME = "WebClient loot probe";

/** Named stock frames, with their widget type and the scripts they must carry. */
function lootFrames(): (readonly [name: string, type: string, scripts: readonly string[]])[] {
  const frames: (readonly [string, string, readonly string[]])[] = [
    ["LootFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
    ["LootCloseButton", "Button", ["OnClick"]],
    ["LootFrameUpButton", "Button", ["OnClick"]],
    ["LootFrameDownButton", "Button", ["OnClick"]],
    ["GroupLootDropDown", "Frame", ["OnLoad"]],
  ];
  for (let index = 1; index <= LOOT_BUTTONS; index += 1) {
    frames.push([`LootButton${index}`, "Button", ["OnClick", "OnEnter", "OnLeave"]]);
  }
  for (let index = 1; index <= GROUP_LOOT_FRAMES; index += 1) {
    const name = `GroupLootFrame${index}`;
    frames.push([name, "Frame", ["OnShow", "OnEvent", "OnHide"]]);
    frames.push([`${name}IconFrame`, "Button", ["OnEnter", "OnClick"]]);
    for (const button of ["RollButton", "GreedButton", "DisenchantButton", "PassButton"]) {
      frames.push([`${name}${button}`, "Button", ["OnClick", "OnEnter"]]);
    }
    frames.push([`${name}Timer`, "StatusBar", ["OnUpdate"]]);
  }
  return frames;
}

/** Events the stock owners registered in OnLoad, which the model raises. */
const LOOT_EVENTS: readonly (readonly [frame: string, events: readonly string[]])[] = [
  ["LootFrame", ["LOOT_OPENED", "LOOT_SLOT_CLEARED", "LOOT_SLOT_CHANGED", "LOOT_CLOSED",
    "OPEN_MASTER_LOOT_LIST", "UPDATE_MASTER_LOOT_LIST"]],
  ["UIParent", ["START_LOOT_ROLL", "CONFIRM_LOOT_ROLL", "CONFIRM_DISENCHANT_ROLL", "LOOT_BIND_CONFIRM"]],
  ...Array.from({ length: GROUP_LOOT_FRAMES }, (_, index) =>
    [`GroupLootFrame${index + 1}`, ["CANCEL_LOOT_ROLL"]] as const),
];

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

function probeSlot(index: number, itemId: number): LootSlot {
  return { index, itemId, count: 1, displayId: 0, randomSuffix: 0, randomPropertyId: 0, slotType: 0, taken: false };
}

/**
 * The gate probe's cleanup, run after it whatever it got to. The probe itself hides what it showed
 * only on its happy path; a fault between LootFrame's Show and its HideUIPanel (measured: one stock
 * method raising there left LootFrame on screen with the probe's coins and item), a HideUIPanel
 * that left it up, or a roll frame that failed after showing would otherwise stay above the HUD
 * while the native window keeps loot (and, measured, fail every later gate of that boot at its first
 * check, `loot.visible`). Each hide is a pcall, so one that raises does not stop the rest: LootFrame
 * through HideUIPanel (the UIPanel slot let go), then plainly; the roll frames carrying the probe's
 * roll id hidden and their id cleared.
 */
const PROBE_RESTORE = `
  if LootFrame:IsShown() then pcall(HideUIPanel, LootFrame) end
  if LootFrame:IsShown() then pcall(LootFrame.Hide, LootFrame) end
  for index = 1, NUM_GROUP_LOOT_FRAMES or ${GROUP_LOOT_FRAMES} do
    local frame = _G["GroupLootFrame" .. index]
    if frame and frame.rollID == ${PROBE_ROLL_ID} then
      pcall(frame.Hide, frame)
      frame.rollID = nil
    end
  end
`;

/**
 * Take the probe's frames down: the Lua cleanup above, then — should even that not have run — the
 * bridge's own Hide on anything still shown (every frame here was hidden when the gate started).
 * Called inside `model.probe`, so LootFrame's OnHide CloseLoot stays inert.
 */
function restoreLootProbe(boot: Pick<FrameXmlBoot, "vm" | "bridge">, frames: readonly FrameXmlFrame[]): void {
  frameXmlSilentProbe(boot, "webclient/loot-gate-restore", PROBE_RESTORE, 0);
  for (const frame of frames) if (frame.visible) boot.bridge.Hide(frame);
}

/** The gate's opening: money (slot 1) and one item (slot 2), and one roll on that item. */
export const FRAMEXML_LOOT_PROBE: FrameXmlLootProbeFixture = Object.freeze({
  loot: Object.freeze({ guid: 0n, lootType: 1, gold: 12345, slots: Object.freeze([probeSlot(0, PROBE_ITEM)]) as LootSlot[] }),
  items: new Map([[PROBE_ITEM, Object.freeze({ name: PROBE_NAME, quality: 2, texture: FRAMEXML_LOOT_UNKNOWN_ICON })]]),
  roll: Object.freeze({
    id: PROBE_ROLL_ID,
    entry: Object.freeze({
      start: Object.freeze({
        itemGuid: 0n, mapId: 0, itemSlot: 0, itemId: PROBE_ITEM, randomSuffix: 0, randomPropertyId: 0,
        count: 1, countdown: 60000, voteMask: 0x07,
      }),
      startedAt: 0,
      votes: Object.freeze([]) as [],
    }),
  }),
});

export interface FrameXmlLootGateResult {
  readonly frame: FrameXmlFrame;
  /** Measured by the probe: what LootFrame listed and GroupLootFrame1 named. */
  readonly buttons: number;
  readonly coinText: string;
  readonly rollName: string;
}

/**
 * Structural, rendered and transactional proof that stock LootFrame and GroupLootFrame1-4 can own
 * loot.
 *
 * The named frames, their scripts, parents and registered events are checked first, and the two
 * stock popups the flow needs (LOOT_BIND, CONFIRM_LOOT_ROLL) must exist. Then, silently (no
 * PlaySound) and over the model's synthetic opening with every command muted (no CMSG_LOOT_RELEASE
 * from LootFrame's OnHide, no roll packet), the stock LOOT_OPENED handler must show LootFrame with
 * the money and the item on their buttons, HideUIPanel must hide it again, and
 * GroupLootFrame_OpenNewFrame must show GroupLootFrame1 named after the roll's item. Any new Lua
 * error or bridge diagnostic, or a frame left shown, fails the gate and leaves the native window.
 * Whatever the probe got to, it ends with LootFrame and the roll frames hidden again
 * (`restoreLootProbe`), so a failed gate leaves nothing of the synthetic opening on screen.
 */
export function frameXmlLootGate(
  seam: { readonly loot?: FrameXmlLootModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlLootGateResult | undefined {
  try {
    const model = seam.loot;
    if (!model) return undefined;
    const frames = new Map<string, FrameXmlFrame>();
    for (const [name, type, scripts] of lootFrames()) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || !scripts.every((script) => boot.bridge.hasScript(frame, script))) {
        return undefined;
      }
      frames.set(name, frame);
    }
    const loot = frames.get("LootFrame")!;
    if (loot.parent?.name !== "UIParent" || loot.visible) return undefined;
    for (let index = 1; index <= GROUP_LOOT_FRAMES; index += 1) {
      const frame = frames.get(`GroupLootFrame${index}`)!;
      if (frame.parent?.name !== "UIParent" || frame.visible) return undefined;
      if (!renderedFrameElement(renderer.elementFor(frame), frame)) return undefined;
    }
    if (!renderedFrameElement(renderer.elementFor(loot), loot)) return undefined;
    for (const [name, events] of LOOT_EVENTS) {
      const frame = frames.get(name) ?? boot.bridge.getFrame(name);
      if (!frame || !events.every((event) => frame.registeredEvents.has(event))) return undefined;
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const rolls = Array.from({ length: GROUP_LOOT_FRAMES }, (_, index) => frames.get(`GroupLootFrame${index + 1}`)!);
    const probe = model.probe(FRAMEXML_LOOT_PROBE, () => {
      try {
        return runLootProbe(boot);
      } finally {
        restoreLootProbe(boot, [loot, ...rolls]);
      }
    });
    if (!probe) return undefined;
    const [popups, shown, buttons, coin, item, stillShown, roll, rollName, rollStillShown] = probe;
    if (Number(popups) !== 1 || Number(shown) !== 1 || Number(buttons) !== 2
      || typeof coin !== "string" || !/\d/.test(coin) || item !== PROBE_NAME
      || Number(stillShown) !== 0 || loot.visible || rolls.some((frame) => frame.visible)
      || Number(roll) !== 1 || rollName !== PROBE_NAME || Number(rollStillShown) !== 0
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return { frame: loot, buttons: Number(buttons), coinText: coin, rollName };
  } catch {
    return undefined;
  }
}

/** The probe body: the stock LOOT_OPENED, HideUIPanel and GroupLootFrame_OpenNewFrame, measured. */
function runLootProbe(boot: Pick<FrameXmlBoot, "vm">): readonly unknown[] | undefined {
  return frameXmlSilentProbe(boot, "webclient/loot-gate", `
    local dialogs = StaticPopupDialogs
    local popups = dialogs and dialogs.LOOT_BIND and dialogs.CONFIRM_LOOT_ROLL and 1 or 0
    LootFrame_OnEvent(LootFrame, "LOOT_OPENED", 0)
    local shown = LootFrame:IsShown() and 1 or 0
    local buttons = 0
    for index = 1, LOOTFRAME_NUMBUTTONS do
      if _G["LootButton" .. index]:IsShown() then buttons = buttons + 1 end
    end
    local coin, item = LootButton1Text:GetText() or "", LootButton2Text:GetText() or ""
    HideUIPanel(LootFrame)
    GroupLootFrame_OpenNewFrame(${PROBE_ROLL_ID}, 60000)
    local roll = GroupLootFrame1:IsShown() and 1 or 0
    local rollName = GroupLootFrame1Name:GetText() or ""
    GroupLootFrame1:Hide()
    GroupLootFrame1.rollID = nil
    return popups, shown, buttons, coin, item, LootFrame:IsShown() and 1 or 0, roll, rollName,
      GroupLootFrame1:IsShown() and 1 or 0
  `, 9);
}

export interface FrameXmlLootAdapters {
  /** GroupLootFrames moved under UIParent (0 once the bridge inherits template parents). */
  readonly reparented: number;
}

/**
 * The in-lane adapter for the stock loot frames, installed before the renderer mounts and the gate
 * runs. (The roll icon's GameTooltip:SetLootRollItem is the binder's own link setter,
 * GlueWidgets.ts, over GetLootRollItemLink; the item names' quality colour, FontString:SetVertexColor
 * at LootFrame.lua:111 and :360, is the binder's own too.)
 *
 * GroupLootFrame1-4 under UIParent. `parent="UIParent"` sits on the virtual GroupLootFrameTemplate
 * (LootFrame.xml:253), and the bridge does not carry a template's parent to the frames inheriting
 * it: measured, all four load parentless, so they would neither hide with the interface nor sit in
 * UIParent's strata like the client's. Only a frame still parentless is moved; its anchors (BOTTOM
 * of its parent, and UIParent_ManageFramePositions' explicit "UIParent") are unchanged.
 */
export function installFrameXmlLootAdapters(boot: Pick<FrameXmlBoot, "vm">): FrameXmlLootAdapters {
  const installed = frameXmlSilentProbe(boot, "webclient/loot-adapters", `
    local moved = 0
    for index = 1, NUM_GROUP_LOOT_FRAMES or 0 do
      local frame = _G["GroupLootFrame" .. index]
      if frame and UIParent and frame:GetParent() == nil then
        frame:SetParent(UIParent)
        moved = moved + 1
      end
    end
    return moved
  `, 1);
  return { reparented: Number(installed?.[0] ?? 0) };
}

/**
 * The published owner. `hide` is LootCloseButton's own HideUIPanel(LootFrame), so Escape releases
 * the loot exactly as the X does. `release` disowns the model first — from then on CloseLoot is
 * inert — and only then takes every stock loot frame and popup down, so a teardown never releases
 * the corpse the native window is about to show again.
 */
export function createFrameXmlLootOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  model: FrameXmlLootModel,
  frame: FrameXmlFrame,
): FrameXmlLootOwner {
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    hide: () => {
      if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(LootFrame)", "@webclient/loot-hide");
    },
    release: () => {
      model.owned = false;
      model.useGlobalStrings(undefined);
      boot.vm.executeReported(`
        StaticPopup_Hide("LOOT_BIND")
        StaticPopup_Hide("CONFIRM_LOOT_ROLL")
        StaticPopup_Hide("CONFIRM_LOOT_DISTRIBUTION")
        if LootFrame:IsShown() then HideUIPanel(LootFrame) end
        for index = 1, NUM_GROUP_LOOT_FRAMES do _G["GroupLootFrame" .. index]:Hide() end
      `, "@webclient/loot-release");
    },
  };
}

/**
 * Publish the stock owner, hand it the model and the client's GlobalStrings, and let the native
 * window and dialogs repaint (they step aside once `frameXmlLootPublished` is true, and take an
 * open corpse back after the cleanup). An opening or roll already in flight reaches stock on the
 * model's next tick.
 */
export function publishFrameXmlLootMount(
  next: FrameXmlLootOwner,
  model: FrameXmlLootModel,
  strings: (name: string) => string | undefined,
  repaintNative: () => void,
): () => void {
  const release = publishFrameXmlLoot(next);
  model.useGlobalStrings(strings);
  model.owned = true;
  repaintNative();
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    release();
    repaintNative();
  };
}
