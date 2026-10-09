/**
 * Stock AuctionFrame as the auction house: the gate and the lazy, load-on-demand owner. The C API is
 * FrameXmlAuction.ts; the native wiring (the `#auction-window` step-aside) is FrameXmlAuctionMount.ts.
 *
 * Blizzard_AuctionUI is load-on-demand (its TOC: `## LoadOnDemand: 1`), and the first auctioneer of a
 * session loads it through the host path the trainer uses (FrameXmlWorldMount
 * createLazyFrameXmlTrainerOwner): `boot.loadAddon` → `renderer.addRoots` → `renderer.sync` → gate →
 * `model.owned`, whose edge fires AUCTION_HOUSE_SHOW for the house already open. Lua's LoadAddOn is
 * only a status view here. The native window stays the visible owner until the gate passes, so a
 * failed load or gate leaves the auction house exactly as it was; the add-on costs nothing at boot.
 *
 * The add-on declares two UIParent children, AuctionFrame (Browse/Bids/Auctions) and
 * AuctionProgressFrame (the multisell bar), plus AuctionDressUpFrame; `result.roots` is empty.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlAuctionModel } from "./FrameXmlAuction.js";
import type { FrameXmlAuctionOwner } from "./FrameXmlAuctionController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import { FRAMEXML_HOST_HOOK_GLOBAL, withFrameXmlHostHooks } from "./FrameXmlHostHooks.js"; // L5b 3.27

export const FRAMEXML_AUCTION_ADDON = "Blizzard_AuctionUI";

/** `NUM_BROWSE_TO_DISPLAY`, `NUM_BIDS_TO_DISPLAY`, `NUM_AUCTIONS_TO_DISPLAY`, `NUM_FILTERS_TO_DISPLAY`. */
const ROWS: readonly (readonly [prefix: string, count: number, parent: string])[] = [
  ["BrowseButton", 8, "AuctionFrameBrowse"],
  ["BidButton", 9, "AuctionFrameBid"],
  ["AuctionsButton", 9, "AuctionFrameAuctions"],
  ["AuctionFilterButton", 15, "AuctionFrameBrowse"],
];

/** Named stock frames the auction house needs: widget type, the ancestor it lives in, its scripts. */
const AUCTION_FRAMES: readonly (readonly [name: string, type: string, ancestor: string, scripts: readonly string[]])[] = [
  ["AuctionFrame", "Frame", "UIParent", ["OnLoad", "OnShow", "OnHide"]],
  ["AuctionFrameTab1", "Button", "AuctionFrame", ["OnClick"]],
  ["AuctionFrameTab2", "Button", "AuctionFrame", ["OnClick"]],
  ["AuctionFrameTab3", "Button", "AuctionFrame", ["OnClick"]],
  ["AuctionFrameCloseButton", "Button", "AuctionFrame", ["OnClick"]],
  ["AuctionFrameBrowse", "Frame", "AuctionFrame", ["OnLoad", "OnShow", "OnEvent"]],
  ["AuctionFrameBid", "Frame", "AuctionFrame", ["OnLoad", "OnShow", "OnEvent"]],
  ["AuctionFrameAuctions", "Frame", "AuctionFrame", ["OnLoad", "OnShow", "OnEvent"]],
  ["BrowseName", "EditBox", "AuctionFrameBrowse", []],
  ["BrowseMinLevel", "EditBox", "AuctionFrameBrowse", []],
  ["BrowseMaxLevel", "EditBox", "AuctionFrameBrowse", []],
  ["IsUsableCheckButton", "CheckButton", "AuctionFrameBrowse", ["OnClick"]],
  ["BrowseSearchButton", "Button", "AuctionFrameBrowse", ["OnClick"]],
  ["BrowsePrevPageButton", "Button", "AuctionFrameBrowse", ["OnClick"]],
  ["BrowseNextPageButton", "Button", "AuctionFrameBrowse", ["OnClick"]],
  ["BrowseBidButton", "Button", "AuctionFrameBrowse", ["OnClick"]],
  ["BrowseBuyoutButton", "Button", "AuctionFrameBrowse", ["OnClick"]],
  ["BrowseScrollFrame", "ScrollFrame", "AuctionFrameBrowse", []],
  ["BidBidButton", "Button", "AuctionFrameBid", ["OnClick"]],
  ["BidBuyoutButton", "Button", "AuctionFrameBid", ["OnClick"]],
  ["BidScrollFrame", "ScrollFrame", "AuctionFrameBid", []],
  ["AuctionsItemButton", "Button", "AuctionFrameAuctions", ["OnClick", "OnEvent"]],
  ["AuctionsCreateAuctionButton", "Button", "AuctionFrameAuctions", ["OnClick"]],
  ["AuctionsCancelAuctionButton", "Button", "AuctionFrameAuctions", ["OnClick"]],
  ["AuctionsStackSizeEntry", "EditBox", "AuctionFrameAuctions", []],
  ["AuctionsNumStacksEntry", "EditBox", "AuctionFrameAuctions", []],
  ["AuctionsScrollFrame", "ScrollFrame", "AuctionFrameAuctions", []],
  ["StartPrice", "Frame", "AuctionFrameAuctions", []],
  ["BuyoutPrice", "Frame", "AuctionFrameAuctions", []],
  ["AuctionProgressFrame", "Frame", "UIParent", []],
];

/** The registrations stock makes (Blizzard_AuctionUI.lua:374, :944, :1125-1128, .xml:1437) that the model fires. */
const AUCTION_EVENTS: readonly (readonly [frame: string, events: readonly string[]])[] = [
  ["AuctionFrameBrowse", ["AUCTION_ITEM_LIST_UPDATE"]],
  ["AuctionFrameBid", ["AUCTION_BIDDER_LIST_UPDATE"]],
  ["AuctionFrameAuctions", ["AUCTION_OWNED_LIST_UPDATE", "AUCTION_MULTISELL_START", "AUCTION_MULTISELL_UPDATE", "AUCTION_MULTISELL_FAILURE"]],
  ["AuctionsItemButton", ["NEW_AUCTION_UPDATE"]],
  ["UIParent", ["AUCTION_HOUSE_SHOW", "AUCTION_HOUSE_CLOSED"]],
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

export interface FrameXmlAuctionGateResult {
  readonly frame: FrameXmlFrame;
}

/**
 * Take every stock auction frame off the screen after a failed gate or load. Measured by fault
 * injection before this: a Lua error between the gate's ShowUIPanel and HideUIPanel left AuctionFrame
 * shown beside the native window, and nothing could close it (the failed owner reports it closed).
 * Muted, so AuctionFrame's OnHide → CloseAuctionHouse keeps the house for the native window, and
 * silent; stock's HideUIPanel first (it frees UIParent's panel slot), the bridge if that fails too.
 */
function hideStockAuctionFrames(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  auction: FrameXmlAuctionModel | undefined,
): void {
  const hide = (): void => {
    try {
      frameXmlSilentProbe(boot, "webclient/auction-aside", `
        if type(AuctionFrame) == "table" and AuctionFrame:IsShown() then HideUIPanel(AuctionFrame) end
        return 1
      `, 1);
    } catch { /* the bridge below */ }
    for (const name of ["AuctionFrame", "AuctionProgressFrame"]) {
      const frame = boot.bridge.getFrame(name);
      if (frame?.visible) boot.bridge.Hide(frame);
    }
  };
  if (auction) auction.muted(hide); else hide();
}

/**
 * Structural, rendered and transactional proof that the loaded Blizzard_AuctionUI can own the house.
 *
 * Every named control, the numbered rows of the three lists and the fifteen filter buttons must be
 * the stock widget inside AuctionFrame with its scripts; AuctionFrame and its tabs must be rendered;
 * the registrations the model fires must be in place. Then one silent, muted pass shows AuctionFrame,
 * visits the Bids and Auctions tabs and hides it: no PlaySound, and no packet — stock asks for the bid
 * and owner lists on those tabs and AuctionFrame's OnHide calls CloseAuctionHouse, which the muted
 * model swallows. Any new Lua error or bridge diagnostic, or a tab that did not switch, fails it.
 */
export function frameXmlAuctionGate(
  seam: { readonly auction?: FrameXmlAuctionModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlAuctionGateResult | undefined {
  let passStarted = false;
  try {
    const auction = seam.auction;
    if (!auction) return undefined;
    const frames = new Map<string, FrameXmlFrame>();
    const lookup = (name: string): FrameXmlFrame | undefined => frames.get(name) ?? boot.bridge.getFrame(name);
    for (const [name, type, ancestorName, scripts] of AUCTION_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      const ancestor = lookup(ancestorName);
      if (!frame || !ancestor || frame.type !== type || frame === ancestor || !frameDescendsFrom(frame, ancestor)
        || !scripts.every((script) => boot.bridge.hasScript(frame, script))) return undefined;
      frames.set(name, frame);
    }
    const root = frames.get("AuctionFrame")!;
    if (root.parent?.name !== "UIParent" || root.visible) return undefined;
    for (const [prefix, count, parentName] of ROWS) {
      const parent = frames.get(parentName)!;
      for (let index = 1; index <= count; index += 1) {
        const button = boot.bridge.getFrame(`${prefix}${index}`);
        if (!button || button.type !== "Button" || !frameDescendsFrom(button, parent)
          || !boot.bridge.hasScript(button, "OnClick")) return undefined;
      }
    }
    for (const name of ["AuctionFrame", "AuctionFrameTab1", "AuctionFrameBrowse", "BrowseButton1"]) {
      const frame = lookup(name)!;
      if (!renderedFrameElement(renderer.elementFor(frame), frame)) return undefined;
    }
    for (const [name, events] of AUCTION_EVENTS) {
      const frame = lookup(name);
      if (!frame || !events.every((event) => frame.registeredEvents.has(event))) return undefined;
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    // From here the pass may have shown AuctionFrame: any failure takes it back off the screen.
    passStarted = true;
    const probe = auction.muted(() => frameXmlSilentProbe(boot, "webclient/auction-gate", `
      ShowUIPanel(AuctionFrame)
      local shown = (AuctionFrame:IsShown() and AuctionFrameBrowse:IsShown()) and 1 or 0
      AuctionFrameTab_OnClick(AuctionFrameTab2)
      local bids = (AuctionFrameBid:IsShown() and not AuctionFrameBrowse:IsShown()) and 1 or 0
      AuctionFrameTab_OnClick(AuctionFrameTab3)
      local auctions = (AuctionFrameAuctions:IsShown() and not AuctionFrameBid:IsShown()) and 1 or 0
      AuctionFrameTab_OnClick(AuctionFrameTab1)
      HideUIPanel(AuctionFrame)
      return shown, bids, auctions, AuctionFrame:IsShown() and 1 or 0
    `, 4));
    const [opened, bids, auctions, stillShown] = (probe ?? []).map((value) => Number(value));
    if (!probe || opened !== 1 || bids !== 1 || auctions !== 1 || stillShown !== 0 || root.visible
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) {
      hideStockAuctionFrames(boot, auction);
      return undefined;
    }
    return { frame: root };
  } catch {
    if (passStarted) {
      try { hideStockAuctionFrames(boot, seam.auction); } catch { /* the owner's failure path hides it too */ }
    }
    return undefined;
  }
}

/**
 * AuctionFrameAuctions_OnEvent reads the multisell counts from the legacy `arg1`/`arg2` globals
 * (Blizzard_AuctionUI.lua:1145-1154), and the widget binder gives those globals only to handlers
 * defined outside the stock corpus (GlueWidgets `implicitGlobals: "referenced"`, which counts
 * `interface/addons/blizzard_*` as stock). Measured before this: AUCTION_MULTISELL_START formatted
 * a stale string `arg1` and raised «bad argument #3 to 'format'». The stock handler is re-set
 * through a one-line wrapper defined here, which the binder hands the globals to; the stock
 * function itself is unchanged. Retire it once the binder gives stock add-on functions their args.
 *
 * The runtime also fires OnTextChanged only for typed input, where the client fires it for
 * EditBox:SetNumber/SetText too. The stock stack-size boxes' OnTextChanged is exactly
 * ValidateAuction + UpdateMaximumButtons + UpdateDeposit (Blizzard_AuctionUI.xml:1518-1522), and the
 * three programmatic setters that rely on it — the two «Максимум» buttons and the price-type menu —
 * get it as a post-hook. Retire that once SetText fires OnTextChanged(self, false).
 *
 * AuctionProgressBar inherits CastingBarFrameTemplate and blanks its OnEvent/OnShow/OnUpdate with
 * empty elements (Blizzard_AuctionUI.xml:1929-1931); the XML runtime keeps an inherited handler
 * when the override is empty, so CastingBarFrame_OnUpdate ran on the progress bar every frame.
 * Measured in the RICH route before this: 94 «castingbarframe.lua:291 attempt to compare number
 * with nil» during one three-lot multisell. The three handlers are cleared as the XML declares.
 *
 * (The item names' quality colour — FontString:SetVertexColor(ITEM_QUALITY_COLORS[quality]) at
 * Blizzard_AuctionUI.lua:819, :1015, :1244, :1268, :1466 — is the binder's own: on a FontString the
 * vertex colour is the text colour, GlueWidgets.ts.)
 */
export function installFrameXmlAuctionAdapters(boot: Pick<FrameXmlBoot, "vm" | "bridge">): boolean { // L5b 3.27: bridge
  // L5b 3.27: the buttons' hooks are the host's (FrameXmlHostHooks.ts): an add-on's SetScript keeps them.
  const installed = withFrameXmlHostHooks(boot, () => frameXmlSilentProbe(boot, "webclient/auction-adapters", `
    if type(AuctionFrameAuctions) ~= "table" or type(AuctionFrameAuctions_OnEvent) ~= "function" then return 0 end
    AuctionFrameAuctions:SetScript("OnEvent", function(self, event, ...) return AuctionFrameAuctions_OnEvent(self, event, ...) end)
    local function revalidate()
      AuctionsFrameAuctions_ValidateAuction()
      if type(AuctionsItemButton.stackCount) == "number" and type(AuctionsItemButton.totalCount) == "number" then
        UpdateMaximumButtons()
      end
      UpdateDeposit()
    end
    -- The XML bound SetMaxStackSize itself at load, so the buttons are hooked, not the global.
    ${FRAMEXML_HOST_HOOK_GLOBAL}(AuctionsStackSizeMaxButton, "OnClick", revalidate) -- L5b 3.27 (was :HookScript)
    ${FRAMEXML_HOST_HOOK_GLOBAL}(AuctionsNumStacksMaxButton, "OnClick", revalidate) -- L5b 3.27 (was :HookScript)
    -- PriceDropDown_Initialize reads this global each time the menu opens.
    hooksecurefunc("PriceDropDown_OnClick", revalidate)
    for _, script in ipairs({ "OnEvent", "OnShow", "OnUpdate" }) do AuctionProgressBar:SetScript(script, nil) end
    return 1
  `, 1)); // L5b 3.27: withFrameXmlHostHooks
  return Number(installed?.[0]) === 1;
}

/**
 * Blizzard_AuctionDressUp.xml's AuctionDressUpFrame runs SetAuctionDressUpBackground in its OnLoad,
 * which concatenates DressUpTexturePath() — a function of FrameXML's DressUpFrame.lua, a file the
 * bounded vertical does not load. Measured before this: the add-on load raised «attempt to
 * concatenate a nil value (local 'texture')» at blizzard_auctiondressup.lua:21. When the corpus has
 * not defined it, the stock body (DressUpFrame.lua:12-26) is defined before the add-on loads. The
 * production vertical now carries DressUpFrame.xml (FrameXmlDressUp.ts), so there this finds the
 * stock function and does nothing; it stays for a corpus subset without it.
 */
export function installFrameXmlAuctionPreload(boot: Pick<FrameXmlBoot, "vm">): boolean {
  const installed = frameXmlSilentProbe(boot, "webclient/auction-preload", `
    if rawget(_G, "DressUpTexturePath") ~= nil then return 1 end
    DressUpTexturePath = function()
      local race, fileName = UnitRace("player")
      if ( strupper(fileName) == "GNOME" ) then
        fileName = "Dwarf"
      elseif ( strupper(fileName) == "TROLL" ) then
        fileName = "Orc"
      end
      if ( not fileName ) then
        fileName = "Orc"
      end
      return "Interface\\\\DressUpFrame\\\\DressUpBackground-"..fileName
    end
    return 1
  `, 1);
  return Number(installed?.[0]) === 1;
}

export interface FrameXmlAuctionNativeWindow {
  /** The native window steps aside (the stock AuctionFrame now shows the house). */
  hide(): void;
  /** The native window repaints whatever house is open (teardown, a failed load). */
  show(): void;
}

export interface FrameXmlLazyAuctionOwner extends FrameXmlAuctionOwner {
  /** Start the add-on load for an open house; a no-op once loaded, loading or failed. */
  begin(): void;
  /** Settles when the current load attempt has finished (tests, the preview). */
  readonly settled: Promise<void>;
  readonly loaded: boolean;
  readonly failed: boolean;
}

/**
 * The lazy owner. `begin` starts Blizzard_AuctionUI's load; the gate then hands the model to stock
 * (`owned`), which shows the house already open and every later one. A failure leaves `owned` false
 * and the native window in charge for the rest of the session.
 */
export function createLazyFrameXmlAuctionOwner(
  seam: { readonly auction?: FrameXmlAuctionModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "binder" | "loadAddon">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
  native: FrameXmlAuctionNativeWindow,
  onFailure?: (reason: string) => void,
): FrameXmlLazyAuctionOwner {
  const model = seam.auction;
  let frame: FrameXmlFrame | undefined;
  let pending: Promise<void> | undefined;
  let settled: Promise<void> = Promise.resolve();
  let failed = model === undefined;
  let disposed = false;
  // This owner's own hooks on the model, so a stale owner never unbinds a newer owner's.
  const openRequest = (): void => owner.begin();
  const globalStrings = (name: string): string | undefined => boot.vm.globalString(name);
  const fail = (reason: string): void => {
    if (disposed || failed) return;
    failed = true;
    if (model) {
      if (model.onOpenRequest === openRequest) model.onOpenRequest = undefined;
      model.owned = false;
    }
    // No stock auction frame stays on screen beside the native window it hands the house back to.
    try { hideStockAuctionFrames(boot, model); } catch { /* a torn VM shows nothing */ }
    try { native.show(); } catch { /* the native window is already the visible owner */ }
    onFailure?.(reason);
  };
  const load = async (): Promise<void> => {
    try {
      installFrameXmlAuctionPreload(boot);
      const result = await boot.loadAddon(FRAMEXML_AUCTION_ADDON);
      if (disposed) return;
      if (!result.ok) { fail(`${FRAMEXML_AUCTION_ADDON}: ${result.message ?? result.status}`); return; }
      renderer.addRoots(result.roots);
      // The add-on parents AuctionFrame into UIParent, so its roots are empty: reconcile explicitly.
      renderer.sync();
      if (!installFrameXmlAuctionAdapters(boot)) { fail("the stock AuctionFrameAuctions handler is missing"); return; }
      const gate = frameXmlAuctionGate(seam, boot, renderer);
      if (!gate || !model) { fail("the stock AuctionFrame tree did not pass its gate"); return; }
      frame = gate.frame;
      // The edge: AUCTION_HOUSE_SHOW for a house that is still open (UIParent → AuctionFrame_Show).
      model.owned = true;
      if (boot.bridge.isVisible(frame)) native.hide();
    } catch (error) {
      fail(`${FRAMEXML_AUCTION_ADDON}: ${String(error)}`);
    }
  };
  const owner: FrameXmlLazyAuctionOwner = {
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
      if (frame) return boot.bridge.isVisible(frame);
      return pending !== undefined && model?.houseOpen() === true;
    },
    ownsWindow: () => !disposed && !failed && frame !== undefined && model?.owned === true,
    close: () => {
      if (disposed || failed) return false;
      if (frame && boot.bridge.isVisible(frame)) {
        boot.vm.executeReported("HideUIPanel(AuctionFrame)", "@webclient/auction-close");
        return true;
      }
      if (pending && model?.houseOpen()) {
        // The native window is showing this visit while the add-on loads; the house itself closes.
        model.close();
        return true;
      }
      return false;
    },
    hide: () => {
      if (!frame || !boot.bridge.isVisible(frame)) return;
      // Teardown keeps the house open for the native window: OnHide's CloseAuctionHouse is muted.
      const hideStock = (): void => { boot.vm.executeReported("HideUIPanel(AuctionFrame)", "@webclient/auction-hide"); };
      if (model) model.muted(hideStock); else hideStock();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (model) {
        if (model.onOpenRequest === openRequest) model.onOpenRequest = undefined;
        model.owned = false;
        model.releaseGlobalStrings(globalStrings);
      }
    },
  };
  if (model && !failed) model.onOpenRequest = openRequest;
  // GlobalStrings are the boot corpus's: the outbid/won/sold/expired lines need them from login on,
  // before (and without) Blizzard_AuctionUI, as the client prints them from its own packet handler.
  model?.useGlobalStrings(globalStrings);
  return owner;
}
