/**
 * Stock GuildBankFrame as the guild bank: the gate and the lazy, load-on-demand owner. The C API is
 * FrameXmlGuildBank.ts; the native wiring (ui/GuildBank.ts stepping aside) is FrameXmlGuildBankMount.ts.
 *
 * Blizzard_GuildBankUI is load-on-demand (its TOC: `## LoadOnDemand: 1`; UIParent's
 * GuildBankFrame_LoadUI), and the first guild bank of a session loads it through the host path the
 * auction house uses (FrameXmlAuctionOwner.ts): `boot.loadAddon` → `renderer.addRoots` →
 * `renderer.sync` → gate → `model.owned`, whose edge fires GUILDBANKFRAME_OPENED for a bank already
 * open and answered. Lua's LoadAddOn is only a status view here. The native window stays the visible
 * owner until the gate passes, so a failed load or gate leaves the guild bank exactly as it was; the
 * add-on costs nothing at boot. Its icon picker reads the macro item icons, whose gateway list is
 * fetched beside the load (never at boot).
 *
 * The add-on declares two UIParent children, GuildBankFrame and GuildBankPopupFrame (the tab icon
 * picker); `result.roots` is empty.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlGuildBankModel } from "./FrameXmlGuildBank.js";
import type { FrameXmlGuildBankOwner } from "./FrameXmlGuildBankController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

export const FRAMEXML_GUILDBANK_ADDON = "Blizzard_GuildBankUI";

/** The seam fields the owner reads: the model, and the macro icon list the tab icon picker shares. */
export interface FrameXmlGuildBankSeam {
  readonly guildBank?: FrameXmlGuildBankModel | undefined;
  readonly macros?: { loadIcons(): Promise<void> } | undefined;
}

/** `NUM_GUILDBANK_COLUMNS` × `NUM_SLOTS_PER_GUILDBANK_GROUP`, `MAX_GUILDBANK_TABS`, the picker's 16 icons. */
const COLUMNS = 7;
const SLOTS_PER_COLUMN = 14;
const TABS = 6;
const POPUP_ICONS = 16;

/** Named stock frames the guild bank needs: widget type, the ancestor it lives in, its scripts. */
const GUILDBANK_FRAMES: readonly (readonly [name: string, type: string, ancestor: string, scripts: readonly string[]])[] = [
  ["GuildBankFrame", "Frame", "UIParent", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["GuildBankFrameTab1", "Button", "GuildBankFrame", ["OnClick"]],
  ["GuildBankFrameTab2", "Button", "GuildBankFrame", ["OnClick"]],
  ["GuildBankFrameTab3", "Button", "GuildBankFrame", ["OnClick"]],
  ["GuildBankFrameTab4", "Button", "GuildBankFrame", ["OnClick"]],
  ["GuildBankFrameDepositButton", "Button", "GuildBankFrame", ["OnClick"]],
  ["GuildBankFrameWithdrawButton", "Button", "GuildBankFrame", ["OnClick"]],
  ["GuildBankMoneyFrame", "Frame", "GuildBankFrame", ["OnEvent"]],
  ["GuildBankWithdrawMoneyFrame", "Frame", "GuildBankFrame", ["OnEvent"]],
  ["GuildBankFrameBuyInfo", "Frame", "GuildBankFrame", ["OnShow"]],
  ["GuildBankFramePurchaseButton", "Button", "GuildBankFrameBuyInfo", ["OnClick"]],
  ["GuildBankFrameLog", "Frame", "GuildBankFrame", []],
  ["GuildBankMessageFrame", "ScrollingMessageFrame", "GuildBankFrameLog", []],
  ["GuildBankTransactionsScrollFrame", "ScrollFrame", "GuildBankFrameLog", []],
  ["GuildBankInfo", "Frame", "GuildBankFrame", ["OnHide"]],
  ["GuildBankInfoSaveButton", "Button", "GuildBankInfo", ["OnClick"]],
  ["GuildBankTabInfoEditBox", "EditBox", "GuildBankInfo", ["OnTextChanged"]],
  ["GuildBankPopupFrame", "Frame", "UIParent", ["OnShow"]],
  ["GuildBankPopupEditBox", "EditBox", "GuildBankPopupFrame", []],
  ["GuildBankPopupOkayButton", "Button", "GuildBankPopupFrame", ["OnClick"]],
  ["GuildBankPopupCancelButton", "Button", "GuildBankPopupFrame", ["OnClick"]],
];

/** The registrations stock makes (Blizzard_GuildBankUI.lua:86-96, UIParent.lua:210-211, MoneyFrame.lua) that the model fires. */
const GUILDBANK_EVENTS: readonly (readonly [frame: string, events: readonly string[]])[] = [
  ["GuildBankFrame", ["GUILDBANKBAGSLOTS_CHANGED", "GUILDBANK_ITEM_LOCK_CHANGED", "GUILDBANK_UPDATE_TABS",
    "GUILDBANK_UPDATE_MONEY", "GUILDBANK_UPDATE_WITHDRAWMONEY", "GUILDBANKLOG_UPDATE", "GUILDBANK_UPDATE_TEXT",
    "GUILDBANK_TEXT_CHANGED"]],
  ["GuildBankMoneyFrame", ["GUILDBANK_UPDATE_MONEY"]],
  ["GuildBankWithdrawMoneyFrame", ["GUILDBANK_UPDATE_WITHDRAWMONEY"]],
  ["UIParent", ["GUILDBANKFRAME_OPENED", "GUILDBANKFRAME_CLOSED"]],
];

/** Whether a script body is only `--` line comments and blank lines (a `--[[` long comment is not judged). */
function commentOnlyScript(source: string): boolean {
  for (const line of source.split("\n")) {
    const text = line.trim();
    if (text !== "" && (!text.startsWith("--") || /^--\[=*\[/.test(text))) return false;
  }
  return true;
}

/**
 * GuildBankItemButtonTemplate's `<OnUpdate>` is only a comment (`--GuildBankItemButton_OnUpdate(self,
 * elapsed);`), yet an XML body puts its frame in the runtime's per-frame OnUpdate dispatch. Measured
 * over the MPQ with the canned vault in bank mode, the 98 slot buttons took the HUD's OnUpdate tick
 * from 32 handlers and 0.78 ms to 130 and 24.8 ms (node), 1.4 to 20.9 ms in Chrome. A body that runs
 * nothing is replaced by SetScript(nil), which drops the button from that dispatch; one with a
 * statement, or a handler already set from Lua, is left alone. Answers how many were dropped.
 */
export function dropFrameXmlGuildBankNoOpUpdates(boot: Pick<FrameXmlBoot, "bridge">): number {
  let dropped = 0;
  for (let column = 1; column <= COLUMNS; column += 1) {
    for (let slot = 1; slot <= SLOTS_PER_COLUMN; slot += 1) {
      const button = boot.bridge.getFrame(`GuildBankColumn${column}Button${slot}`);
      const source = button?.scriptSources.get("OnUpdate");
      if (!button || source === undefined || button.scripts.has("OnUpdate") || !boot.bridge.hasScript(button, "OnUpdate")
        || !commentOnlyScript(source)) continue;
      if (boot.bridge.SetScript(button, "OnUpdate", null)) dropped += 1;
    }
  }
  return dropped;
}

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

export interface FrameXmlGuildBankGateResult {
  readonly frame: FrameXmlFrame;
}

/**
 * Take every stock guild bank frame off the screen after a failed gate or load: muted, so
 * GuildBankFrame's OnHide → CloseGuildBankFrame keeps the bank for the native window, and silent;
 * stock's HideUIPanel first (it frees UIParent's doublewide slot), the bridge if that fails too.
 */
function hideStockGuildBankFrames(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  model: FrameXmlGuildBankModel | undefined,
): void {
  const hide = (): void => {
    try {
      frameXmlSilentProbe(boot, "webclient/guildbank-aside", `
        if type(GuildBankFrame) == "table" and GuildBankFrame:IsShown() then HideUIPanel(GuildBankFrame) end
        return 1
      `, 1);
    } catch { /* the bridge below */ }
    for (const name of ["GuildBankFrame", "GuildBankPopupFrame"]) {
      const frame = boot.bridge.getFrame(name);
      if (frame?.visible) boot.bridge.Hide(frame);
    }
  };
  if (model) model.muted(hide); else hide();
}

/**
 * Structural, rendered and transactional proof that the loaded Blizzard_GuildBankUI can own the bank.
 *
 * Every named control, the six tab buttons, the ninety-eight slot buttons and the sixteen icon-picker
 * buttons must be the stock widget in its place with its scripts; GuildBankFrame, a tab and a slot
 * must be rendered; the registrations the model fires must be in place. Then one silent, muted pass
 * shows GuildBankFrame, visits the log, money-log and info tabs and hides it: no PlaySound and no
 * packet — the tabs query the log, the money log and the text, and OnHide calls CloseGuildBankFrame,
 * which the muted model swallows. Any new Lua error or bridge diagnostic, or a tab that did not
 * switch, fails it.
 */
export function frameXmlGuildBankGate(
  seam: { readonly guildBank?: FrameXmlGuildBankModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlGuildBankGateResult | undefined {
  let passStarted = false;
  try {
    const model = seam.guildBank;
    if (!model) return undefined;
    const frames = new Map<string, FrameXmlFrame>();
    const lookup = (name: string): FrameXmlFrame | undefined => frames.get(name) ?? boot.bridge.getFrame(name);
    const proves = (name: string, type: string, ancestorName: string, scripts: readonly string[]): boolean => {
      const frame = boot.bridge.getFrame(name);
      const ancestor = lookup(ancestorName);
      if (!frame || !ancestor || frame.type !== type || frame === ancestor || !frameDescendsFrom(frame, ancestor)
        || !scripts.every((script) => boot.bridge.hasScript(frame, script))) return false;
      frames.set(name, frame);
      return true;
    };
    for (const [name, type, ancestor, scripts] of GUILDBANK_FRAMES) if (!proves(name, type, ancestor, scripts)) return undefined;
    const root = frames.get("GuildBankFrame")!;
    if (root.parent?.name !== "UIParent" || root.visible) return undefined;
    for (let tab = 1; tab <= TABS; tab += 1) {
      if (!proves(`GuildBankTab${tab}`, "Frame", "GuildBankFrame", [])
        || !proves(`GuildBankTab${tab}Button`, "CheckButton", `GuildBankTab${tab}`, ["OnClick"])) return undefined;
    }
    for (let column = 1; column <= COLUMNS; column += 1) {
      if (!proves(`GuildBankColumn${column}`, "Frame", "GuildBankFrame", [])) return undefined;
      for (let slot = 1; slot <= SLOTS_PER_COLUMN; slot += 1) {
        if (!proves(`GuildBankColumn${column}Button${slot}`, "Button", `GuildBankColumn${column}`,
          ["OnClick", "OnEnter", "OnDragStart", "OnReceiveDrag"])) return undefined;
      }
    }
    for (let icon = 1; icon <= POPUP_ICONS; icon += 1) {
      if (!proves(`GuildBankPopupButton${icon}`, "CheckButton", "GuildBankPopupFrame", ["OnClick"])) return undefined;
    }
    for (const name of ["GuildBankFrame", "GuildBankFrameTab1", "GuildBankTab1Button", "GuildBankColumn1Button1"]) {
      const frame = lookup(name)!;
      if (!renderedFrameElement(renderer.elementFor(frame), frame)) return undefined;
    }
    for (const [name, events] of GUILDBANK_EVENTS) {
      const frame = lookup(name);
      if (!frame || !events.every((event) => frame.registeredEvents.has(event))) return undefined;
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    // From here the pass may have shown GuildBankFrame: any failure takes it back off the screen.
    passStarted = true;
    const probe = model.muted(() => frameXmlSilentProbe(boot, "webclient/guildbank-gate", `
      ShowUIPanel(GuildBankFrame)
      local shown = (GuildBankFrame:IsShown() and GuildBankFrame.mode == "bank") and 1 or 0
      GuildBankFrameTab_OnClick(GuildBankFrameTab2, 2)
      local log = GuildBankFrame.mode == "log" and 1 or 0
      GuildBankFrameTab_OnClick(GuildBankFrameTab3, 3)
      local moneylog = (GuildBankFrame.mode == "moneylog" and GuildBankFrameLog:IsShown()) and 1 or 0
      GuildBankFrameTab_OnClick(GuildBankFrameTab4, 4)
      local info = (GuildBankFrame.mode == "tabinfo" and GuildBankInfo:IsShown()) and 1 or 0
      GuildBankFrameTab_OnClick(GuildBankFrameTab1, 1)
      HideUIPanel(GuildBankFrame)
      return shown, log, moneylog, info, GuildBankFrame:IsShown() and 1 or 0
    `, 5));
    const [opened, log, moneyLog, info, stillShown] = (probe ?? []).map((value) => Number(value));
    if (!probe || opened !== 1 || log !== 1 || moneyLog !== 1 || info !== 1 || stillShown !== 0 || root.visible
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) {
      hideStockGuildBankFrames(boot, model);
      return undefined;
    }
    return { frame: root };
  } catch {
    if (passStarted) {
      try { hideStockGuildBankFrames(boot, seam.guildBank); } catch { /* the owner's failure path hides it too */ }
    }
    return undefined;
  }
}

/**
 * GetGuildBankTabInfo and GetNumGuildBankTabs are the guild frame's seam names (FrameXmlGuild.ts),
 * whose tab info is the rank editor's name and icon; the vault needs all six values — isViewable,
 * canDeposit, numWithdrawals, remainingWithdrawals — from the per-tab cache that survives WorldClient's
 * one held tab. Before the add-on loads (its OnLoad already reads them), both names are pointed at the
 * vault's flat `WebClientGuildBank*` answers; the rank editor reads the same name and icon through them.
 * Retire this once the guild frame's own names answer the six values.
 */
export function installFrameXmlGuildBankPreload(boot: Pick<FrameXmlBoot, "vm">): boolean {
  const installed = frameXmlSilentProbe(boot, "webclient/guildbank-preload", `
    if type(WebClientGuildBankTabInfo) ~= "function" or type(WebClientGuildBankNumTabs) ~= "function" then return 0 end
    GetGuildBankTabInfo = function(tab) return WebClientGuildBankTabInfo(tab) end
    GetNumGuildBankTabs = function() return WebClientGuildBankNumTabs() end
    return 1
  `, 1);
  return Number(installed?.[0]) === 1;
}

function stubCalls(boot: Pick<FrameXmlBoot, "binder">, method: string): number {
  return boot.binder.stubDiagnostics
    .filter((record) => record.widgetType === "GameTooltip" && record.method === method)
    .reduce((sum, record) => sum + record.calls, 0);
}

/**
 * GameTooltip:SetGuildBankItem as a per-frame Lua field, only while the widget binder still answers it
 * with its recorded no-op (requested from the renderer lane: it belongs in GlueWidgets beside
 * SetInboxItem, scratchpad NEEDS-RZ.md). It shows the slot's exact link — enchant, gems, suffix —
 * through SetHyperlink, and hides the tooltip for an empty slot. A real widget method is detected by
 * the probe recording no stub call, and then nothing is installed.
 */
export function installFrameXmlGuildBankTooltipFallback(boot: Pick<FrameXmlBoot, "vm" | "binder">): boolean {
  const before = stubCalls(boot, "SetGuildBankItem");
  const probed = frameXmlSilentProbe(boot, "webclient/guildbank-tooltip-probe", `
    if type(GameTooltip) ~= "table" or type(GameTooltip.SetGuildBankItem) ~= "function" then return 0 end
    if rawget(GameTooltip, "SetGuildBankItem") ~= nil then return 0 end
    GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")
    GameTooltip:SetGuildBankItem(1, 1)
    GameTooltip:Hide()
    return 1
  `, 1);
  if (Number(probed?.[0]) !== 1 || stubCalls(boot, "SetGuildBankItem") <= before) return false;
  const done = frameXmlSilentProbe(boot, "webclient/guildbank-tooltip", `
    GameTooltip.SetGuildBankItem = function(self, tab, slot)
      local link = GetGuildBankItemLink(tab, slot)
      if link then return self:SetHyperlink(link) end
      self:Hide()
    end
    return 1
  `, 1);
  return Number(done?.[0]) === 1;
}

/**
 * GetCoinText(amount, separator), which the money log reaches through MoneyFrame.lua's
 * GetDenominationsFromCopper (`GetCoinText(money, " ")`), only while the name is still the stub
 * floor's (it answers nil). Measured before this, over the canned vault: every money-log line read
 * «Аэлинда кладет на счет nil». The body follows the API's documented shape — the denominations
 * present, largest first, from the ruRU GOLD_AMOUNT/SILVER_AMOUNT/COPPER_AMOUNT (whose `|4` plurals the
 * text renderer resolves), copper alone for zero, joined by the separator (", " by default); not
 * measured against Wow.exe. A real binding answers a string and is left alone.
 */
export function installFrameXmlGuildBankCoinText(boot: Pick<FrameXmlBoot, "vm">): boolean {
  const installed = frameXmlSilentProbe(boot, "webclient/guildbank-coin-text", `
    if type(GetCoinText) == "function" and GetCoinText(1) ~= nil then return 0 end
    GetCoinText = function(amount, separator)
      amount = floor(tonumber(amount) or 0)
      if amount < 0 then amount = 0 end
      local gold = floor(amount / COPPER_PER_GOLD)
      local silver = floor((amount - gold * COPPER_PER_GOLD) / COPPER_PER_SILVER)
      local copper = mod(amount, COPPER_PER_SILVER)
      local parts = {}
      if gold > 0 then parts[#parts + 1] = format(GOLD_AMOUNT, gold) end
      if silver > 0 then parts[#parts + 1] = format(SILVER_AMOUNT, silver) end
      if copper > 0 or #parts == 0 then parts[#parts + 1] = format(COPPER_AMOUNT, copper) end
      return table.concat(parts, separator or ", ")
    end
    return 1
  `, 1);
  return Number(installed?.[0]) === 1;
}

export interface FrameXmlGuildBankNativeWindow {
  /** The native window steps aside (the stock GuildBankFrame now shows the bank). */
  hide(): void;
  /** The native window repaints whatever bank is open (teardown, a failed load). */
  show(): void;
}

export interface FrameXmlLazyGuildBankOwner extends FrameXmlGuildBankOwner {
  /** Start the add-on load for an open bank; a no-op once loaded, loading or failed. */
  begin(): void;
  /** Settles when the current load attempt has finished (tests, the preview). */
  readonly settled: Promise<void>;
  readonly loaded: boolean;
  readonly failed: boolean;
}

/**
 * The lazy owner. `begin` starts Blizzard_GuildBankUI's load; the gate then hands the model to stock
 * (`owned`), which shows the bank already open and every later one. A failure leaves `owned` false and
 * the native window in charge for the rest of the session.
 */
export function createLazyFrameXmlGuildBankOwner(
  seam: FrameXmlGuildBankSeam,
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "binder" | "loadAddon">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
  native: FrameXmlGuildBankNativeWindow,
  onFailure?: (reason: string) => void,
): FrameXmlLazyGuildBankOwner {
  const model = seam.guildBank;
  let frame: FrameXmlFrame | undefined;
  let pending: Promise<void> | undefined;
  let settled: Promise<void> = Promise.resolve();
  let failed = model === undefined;
  let disposed = false;
  // This owner's own hook on the model, so a stale owner never unbinds a newer owner's.
  const openRequest = (): void => owner.begin();
  const fail = (reason: string): void => {
    if (disposed || failed) return;
    failed = true;
    if (model) {
      if (model.onOpenRequest === openRequest) model.onOpenRequest = undefined;
      model.owned = false;
    }
    // No stock guild bank frame stays on screen beside the native window it hands the bank back to.
    try { hideStockGuildBankFrames(boot, model); } catch { /* a torn VM shows nothing */ }
    try { native.show(); } catch { /* the native window is already the visible owner */ }
    onFailure?.(reason);
  };
  const load = async (): Promise<void> => {
    try {
      // The tab icon picker's list, not awaited: its failure only leaves the picker with fewer icons.
      void seam.macros?.loadIcons().catch(() => undefined);
      if (!installFrameXmlGuildBankPreload(boot)) { fail("the vault's tab info is not bound"); return; }
      const result = await boot.loadAddon(FRAMEXML_GUILDBANK_ADDON);
      if (disposed) return;
      if (!result.ok) { fail(`${FRAMEXML_GUILDBANK_ADDON}: ${result.message ?? result.status}`); return; }
      renderer.addRoots(result.roots);
      // The add-on parents GuildBankFrame into UIParent, so its roots are empty: reconcile explicitly.
      renderer.sync();
      dropFrameXmlGuildBankNoOpUpdates(boot);
      const gate = frameXmlGuildBankGate(seam, boot, renderer);
      if (!gate || !model) { fail("the stock GuildBankFrame tree did not pass its gate"); return; }
      frame = gate.frame;
      installFrameXmlGuildBankTooltipFallback(boot);
      installFrameXmlGuildBankCoinText(boot);
      // The edge: GUILDBANKFRAME_OPENED for a bank that is open and answered (UIParent → ShowUIPanel).
      model.owned = true;
      if (boot.bridge.isVisible(frame)) native.hide();
    } catch (error) {
      fail(`${FRAMEXML_GUILDBANK_ADDON}: ${String(error)}`);
    }
  };
  const owner: FrameXmlLazyGuildBankOwner = {
    get loaded() { return frame !== undefined && !failed; },
    get failed() { return failed; },
    get settled() { return settled; },
    begin: () => {
      if (disposed || failed || pending || frame) return;
      pending = load().finally(() => { pending = undefined; });
      settled = pending;
    },
    isOpen: () => {
      if (disposed || failed) return false;
      if (frame && model?.owned) return boot.bridge.isVisible(frame);
      return pending !== undefined && model?.bankOpen() === true;
    },
    ownsWindow: () => !disposed && !failed && frame !== undefined && model?.owned === true,
    close: () => {
      if (disposed || failed) return false;
      if (frame && boot.bridge.isVisible(frame)) {
        boot.vm.executeReported("HideUIPanel(GuildBankFrame)", "@webclient/guildbank-close");
        return true;
      }
      if (pending && model?.bankOpen()) {
        // The native window is showing this visit while the add-on loads; the bank itself closes.
        model.close();
        return true;
      }
      return false;
    },
    hide: () => {
      if (!frame || !boot.bridge.isVisible(frame)) return;
      // Teardown keeps the bank open for the native window: OnHide's CloseGuildBankFrame is muted.
      const hideStock = (): void => { boot.vm.executeReported("HideUIPanel(GuildBankFrame)", "@webclient/guildbank-hide"); };
      if (model) model.muted(hideStock); else hideStock();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (model) {
        if (model.onOpenRequest === openRequest) model.onOpenRequest = undefined;
        model.owned = false;
      }
    },
  };
  if (model && !failed) model.onOpenRequest = openRequest;
  return owner;
}
