/**
 * Stock ItemSocketingFrame as the socketing window: the gate and the lazy, load-on-demand owner. The
 * C API is FrameXmlSocketModel.ts (registered by FrameXmlSocketing.ts); the native wiring is
 * FrameXmlSocketMount.ts.
 *
 * Blizzard_ItemSocketingUI is load-on-demand. The first SocketInventoryItem/SocketContainerItem of
 * a session loads it through the host path the trainer and the auction house use: `boot.loadAddon`
 * → `renderer.addRoots` → `renderer.sync` → gate → `model.owned`, whose edge raises
 * SOCKET_INFO_UPDATE for the waiting session; UIParent's own handler (UIParent.lua:990-994) then
 * runs ItemSocketingFrame_LoadUI — the global gem-abilities hooks to add its extraction button —
 * ItemSocketingFrame_Update and ShowUIPanel. Lua's LoadAddOn is only a status view here. A failed
 * load or gate hands the waiting item to the native picker (ui/Socketing.ts) for the session, and
 * the add-on costs nothing at boot.
 *
 * Measured over the client MPQ (tests/framexml-socket-vertical.test.mjs): 4 files, 24,117 bytes,
 * +111 widgets, no roots of its own (ItemSocketingFrame is a UIParent child), no Lua error.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlSocketModel, FrameXmlSocketTarget } from "./FrameXmlSocketModel.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

export const FRAMEXML_SOCKET_ADDON = "Blizzard_ItemSocketingUI";

/** Named stock frames the socketing window needs: widget type, the ancestor it lives in, its scripts. */
const SOCKET_FRAMES: readonly (readonly [name: string, type: string, ancestor: string, scripts: readonly string[]])[] = [
  ["ItemSocketingFrame", "Frame", "UIParent", ["OnLoad", "OnShow", "OnEvent", "OnHide"]],
  ["ItemSocketingScrollFrame", "ScrollFrame", "ItemSocketingFrame", []],
  ["ItemSocketingDescription", "GameTooltip", "ItemSocketingFrame", []],
  ["ItemSocketingSocket1", "Button", "ItemSocketingFrame", ["OnClick", "OnReceiveDrag", "OnEnter", "OnEvent"]],
  ["ItemSocketingSocket2", "Button", "ItemSocketingFrame", ["OnClick", "OnReceiveDrag", "OnEnter", "OnEvent"]],
  ["ItemSocketingSocket3", "Button", "ItemSocketingFrame", ["OnClick", "OnReceiveDrag", "OnEnter", "OnEvent"]],
  ["ItemSocketingSocketButton", "Button", "ItemSocketingFrame", ["OnClick"]],
  ["ItemSocketingCloseButton", "Button", "ItemSocketingFrame", ["OnClick"]],
];

/** The registrations stock makes (Blizzard_ItemSocketingUI.lua:14-15, .xml:129; UIParent.lua:195). */
const SOCKET_EVENTS: readonly (readonly [frame: string, events: readonly string[]])[] = [
  ["ItemSocketingFrame", ["SOCKET_INFO_UPDATE", "SOCKET_INFO_CLOSE"]],
  ["ItemSocketingSocket1", ["SOCKET_INFO_UPDATE"]],
  ["UIParent", ["SOCKET_INFO_UPDATE"]],
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
 * Structural, rendered and transactional proof that the loaded add-on can own socketing.
 *
 * The frame, its three socket buttons, the accept and close buttons and the description tooltip
 * must be the stock widgets with their scripts; the frame and the first socket must be rendered;
 * the registrations the model raises must be in place. Then one silent pass shows and hides the
 * frame through the panel manager — no sound, no packet (no session is open, so the OnHide's
 * CloseSocketInfo has nothing to end). A new Lua error or bridge diagnostic fails it.
 */
export function frameXmlSocketGate(
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlFrame | undefined {
  try {
    const frames = new Map<string, FrameXmlFrame>();
    const lookup = (name: string): FrameXmlFrame | undefined => frames.get(name) ?? boot.bridge.getFrame(name);
    for (const [name, type, ancestorName, scripts] of SOCKET_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      const ancestor = lookup(ancestorName);
      if (!frame || !ancestor || frame.type !== type || frame === ancestor || !frameDescendsFrom(frame, ancestor)
        || !scripts.every((script) => boot.bridge.hasScript(frame, script))) return undefined;
      frames.set(name, frame);
    }
    const root = frames.get("ItemSocketingFrame")!;
    if (root.parent?.name !== "UIParent" || root.visible) return undefined;
    for (const name of ["ItemSocketingFrame", "ItemSocketingSocket1", "ItemSocketingSocketButton"]) {
      const frame = frames.get(name)!;
      if (!renderedFrameElement(renderer.elementFor(frame), frame)) return undefined;
    }
    for (const [name, events] of SOCKET_EVENTS) {
      const frame = lookup(name);
      if (!frame || !events.every((event) => frame.registeredEvents.has(event))) return undefined;
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    // The frame's OnHide calls CloseSocketInfo, which would end the session waiting for this very
    // load: the pass runs with it set aside, and puts it back even when the pass raises.
    const probe = frameXmlSilentProbe(boot, "webclient/socket-gate", `
      local close = CloseSocketInfo
      CloseSocketInfo = function() end
      local ok, shown, hidden = pcall(function()
        ShowUIPanel(ItemSocketingFrame)
        local shown = ItemSocketingFrame:IsShown() and 1 or 0
        HideUIPanel(ItemSocketingFrame)
        return shown, ItemSocketingFrame:IsShown() and 1 or 0
      end)
      CloseSocketInfo = close
      if not ok then error(shown, 0) end
      return shown, hidden
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
 * The three socketing tooltip setters, as per-frame Lua fields, only while the widget binder still
 * answers them with its recorded no-op (they belong in GlueWidgets beside SetInboxItem; requested
 * from the renderer lane). Each is the link-shaped body the other link setters have:
 * ItemSocketingDescription:SetSocketedItem() shows the item with the staged gems in place,
 * :SetSocketGem(i) a staged gem, :SetExistingSocketGem(i) the gem already in the socket. A real
 * widget method is detected by the probe recording no stub call, and nothing is installed then.
 * Returns the methods installed.
 */
export function installFrameXmlSocketTooltipFallbacks(boot: Pick<FrameXmlBoot, "vm" | "binder">): readonly string[] {
  const installed: string[] = [];
  for (const [owner, method, call, fallback] of [
    ["ItemSocketingDescription", "SetSocketedItem", "ItemSocketingDescription:SetSocketedItem()",
      `function(self) local link = WebClientSocketedItemLink() if link then return self:SetHyperlink(link) end self:ClearLines() end`],
    ["GameTooltip", "SetSocketGem", `GameTooltip:SetSocketGem(1)`,
      `function(self, index) local link = GetNewSocketLink(index) if link then return self:SetHyperlink(link) end self:Hide() end`],
    ["GameTooltip", "SetExistingSocketGem", `GameTooltip:SetExistingSocketGem(1)`,
      `function(self, index) local link = GetExistingSocketLink(index) if link then return self:SetHyperlink(link) end self:Hide() end`],
  ] as const) {
    const before = stubCalls(boot, method);
    const probed = frameXmlSilentProbe(boot, "webclient/socket-tooltip-probe", `
      if type(${owner}) ~= "table" or type(${owner}.${method}) ~= "function" then return 0 end
      if rawget(${owner}, "${method}") ~= nil then return 0 end
      ${owner === "GameTooltip" ? `GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")` : ""}
      ${call}
      ${owner === "GameTooltip" ? "GameTooltip:Hide()" : ""}
      return 1
    `, 1);
    if (Number(probed?.[0]) !== 1 || stubCalls(boot, method) <= before) continue;
    // ShoppingTooltip1 shows the gem a replacement destroys (ItemSocketingSocketButton_OnEnter).
    const targets = method === "SetExistingSocketGem" ? ["GameTooltip", "ShoppingTooltip1"] : [owner];
    const assignments = targets.map((target) => `if type(${target}) == "table" then ${target}.${method} = ${fallback} end`).join("\n");
    const done = frameXmlSilentProbe(boot, "webclient/socket-tooltip", `${assignments} return 1`, 1);
    if (Number(done?.[0]) === 1) installed.push(method);
  }
  return installed;
}

export interface FrameXmlSocketNativeWindow {
  /** The native picker for an item, after a failed load or gate (ui/Socketing.ts). */
  open(target: FrameXmlSocketTarget): void;
}

export interface FrameXmlLazySocketOwner {
  /** Whether the stock ItemSocketingFrame is up (or loading for a waiting item). */
  isOpen(): boolean;
  /** Close the stock frame (Escape, the native module's close); false when nothing stock was open. */
  close(): boolean;
  /** Settles when the current load attempt has finished (tests, the preview). */
  readonly settled: Promise<void>;
  readonly loaded: boolean;
  readonly failed: boolean;
  dispose(): void;
}

/**
 * The lazy owner. It listens on the model's `onOpenRequest`: the first request starts the add-on
 * load, the gate hands the model to stock (`owned`), and the waiting session shows. A failure
 * leaves `owned` false, stops listening (FrameXmlSocketing.ts's legacy path answers every later
 * request) and gives the waiting item to the native picker.
 */
export function createLazyFrameXmlSocketOwner(
  seam: { readonly socket?: FrameXmlSocketModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "binder" | "loadAddon">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
  native: FrameXmlSocketNativeWindow,
  onFailure?: (reason: string) => void,
): FrameXmlLazySocketOwner {
  const model = seam.socket;
  let frame: FrameXmlFrame | undefined;
  let pending: Promise<void> | undefined;
  let settled: Promise<void> = Promise.resolve();
  let failed = model === undefined;
  let disposed = false;
  const fail = (reason: string): void => {
    if (disposed || failed) return;
    failed = true;
    const waiting = model?.abandon();
    if (model) {
      if (model.onOpenRequest === openRequest) model.onOpenRequest = undefined;
      model.owned = false;
    }
    const root = boot.bridge.getFrame("ItemSocketingFrame");
    if (root?.visible) {
      try { boot.bridge.Hide(root); } catch { /* the native picker takes over either way */ }
    }
    if (waiting) {
      try { native.open(waiting); } catch { /* nothing else can show it */ }
    }
    onFailure?.(reason);
  };
  const load = async (): Promise<void> => {
    try {
      const result = await boot.loadAddon(FRAMEXML_SOCKET_ADDON);
      if (disposed) return;
      if (!result.ok) { fail(`${FRAMEXML_SOCKET_ADDON}: ${result.message ?? result.status}`); return; }
      renderer.addRoots(result.roots);
      // ItemSocketingFrame is a UIParent child, so the add-on's own root list is empty: reconcile.
      renderer.sync();
      const gated = frameXmlSocketGate(boot, renderer);
      if (!gated || !model) { fail("the stock ItemSocketingFrame tree did not pass its gate"); return; }
      frame = gated;
      installFrameXmlSocketTooltipFallbacks(boot);
      // The edge: SOCKET_INFO_UPDATE for a session still waiting (UIParent → LoadUI, Update, Show).
      model.owned = true;
    } catch (error) {
      fail(`${FRAMEXML_SOCKET_ADDON}: ${String(error)}`);
    }
  };
  const openRequest = (): boolean => {
    if (disposed || failed) return false;
    if (!frame && !pending) {
      pending = load().finally(() => { pending = undefined; });
      settled = pending;
    }
    return true;
  };
  const globalString = (name: string): string | undefined => boot.vm.globalString(name);
  if (model && !failed) {
    model.onOpenRequest = openRequest;
    model.globalString = globalString;
  }
  return {
    get loaded() { return frame !== undefined && !failed; },
    get failed() { return failed; },
    get settled() { return settled; },
    isOpen: () => {
      if (disposed || failed) return false;
      if (frame) return boot.bridge.isVisible(frame);
      return pending !== undefined && model?.active === true;
    },
    close: () => {
      if (disposed || failed || !model?.active) return false;
      // CloseSocketInfo ends the session; stock's SOCKET_INFO_CLOSE handler hides the frame.
      boot.vm.executeReported("CloseSocketInfo()", "@webclient/socket-close");
      return true;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (model) {
        if (model.onOpenRequest === openRequest) model.onOpenRequest = undefined;
        if (model.globalString === globalString) model.globalString = undefined;
        if (model.active && frame && boot.bridge.isVisible(frame)) {
          try { boot.vm.executeReported("CloseSocketInfo()", "@webclient/socket-dispose"); } catch { /* teardown */ }
        }
        model.owned = false;
      }
    },
  };
}
