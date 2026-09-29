/**
 * Stock BarberShopFrame as the barber chair's window: the gate and the lazy, load-on-demand owner.
 * The C API is FrameXmlBarber.ts; the native wiring is FrameXmlBarberMount.ts.
 *
 * Blizzard_BarbershopUI is load-on-demand. The first `SMSG_ENABLE_BARBER_SHOP` of a session asks the
 * gateway for the three tables the frame reads (FrameXmlBarberLive.ts `prepare`), loads the add-on
 * through the host path the trainer and the auction house use (`boot.loadAddon` → `renderer.addRoots`
 * → `renderer.sync` → gate) and then sets `model.owned`, whose edge raises BARBER_SHOP_OPEN for the
 * chair still occupied; UIParent's handler shows the frame (UIParent.lua:998-1003, :1031-1035). The
 * native window keeps the chair until then, and for the session after a failure. Nothing loads while
 * any table is missing — the price table is a new gateway route, so a gateway process older than it
 * keeps the native window, chair by chair, until it is restarted.
 *
 * Measured over the client MPQ (tests/framexml-barber-vertical.test.mjs): 4 files, 12,710 bytes,
 * +85 widgets with the selectors' eight arrows (FrameXmlInspectCorpus.ts; +45 without them), no roots
 * of its own. Before the model answered GetHairCustomization at load, the load raised «attempt to
 * concatenate a nil value (local 'hairCustomization')» (blizzard_barbershopui.lua:82).
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlBarberModel } from "./FrameXmlBarber.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import { withFrameXmlLaneCorpus } from "./FrameXmlInspectCorpus.js";

export const FRAMEXML_BARBER_ADDON = "Blizzard_BarbershopUI";

const BARBER_FRAMES: readonly (readonly [name: string, type: string, ancestor: string, scripts: readonly string[]])[] = [
  ["BarberShopFrame", "Frame", "UIParent", ["OnLoad", "OnShow", "OnHide", "OnEvent"]],
  ["BarberShopFrameOkayButton", "Button", "BarberShopFrame", ["OnClick"]],
  ["BarberShopFrameCancelButton", "Button", "BarberShopFrame", ["OnClick"]],
  ["BarberShopFrameResetButton", "Button", "BarberShopFrame", ["OnClick"]],
  ["BarberShopFrameMoneyFrame", "Frame", "BarberShopFrame", []],
  ["BarberShopBannerFrame", "Frame", "UIParent", ["OnShow", "OnHide"]],
  ...[1, 2, 3, 4].flatMap((index) => [
    [`BarberShopFrameSelector${index}`, "Frame", "BarberShopFrame", []] as const,
    [`BarberShopFrameSelector${index}Prev`, "Button", `BarberShopFrameSelector${index}`, ["OnClick"]] as const,
    [`BarberShopFrameSelector${index}Next`, "Button", `BarberShopFrameSelector${index}`, ["OnClick"]] as const,
  ]),
];

const BARBER_EVENTS: readonly (readonly [frame: string, events: readonly string[]])[] = [
  ["BarberShopFrame", ["BARBER_SHOP_APPEARANCE_APPLIED", "BARBER_SHOP_SUCCESS"]],
  ["UIParent", ["BARBER_SHOP_OPEN", "BARBER_SHOP_CLOSE"]],
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
 * Structural, rendered, data and transactional proof that the loaded add-on can own the chair: the
 * frame, its four selectors' buttons, the three action buttons, the money frame and the banner with
 * their scripts; the frame and a selector rendered; the registrations the model raises; every table
 * the model reads present (`model.ready()`). Then one silent Show/Hide pair with CloseAllBags set
 * aside (BarberShop_OnShow closes the bags) and WatchFrame's visibility put back (the pair hides and
 * shows it). A new Lua error or bridge diagnostic fails it.
 */
export function frameXmlBarberGate(
  seam: { readonly barber?: FrameXmlBarberModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): FrameXmlFrame | undefined {
  try {
    if (!seam.barber?.ready()) return undefined;
    const frames = new Map<string, FrameXmlFrame>();
    const lookup = (name: string): FrameXmlFrame | undefined => frames.get(name) ?? boot.bridge.getFrame(name);
    for (const [name, type, ancestorName, scripts] of BARBER_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      const ancestor = lookup(ancestorName);
      if (!frame || !ancestor || frame.type !== type || frame === ancestor || !frameDescendsFrom(frame, ancestor)
        || !scripts.every((script) => boot.bridge.hasScript(frame, script))) return undefined;
      frames.set(name, frame);
    }
    const root = frames.get("BarberShopFrame")!;
    if (root.parent?.name !== "UIParent" || root.visible) return undefined;
    for (const name of ["BarberShopFrame", "BarberShopFrameSelector1Next", "BarberShopFrameOkayButton"]) {
      const frame = frames.get(name)!;
      if (!renderedFrameElement(renderer.elementFor(frame), frame)) return undefined;
    }
    for (const [name, events] of BARBER_EVENTS) {
      const frame = lookup(name);
      if (!frame || !events.every((event) => frame.registeredEvents.has(event))) return undefined;
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = frameXmlSilentProbe(boot, "webclient/barber-gate", `
      local closeAllBags = CloseAllBags
      local watch = WatchFrame and WatchFrame:IsShown()
      CloseAllBags = function() end
      local ok, shown, hidden = pcall(function()
        BarberShopFrame:Show()
        local shown = (BarberShopFrame:IsShown() and BarberShopBannerFrame:IsShown()) and 1 or 0
        BarberShopFrame:Hide()
        return shown, (BarberShopFrame:IsShown() or BarberShopBannerFrame:IsShown()) and 1 or 0
      end)
      CloseAllBags = closeAllBags
      if WatchFrame then if watch then WatchFrame:Show() else WatchFrame:Hide() end end
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

export interface FrameXmlBarberNativeWindow {
  /** The native window steps aside (the stock frame now shows the chair). */
  hide(): void;
  /** The native window repaints the chair still occupied (a failed load or gate, teardown). */
  show(): void;
}

export interface FrameXmlLazyBarberOwner {
  /** Stock BarberShopFrame holds the chair; the native window stays hidden while it does. */
  ownsShop(): boolean;
  isOpen(): boolean;
  readonly settled: Promise<void>;
  readonly loaded: boolean;
  readonly failed: boolean;
  dispose(): void;
}

/**
 * The lazy owner. It listens on the model's `onOpenRequest` (the chair enabled before stock owned
 * it): the first one fetches the tables, loads the add-on and gates it; the edge of `owned` then
 * opens the chair still occupied. A failure leaves the native window in charge for the session.
 */
export function createLazyFrameXmlBarberOwner(
  seam: { readonly barber?: FrameXmlBarberModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount" | "loadAddon" | "corpus">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor" | "addRoots" | "sync">,
  native: FrameXmlBarberNativeWindow,
  prepare: () => Promise<void>,
  onFailure?: (reason: string) => void,
): FrameXmlLazyBarberOwner {
  const model = seam.barber;
  let frame: FrameXmlFrame | undefined;
  let pending: Promise<void> | undefined;
  let settled: Promise<void> = Promise.resolve();
  let failed = model === undefined;
  let disposed = false;
  const fail = (reason: string): void => {
    if (disposed || failed) return;
    failed = true;
    if (model) {
      if (model.onOpenRequest === openRequest) model.onOpenRequest = undefined;
      model.owned = false;
    }
    for (const name of ["BarberShopFrame", "BarberShopBannerFrame"]) {
      const stock = boot.bridge.getFrame(name);
      if (stock?.visible) {
        try { boot.bridge.Hide(stock); } catch { /* the native window takes over either way */ }
      }
    }
    try { native.show(); } catch { /* the native window is already the visible owner */ }
    onFailure?.(reason);
  };
  const load = async (): Promise<void> => {
    try {
      await prepare();
      if (disposed) return;
      // Every table the frame reads, before anything loads: the gate would refuse without them, and a
      // gateway older than `/dbc/barber-cost` answers 404 (measured on the running one). Not a failure:
      // the native window keeps this chair, and the next one asks again, so a restarted gateway is
      // picked up without a reload.
      if (!model?.ready()) {
        onFailure?.("the barber tables are not all there (gateway route /dbc/barber-cost?)");
        return;
      }
      // The selectors' arrows are virtual children of their template: FrameXmlInspectCorpus.ts.
      const result = await withFrameXmlLaneCorpus(boot, () => boot.loadAddon(FRAMEXML_BARBER_ADDON));
      if (disposed) return;
      if (!result.ok) { fail(`${FRAMEXML_BARBER_ADDON}: ${result.message ?? result.status}`); return; }
      renderer.addRoots(result.roots);
      renderer.sync();
      const gated = frameXmlBarberGate(seam, boot, renderer);
      if (!gated || !model) { fail("the stock BarberShopFrame tree or its tables did not pass the gate"); return; }
      frame = gated;
      // The edge: BARBER_SHOP_OPEN for a chair still occupied (UIParent → ShowUIPanel).
      model.owned = true;
      if (boot.bridge.isVisible(gated)) native.hide();
    } catch (error) {
      fail(`${FRAMEXML_BARBER_ADDON}: ${String(error)}`);
    }
  };
  const openRequest = (): void => {
    if (disposed || failed || frame || pending) return;
    pending = load().finally(() => { pending = undefined; });
    settled = pending;
  };
  if (model && !failed) model.onOpenRequest = openRequest;
  return {
    get loaded() { return frame !== undefined && !failed; },
    get failed() { return failed; },
    get settled() { return settled; },
    ownsShop: () => !disposed && !failed && frame !== undefined && model?.owned === true,
    isOpen: () => !disposed && !failed && frame !== undefined && boot.bridge.isVisible(frame),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (model) {
        if (model.onOpenRequest === openRequest) model.onOpenRequest = undefined;
        model.owned = false;
      }
      for (const name of ["BarberShopFrame", "BarberShopBannerFrame"]) {
        const stock = boot.bridge.getFrame(name);
        if (stock?.visible) {
          try { boot.bridge.Hide(stock); } catch { /* teardown */ }
        }
      }
    },
  };
}
