/**
 * Stock TradeFrame as the trade window: the gate and the published owner. The C API is
 * FrameXmlTrade.ts.
 *
 * TradeFrame.xml loads after MerchantFrame.xml (stock TOC 95) and declares one hidden UIParent
 * child, TradeFrame, with seven player and seven recipient item slots.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlTradeModel } from "./FrameXmlTrade.js";
import type { FrameXmlTradeOwner } from "./FrameXmlTradeController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

/** `MAX_TRADE_ITEMS` (TradeFrame.lua:1). */
const TRADE_SLOTS = 7;

const TRADE_FRAMES: readonly (readonly [name: string, type: string, scripts: readonly string[]])[] = [
  ["TradeFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide"]],
  ["TradeFrameTradeButton", "Button", ["OnClick"]],
  ["TradeFrameCancelButton", "Button", ["OnClick"]],
  ["TradeFrameCloseButton", "Button", ["OnClick"]],
  ["TradePlayerInputMoneyFrame", "Frame", ["OnLoad", "OnEvent"]],
  ["TradeRecipientMoneyFrame", "Frame", ["OnLoad"]],
  ["TradeHighlightPlayer", "Frame", []],
  ["TradeHighlightRecipient", "Frame", []],
];

/** TradeFrame_OnLoad's registrations (TradeFrame.lua:6-12) that the model fires. */
const TRADE_EVENTS: readonly string[] = [
  "TRADE_CLOSED", "TRADE_SHOW", "TRADE_UPDATE", "TRADE_TARGET_ITEM_CHANGED", "TRADE_PLAYER_ITEM_CHANGED",
  "TRADE_ACCEPT_UPDATE",
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
 * Structural, rendered and transactional proof that stock TradeFrame can own an open trade.
 *
 * The probe shows TradeFrame, runs TradeFrame_Update over the fourteen slots and hides it — silently
 * and without a packet: the model is muted, so OnShow's SetTradeMoney and OnHide's CloseTrade send
 * nothing. Any new Lua error or bridge diagnostic fails the gate and leaves the native window.
 */
export function frameXmlTradeGate(
  seam: { readonly trade?: FrameXmlTradeModel | undefined },
  boot: Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): { readonly frame: FrameXmlFrame } | undefined {
  try {
    const trade = seam.trade;
    if (!trade) return undefined;
    const frames = new Map<string, FrameXmlFrame>();
    for (const [name, type, scripts] of TRADE_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || !scripts.every((script) => boot.bridge.hasScript(frame, script))) {
        return undefined;
      }
      frames.set(name, frame);
    }
    const root = frames.get("TradeFrame")!;
    if (root.parent?.name !== "UIParent" || root.visible) return undefined;
    for (const frame of frames.values()) if (!frameDescendsFrom(frame, root)) return undefined;
    for (let index = 1; index <= TRADE_SLOTS; index += 1) {
      for (const side of ["TradePlayerItem", "TradeRecipientItem"]) {
        const button = boot.bridge.getFrame(`${side}${index}ItemButton`);
        if (!button || button.type !== "Button" || !frameDescendsFrom(button, root)
          || !boot.bridge.hasScript(button, "OnClick") || !boot.bridge.hasScript(button, "OnEnter")) return undefined;
      }
    }
    if (!renderedFrameElement(renderer.elementFor(root), root)) return undefined;
    if (!TRADE_EVENTS.every((event) => root.registeredEvents.has(event))) return undefined;
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = trade.muted(() => frameXmlSilentProbe(boot, "webclient/trade-gate", `
      ShowUIPanel(TradeFrame, 1)
      local shown = TradeFrame:IsShown() and 1 or 0
      TradeFrame_Update()
      HideUIPanel(TradeFrame)
      return shown, TradeFrame:IsShown() and 1 or 0
    `, 2));
    if (!probe) return undefined;
    const [shown, stillShown] = probe.map((value) => Number(value));
    if (shown !== 1 || stillShown !== 0 || root.visible
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return { frame: root };
  } catch {
    return undefined;
  }
}

/**
 * The published owner. TRADE_SHOW opens the window (from the model); `hide` is stock's close,
 * whose OnHide calls CloseTrade — a cancelled trade, as closing the window is in the client.
 */
export function createFrameXmlTradeOwner(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  frame: FrameXmlFrame,
): FrameXmlTradeOwner {
  return {
    isOpen: () => boot.bridge.isVisible(frame),
    hide: () => {
      if (boot.bridge.isVisible(frame)) boot.vm.executeReported("HideUIPanel(TradeFrame)", "@webclient/trade-hide");
    },
  };
}
