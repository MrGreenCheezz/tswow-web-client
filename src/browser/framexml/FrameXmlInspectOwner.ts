/**
 * Stock InspectFrame as the inspection window: the preload, the gate and the lazy, load-on-demand
 * owner. The C API is FrameXmlInspect.ts; the stock entry point (`InspectUnit`: the unit menus'
 * «Осмотреть», `/inspect`) is routed here by FrameXmlInspectMount.ts.
 *
 * Blizzard_InspectUI is load-on-demand. The first InspectUnit of a session loads it through the host
 * path the trainer and the auction house use (`boot.loadAddon` → `renderer.addRoots` → `renderer.sync`
 * → gate), then runs the stock `InspectFrame_Show(unit)` for the unit that was asked for. Lua's
 * LoadAddOn is only a status view here, so the stock `InspectUnit` would print «not loaded». There is
 * no native inspection window: a failed load or gate hands the request back to the stock InspectUnit,
 * whose UIParentLoadAddOn shows the client's own load-failure message.
 *
 * Two things the add-on expects from the rest of FrameXML, and the vertical corpus does not carry:
 * * InspectTalentFrame is TalentFrameBase's (TalentFrame_Load, TalentFrame_Update, MAX_NUM_TALENTS)
 *   and inherits TalentFrameTemplates.xml's buttons, branches and arrows: stock FrameXML.toc lines
 *   136-137, outside the bounded vertical. Measured before this: the load raised «'for' limit must be
 *   a number» at inspecttalentframe.lua:91, and then «template "TalentArrowTemplate" is not
 *   registered». The two stock files run through the same loader before the add-on, each only when
 *   nothing has defined it (TALENT_BRANCH_TEXTURECOORDS marks the Lua: an add-on's stub floor can
 *   create a TalentFrame_Load stand-in, never that table; TalentButtonTemplate marks the XML).
 * * InspectPVPFrame.xml includes `PVPFrameTemplates.xml` relative to the add-on, a file the client's
 *   MPQ chain does not have there; the load runs with FrameXmlInspectCorpus.ts's overlay.
 *
 * Measured over the client MPQ (tests/framexml-inspect-vertical.test.mjs): the two stock talent files
 * (23,535 + 1,910 bytes), then the add-on's 10 files (75,300 bytes); +839 widgets (the talent page's
 * forty buttons with their branches and arrows among them), no roots of its own, no Lua error.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { GlueLoader } from "../glue/GlueLoader.js";
import { withFrameXmlLaneCorpus } from "./FrameXmlInspectCorpus.js";
import { subsetTocProvider } from "./FrameXmlCorpus.js";
import type { FrameXmlInspectModel } from "./FrameXmlInspect.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

export const FRAMEXML_INSPECT_ADDON = "Blizzard_InspectUI";
/** Stock FrameXML.toc lines 136-137, in that order: the talent frames' shared Lua and templates. */
const TALENT_FRAME_FILES: readonly (readonly [entry: string, present: string])[] = [
  ["TalentFrameBase.lua", `rawget(_G, "TALENT_BRANCH_TEXTURECOORDS") ~= nil`],
  ["TalentFrameTemplates.xml", ""],
];
const TALENT_FRAME_TOC = "interface/framexml/__webclient_talentframe.toc";

/** The nineteen paper-doll slot buttons, head to tabard (InspectPaperDollFrame.xml). */
export const FRAMEXML_INSPECT_SLOTS: readonly string[] = Object.freeze([
  "InspectHeadSlot", "InspectNeckSlot", "InspectShoulderSlot", "InspectBackSlot", "InspectChestSlot",
  "InspectShirtSlot", "InspectTabardSlot", "InspectWristSlot", "InspectHandsSlot", "InspectWaistSlot",
  "InspectLegsSlot", "InspectFeetSlot", "InspectFinger0Slot", "InspectFinger1Slot", "InspectTrinket0Slot",
  "InspectTrinket1Slot", "InspectMainHandSlot", "InspectSecondaryHandSlot", "InspectRangedSlot",
]);

/** Named stock frames the inspection window needs: widget type, the ancestor it lives in, its scripts. */
const INSPECT_FRAMES: readonly (readonly [name: string, type: string, ancestor: string, scripts: readonly string[]])[] = [
  ["InspectFrame", "Frame", "UIParent", ["OnLoad", "OnEvent", "OnShow", "OnHide", "OnUpdate"]],
  ["InspectFrameCloseButton", "Button", "InspectFrame", ["OnClick"]],
  ["InspectFrameTab1", "Button", "InspectFrame", ["OnClick"]],
  ["InspectFrameTab2", "Button", "InspectFrame", ["OnClick"]],
  ["InspectFrameTab3", "Button", "InspectFrame", ["OnClick"]],
  ["InspectPaperDollFrame", "Frame", "InspectFrame", ["OnLoad", "OnEvent", "OnShow"]],
  ["InspectModelFrame", "PlayerModel", "InspectPaperDollFrame", []],
  ["InspectPVPFrame", "Frame", "InspectFrame", ["OnLoad", "OnEvent", "OnShow"]],
  ["InspectTalentFrame", "Frame", "InspectFrame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["InspectTalentFrameTalent1", "Button", "InspectTalentFrame", ["OnClick", "OnEnter"]],
  ...FRAMEXML_INSPECT_SLOTS.map((name) => [name, "Button", "InspectPaperDollFrame", ["OnLoad", "OnEvent", "OnEnter"]] as const),
];

/** The registrations the model's events reach (Blizzard_InspectUI.lua:19-22 and the three tabs). */
const INSPECT_EVENTS: readonly (readonly [frame: string, events: readonly string[]])[] = [
  ["InspectFrame", ["PLAYER_TARGET_CHANGED", "UNIT_NAME_UPDATE", "UNIT_PORTRAIT_UPDATE"]],
  ["InspectPaperDollFrame", ["UNIT_MODEL_CHANGED", "UNIT_LEVEL"]],
  ["InspectHeadSlot", ["UNIT_INVENTORY_CHANGED"]],
  ["InspectPVPFrame", ["INSPECT_HONOR_UPDATE"]],
];

function frameDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  let current: FrameXmlFrame | undefined = frame;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function renderedFrameElement(element: HTMLElement | undefined, frame: FrameXmlFrame): boolean {
  return !!element && element.getAttribute("data-framexml-name") === frame.name
    && element.getAttribute("data-framexml-type") === frame.type;
}

/**
 * Run stock TalentFrameBase.lua and TalentFrameTemplates.xml through the loader, each only when the VM
 * does not have it yet. False when either could not run cleanly.
 */
export async function installFrameXmlInspectPreload(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "corpus" | "errorCount">,
): Promise<boolean> {
  const entries: string[] = [];
  for (const [entry, present] of TALENT_FRAME_FILES) {
    const loaded = present
      ? Number(frameXmlSilentProbe(boot, "webclient/inspect-preload-probe", `return ${present} and 1 or 0`, 1)?.[0]) === 1
      : boot.bridge.registry.get("TalentButtonTemplate") !== undefined;
    if (!loaded) entries.push(entry);
  }
  if (entries.length === 0) return true;
  const errors = boot.errorCount;
  const { provider, toc } = subsetTocProvider(boot.corpus, entries, TALENT_FRAME_TOC);
  const loader = new GlueLoader({ vm: boot.vm, bridge: boot.bridge, provider, maxFiles: 8, maxDepth: 4 });
  const result = await loader.load(toc);
  return result.missing.length === 0 && result.diagnostics.length === 0 && boot.errorCount === errors;
}

/**
 * Structural, rendered and transactional proof that the loaded add-on can own inspection: the frame,
 * its three tabs, the paper doll's model and nineteen slots, the PvP and talent pages with their
 * scripts; the frame, a tab and its close button rendered; the registrations the model's events
 * reach. Then one silent ShowUIPanel/HideUIPanel pair with no unit — OnShow returns early without
 * one, OnHide clears the (absent) inspection — with no new Lua error or bridge diagnostic.
 */
export function frameXmlInspectGate(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlFrame | undefined {
  try {
    const frames = new Map<string, FrameXmlFrame>();
    const lookup = (name: string): FrameXmlFrame | undefined => frames.get(name) ?? boot.bridge.getFrame(name);
    for (const [name, type, ancestorName, scripts] of INSPECT_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      const ancestor = lookup(ancestorName);
      if (!frame || !ancestor || frame.type !== type || frame === ancestor || !frameDescendsFrom(frame, ancestor)
        || !scripts.every((script) => boot.bridge.hasScript(frame, script))) return undefined;
      frames.set(name, frame);
    }
    const root = frames.get("InspectFrame")!;
    if (root.parent?.name !== "UIParent" || root.visible) return undefined;
    // The paper doll starts hidden and the renderer builds a hidden subtree when it first shows (measured
    // on the RICH route: InspectHeadSlot has no element until InspectSwitchTabs(1)), so the eager part.
    for (const name of ["InspectFrame", "InspectFrameTab1", "InspectFrameCloseButton"]) {
      const frame = frames.get(name)!;
      if (!renderedFrameElement(renderer.elementFor(frame), frame)) return undefined;
    }
    for (const [name, events] of INSPECT_EVENTS) {
      const frame = lookup(name);
      if (!frame || !events.every((event) => frame.registeredEvents.has(event))) return undefined;
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = frameXmlSilentProbe(boot, "webclient/inspect-gate", `
      ShowUIPanel(InspectFrame)
      local shown = InspectFrame:IsShown() and 1 or 0
      HideUIPanel(InspectFrame)
      return shown, InspectFrame:IsShown() and 1 or 0
    `, 2);
    const [shown, stillShown] = (probe ?? []).map((value) => Number(value));
    if (!probe || shown !== 1 || stillShown !== 0 || root.visible
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) {
      if (root.visible) boot.bridge.Hide(root);
      return undefined;
    }
    return root;
  } catch {
    return undefined;
  }
}

function stubCalls(boot: Pick<FrameXmlBoot, "binder">, method: string): number {
  return boot.binder.stubDiagnostics
    .filter((record) => record.widgetType === "GameTooltip" && record.method === method)
    .reduce((sum, record) => sum + record.calls, 0);
}

/**
 * Two GameTooltip adapters for the inspected player, as per-frame Lua fields:
 * * `SetInventoryItem(unit, slot)` for the unit being inspected shows that slot's item link (its
 *   enchantments and gems as SMSG_INSPECT_TALENT gave them). The widget method's host adapter reads
 *   only the player's own inventory (FrameXmlCharacterTooltip.ts) and answered false, so a hovered
 *   slot showed its bare slot name; every other unit still reaches the widget method.
 * * `SetTalent(tab, index, inspect, …)` with `inspect` true, only while the binder answers it with
 *   its recorded no-op (the player's talent frames keep whatever answers them): the talent's name and
 *   `TOOLTIP_TALENT_RANK`, from the same inspected trees GetTalentInfo reads.
 * Returns the adapters installed.
 */
export function installFrameXmlInspectTooltips(boot: Pick<FrameXmlBoot, "vm" | "binder">): readonly string[] {
  const installed: string[] = [];
  const inventory = frameXmlSilentProbe(boot, "webclient/inspect-tooltip", `
    if type(GameTooltip) ~= "table" or type(GameTooltip.SetInventoryItem) ~= "function" then return 0 end
    if rawget(_G, "__webclientInspectTooltipInstalled") then return 1 end
    local base = GameTooltip.SetInventoryItem
    GameTooltip.SetInventoryItem = function(self, unit, slot, ...)
      if unit ~= nil and unit ~= "player" then
        local handled, _, link = WebClientInspectItem(unit, slot)
        if handled then
          if link then return self:SetHyperlink(link) end
          self:Hide()
          return false
        end
      end
      return base(self, unit, slot, ...)
    end
    rawset(_G, "__webclientInspectTooltipInstalled", true)
    return 1
  `, 1);
  if (Number(inventory?.[0]) === 1) installed.push("SetInventoryItem");
  const before = stubCalls(boot, "SetTalent");
  const probed = frameXmlSilentProbe(boot, "webclient/inspect-talent-probe", `
    if type(GameTooltip) ~= "table" or type(GameTooltip.SetTalent) ~= "function" then return 0 end
    if rawget(GameTooltip, "SetTalent") ~= nil then return 0 end
    GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")
    GameTooltip:SetTalent(1, 1)
    GameTooltip:Hide()
    return 1
  `, 1);
  if (Number(probed?.[0]) === 1 && stubCalls(boot, "SetTalent") > before) {
    const done = frameXmlSilentProbe(boot, "webclient/inspect-talent", `
      local base = GameTooltip.SetTalent
      GameTooltip.SetTalent = function(self, tab, index, inspect, pet, group, ...)
        if not inspect then return base(self, tab, index, inspect, pet, group, ...) end
        local name, _, _, _, rank, maxRank = GetTalentInfo(tab, index, inspect, pet, group)
        if not name then self:Hide() return end
        self:SetText(name, HIGHLIGHT_FONT_COLOR.r, HIGHLIGHT_FONT_COLOR.g, HIGHLIGHT_FONT_COLOR.b)
        self:AddLine(format(TOOLTIP_TALENT_RANK, rank or 0, maxRank or 0), HIGHLIGHT_FONT_COLOR.r, HIGHLIGHT_FONT_COLOR.g, HIGHLIGHT_FONT_COLOR.b)
        self:Show()
      end
      return 1
    `, 1);
    if (Number(done?.[0]) === 1) installed.push("SetTalent");
  }
  return installed;
}

export interface FrameXmlLazyInspectOwner {
  /** InspectUnit(unit): true when the stock window took it (now, or once loaded). */
  inspect(unit: string): boolean;
  isOpen(): boolean;
  /** Close the stock window; false when it was not open. */
  close(): boolean;
  readonly settled: Promise<void>;
  readonly loaded: boolean;
  readonly failed: boolean;
  dispose(): void;
}

/**
 * The lazy owner. `inspect` loads Blizzard_InspectUI on the first call and shows the stock window
 * for the last unit asked for once the gate has passed; `fallback(unit)` answers a request the stock
 * window can no longer take (a failed load or gate), for the unit that was waiting.
 */
export function createLazyFrameXmlInspectOwner(
  seam: { readonly inspect?: FrameXmlInspectModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "binder" | "loadAddon" | "corpus">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
  fallback: (unit: string) => void,
  onFailure?: (reason: string) => void,
): FrameXmlLazyInspectOwner {
  const model = seam.inspect;
  let frame: FrameXmlFrame | undefined;
  let pending: Promise<void> | undefined;
  let settled: Promise<void> = Promise.resolve();
  let failed = model === undefined;
  let disposed = false;
  let wanted: string | undefined;
  const globalString = (name: string): string | undefined => boot.vm.globalString(name);
  if (model) model.globalString = globalString;
  const show = (unit: string): void => {
    boot.vm.executeReported("InspectFrame_Show(...)", "@webclient/inspect-show", [unit]);
  };
  const fail = (reason: string): void => {
    if (disposed || failed) return;
    failed = true;
    const unit = wanted;
    wanted = undefined;
    const root = boot.bridge.getFrame("InspectFrame");
    if (root?.visible) {
      try { boot.bridge.Hide(root); } catch { /* the fallback answers either way */ }
    }
    if (unit !== undefined) {
      try { fallback(unit); } catch { /* nothing else can answer it */ }
    }
    onFailure?.(reason);
  };
  const load = async (): Promise<void> => {
    try {
      if (!await installFrameXmlInspectPreload(boot)) { fail("TalentFrameBase.lua/TalentFrameTemplates.xml could not be run"); return; }
      const result = await withFrameXmlLaneCorpus(boot, () => boot.loadAddon(FRAMEXML_INSPECT_ADDON));
      if (disposed) return;
      if (!result.ok) { fail(`${FRAMEXML_INSPECT_ADDON}: ${result.message ?? result.status}`); return; }
      renderer.addRoots(result.roots);
      // InspectFrame is a UIParent child, so the add-on's own root list is empty: reconcile.
      renderer.sync();
      const gated = frameXmlInspectGate(boot, renderer);
      if (!gated) { fail("the stock InspectFrame tree did not pass its gate"); return; }
      frame = gated;
      installFrameXmlInspectTooltips(boot);
      const unit = wanted;
      wanted = undefined;
      if (unit !== undefined) show(unit);
    } catch (error) {
      fail(`${FRAMEXML_INSPECT_ADDON}: ${String(error)}`);
    }
  };
  return {
    get loaded() { return frame !== undefined && !failed; },
    get failed() { return failed; },
    get settled() { return settled; },
    inspect: (unit) => {
      if (disposed || failed) return false;
      if (frame) {
        show(unit);
        return true;
      }
      wanted = unit;
      if (!pending) {
        pending = load().finally(() => { pending = undefined; });
        settled = pending;
      }
      return true;
    },
    isOpen: () => !disposed && !failed && (frame ? boot.bridge.isVisible(frame) : pending !== undefined && wanted !== undefined),
    close: () => {
      if (disposed || failed) return false;
      if (frame && boot.bridge.isVisible(frame)) {
        boot.vm.executeReported("HideUIPanel(InspectFrame)", "@webclient/inspect-close");
        return true;
      }
      if (wanted !== undefined) {
        wanted = undefined;
        return true;
      }
      return false;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      wanted = undefined;
      if (frame && boot.bridge.isVisible(frame)) {
        try { boot.vm.executeReported("HideUIPanel(InspectFrame)", "@webclient/inspect-dispose"); } catch { /* teardown */ }
      }
      if (model?.globalString === globalString) model.globalString = undefined;
    },
  };
}
