/**
 * Stock Blizzard_TradeSkillUI as the profession window: the gate and the lazy, load-on-demand owner.
 * The C API is FrameXmlTradeSkill.ts.
 *
 * The add-on is not in the boot corpus, so it costs nothing until the first profession opens. That
 * first open follows the trainer recipe (FrameXmlWorldMount.ts, createLazyFrameXmlTrainerOwner): the
 * native craft window shows at once, `boot.loadAddon` reads the four files, the renderer takes the
 * new tree, the gate proves it, and only then does the native window step aside for the stock one.
 * Lua's own LoadAddOn is a status view in this host (FrameXmlAddonRuntime.ts), which is also why the
 * model fires TRADE_SKILL_SHOW — whose UIParent handler calls UIParentLoadAddOn — only after this.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlTradeSkillModel } from "./FrameXmlTradeSkill.js";
import type { FrameXmlTradeSkillOwner } from "./FrameXmlTradeSkillController.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";

export const FRAMEXML_TRADESKILL_ADDON = "Blizzard_TradeSkillUI";

/** `TRADE_SKILLS_DISPLAYED` and `MAX_TRADE_SKILL_REAGENTS` (Blizzard_TradeSkillUI.lua:1-2). */
const LIST_ROWS = 8;
const REAGENTS = 8;

const TRADESKILL_FRAMES: readonly (readonly [name: string, type: string, scripts: readonly string[]])[] = [
  ["TradeSkillFrame", "Frame", ["OnLoad", "OnEvent", "OnShow", "OnHide", "OnUpdate"]],
  ["TradeSkillRankFrame", "StatusBar", ["OnLoad", "OnEvent"]],
  ["TradeSkillFrameAvailableFilterCheckButton", "CheckButton", ["OnClick"]],
  ["TradeSkillFrameEditBox", "EditBox", ["OnTextChanged"]],
  ["TradeSkillExpandButtonFrame", "Frame", []],
  ["TradeSkillCollapseAllButton", "Button", ["OnClick"]],
  ["TradeSkillSubClassDropDown", "Frame", ["OnLoad"]],
  ["TradeSkillInvSlotDropDown", "Frame", ["OnLoad"]],
  ["TradeSkillHighlightFrame", "Frame", []],
  ["TradeSkillListScrollFrame", "ScrollFrame", ["OnVerticalScroll"]],
  ["TradeSkillDetailScrollFrame", "ScrollFrame", []],
  ["TradeSkillDetailScrollChildFrame", "Frame", []],
  ["TradeSkillSkillIcon", "Button", ["OnClick", "OnEnter"]],
  ["TradeSkillCreateButton", "Button", ["OnClick"]],
  ["TradeSkillCreateAllButton", "Button", ["OnClick"]],
  ["TradeSkillCancelButton", "Button", ["OnClick"]],
  ["TradeSkillDecrementButton", "Button", ["OnClick"]],
  ["TradeSkillIncrementButton", "Button", ["OnClick"]],
  ["TradeSkillInputBox", "EditBox", []],
  ["TradeSkillFrameCloseButton", "Button", ["OnClick"]],
];

/** TradeSkillFrame_OnLoad's registrations (Blizzard_TradeSkillUI.lua:62-67) that the model fires. */
const TRADESKILL_EVENTS: readonly string[] = ["TRADE_SKILL_UPDATE", "TRADE_SKILL_FILTER_UPDATE", "UPDATE_TRADESKILL_RECAST"];
/** UIParent_OnLoad's (UIParent.lua:191-192): the window opens and closes through UIParent. */
const UIPARENT_EVENTS: readonly string[] = ["TRADE_SKILL_SHOW", "TRADE_SKILL_CLOSE"];
const STOCK_GLOBALS: readonly string[] = ["TradeSkillFrame_Show", "TradeSkillFrame_Hide", "TradeSkillFrame_Update"];

type GateBoot = Pick<FrameXmlBoot, "vm" | "bridge" | "errorCount">;

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

function hasGlobalFunction(boot: GateBoot, name: string): boolean {
  const ref = boot.vm.globalFunction(name);
  if (!ref) return false;
  boot.vm.release(ref);
  return true;
}

/**
 * Structural, rendered and transactional proof that the loaded TradeSkillFrame can own the
 * profession window.
 *
 * The probe shows the root directly (not through ShowUIPanel, so no panel the player has open is
 * pushed aside), runs TradeSkillFrame_Update in the closed state and hides it again — muted, so
 * OnHide's CloseTradeSkill neither stops a queue nor fires TRADE_SKILL_CLOSE, and with PlaySound
 * silenced. Any new Lua error or bridge diagnostic fails the gate and keeps the native window.
 */
export function frameXmlTradeSkillGate(
  seam: { readonly tradeSkill?: FrameXmlTradeSkillModel | undefined },
  boot: GateBoot,
  renderer: Pick<FrameXmlDomRenderer, "elementFor">,
): { readonly frame: FrameXmlFrame } | undefined {
  try {
    const model = seam.tradeSkill;
    if (!model) return undefined;
    const frames = new Map<string, FrameXmlFrame>();
    for (const [name, type, scripts] of TRADESKILL_FRAMES) {
      const frame = boot.bridge.getFrame(name);
      if (!frame || frame.type !== type || !scripts.every((script) => boot.bridge.hasScript(frame, script))) {
        return undefined;
      }
      frames.set(name, frame);
    }
    for (let index = 1; index <= LIST_ROWS; index += 1) {
      const row = boot.bridge.getFrame(`TradeSkillSkill${index}`);
      if (!row || row.type !== "Button" || !boot.bridge.hasScript(row, "OnClick")) return undefined;
      frames.set(row.name, row);
    }
    for (let index = 1; index <= REAGENTS; index += 1) {
      const reagent = boot.bridge.getFrame(`TradeSkillReagent${index}`);
      if (!reagent || reagent.type !== "Button" || !boot.bridge.hasScript(reagent, "OnEnter")
        || !boot.bridge.hasScript(reagent, "OnClick")) return undefined;
      frames.set(reagent.name, reagent);
    }
    const root = frames.get("TradeSkillFrame")!;
    const uiParent = boot.bridge.getFrame("UIParent");
    if (!uiParent || root.parent !== uiParent || root.visible) return undefined;
    for (const frame of frames.values()) if (!frameDescendsFrom(frame, root)) return undefined;
    if (!renderedFrameElement(renderer.elementFor(root), root)) return undefined;
    if (!TRADESKILL_EVENTS.every((event) => root.registeredEvents.has(event))) return undefined;
    if (!UIPARENT_EVENTS.every((event) => uiParent.registeredEvents.has(event))) return undefined;
    if (!STOCK_GLOBALS.every((name) => hasGlobalFunction(boot, name))) return undefined;
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const probe = model.muted(() => frameXmlSilentProbe(boot, "webclient/tradeskill-gate", `
      TradeSkillFrame:Show()
      local shown = TradeSkillFrame:IsShown() and 1 or 0
      TradeSkillFrame_Update()
      TradeSkillFrame:Hide()
      return shown, TradeSkillFrame:IsShown() and 1 or 0
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

/** The native profession window this owner stands in front of (`ui/Professions.ts`). */
export interface FrameXmlTradeSkillNative {
  /** The native craft window for a line: the visible fallback while the add-on loads, and after a failure. */
  open(skillId: number): boolean;
  /** Hide the native craft windows (the craft queue keeps running) once the stock window shows. */
  stepAside(): void;
  /**
   * Whether that line's native window still shows. While the add-on loads the player may close it
   * with its own controls, which the owner otherwise never hears of; absent, it is taken as shown.
   */
  isOpen?(skillId: number): boolean;
}

export interface FrameXmlTradeSkillOwnerOptions {
  readonly seam: { readonly tradeSkill?: FrameXmlTradeSkillModel | undefined };
  readonly boot: Pick<FrameXmlBoot, "loadAddon" | "vm" | "bridge" | "errorCount"> & Partial<Pick<FrameXmlBoot, "isAddonLoaded">>; // L5c 3.24
  readonly renderer: Pick<FrameXmlDomRenderer, "addRoots" | "sync" | "elementFor">;
  readonly native: FrameXmlTradeSkillNative;
  /** The mount's demotion: unpublish, so the next open reaches the native window directly. */
  readonly onFailure?: () => void;
}

/**
 * The lazy owner. `open` answers true for every line the character has: the stock window shows it,
 * or — before the gate has passed — the native window does while Blizzard_TradeSkillUI loads. A load,
 * gate or Lua failure demotes the owner for good and reopens the wanted line natively.
 *
 * A refusal by stock itself is not a failure: ShowUIPanel declines a "left" panel while a fullscreen
 * one such as the world map is up (UIParent.lua:1341-1349), and TradeSkillFrame_ShowFailed's
 * CloseTradeSkill then ends the line, as it does in the client.
 */
export function createLazyFrameXmlTradeSkillOwner(options: FrameXmlTradeSkillOwnerOptions): FrameXmlTradeSkillOwner {
  const { seam, boot, renderer, native } = options;
  /** The line the player last asked for and has not closed: what a finished load shows. */
  let desired: number | undefined;
  let disposed = false;
  let failed = false;
  let frame: FrameXmlFrame | undefined;
  let pending: Promise<void> | undefined;
  let releaseListPointer: (() => void) | undefined;
  /** The line whose native window the native side did show while the add-on loads. */
  let fallback: number | undefined;

  const diagnostics = (): number => boot.bridge.diagnostics.length;
  /**
   * The player closed that native window with its own controls. A native side that showed nothing
   * (no world yet, or it refused the line) has no window to close, and the wanted line stands.
   */
  const fallbackClosed = (skillId: number): boolean => fallback === skillId && native.isOpen?.(skillId) === false;
  const showStock = (skillId: number): void => {
    const model = seam.tradeSkill;
    if (!model) throw new Error("the trade skill model is gone");
    const errors = boot.errorCount;
    const notes = diagnostics();
    if (!model.open(skillId)) return;
    // Handoff: the stock tree is proven, so the native craft window steps aside before stock shows.
    native.stepAside();
    model.show();
    // Not visible without an error is stock's own refusal (TradeSkillFrame_ShowFailed); see above.
    if (boot.errorCount > errors || diagnostics() > notes) {
      throw new Error("Blizzard_TradeSkillUI reported an error while opening");
    }
  };
  const fail = (): void => {
    if (disposed || failed) return;
    failed = true;
    const wanted = desired;
    desired = undefined;
    const model = seam.tradeSkill;
    if (frame && boot.bridge.isVisible(frame)) {
      const root = frame;
      try {
        if (model) model.muted(() => boot.bridge.Hide(root)); else boot.bridge.Hide(root);
      } catch { /* demotion continues through the native window */ }
    }
    try { model?.release(); } catch { /* the native window is still reopened below */ }
    releaseListPointer?.();
    releaseListPointer = undefined;
    frame = undefined;
    try { options.onFailure?.(); } catch { /* the native fallback below still runs */ }
    if (wanted !== undefined) {
      try { native.open(wanted); } catch { /* nothing further can be offered */ }
    }
  };
  /**
   * TradeSkillListScrollFrame (FauxScrollFrameTemplate) takes the wheel and never the click: its
   * template declares OnMouseWheel and no enableMouse. The renderer gives every OnMouseWheel frame
   * the pointer, so once a line has more than TRADE_SKILLS_DISPLAYED (8) rows and the list scrolls,
   * the frame lay over the eight recipe buttons and no click reached them (measured on both routes;
   * scratchpad/w4-TSK/NEEDS-RR.md §2 asks for the general wheel routing). Its own EnableMouse(false)
   * is the client's state for it; the wheel over the rows is handed to its OnMouseWheel from the
   * window, unless something already handled that wheel.
   */
  const installListPointer = (root: FrameXmlFrame): void => {
    const list = boot.bridge.getFrame("TradeSkillListScrollFrame");
    const element = renderer.elementFor(root);
    if (!list || !element) return;
    boot.vm.executeReported("TradeSkillListScrollFrame:EnableMouse(false)", "@webclient/tradeskill-install");
    const wheel = (event: Event): void => {
      const box = renderer.elementFor(list)?.getBoundingClientRect?.();
      const { clientX, clientY, deltaY } = event as WheelEvent;
      if (event.defaultPrevented || !box || !boot.bridge.isVisible(list) || !Number.isFinite(deltaY) || deltaY === 0
        || clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return;
      event.preventDefault();
      event.stopPropagation();
      boot.bridge.fireScript(list, "OnMouseWheel", deltaY < 0 ? 1 : -1);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    releaseListPointer = () => element.removeEventListener("wheel", wheel);
  };
  const load = async (): Promise<void> => {
    try {
      const result = await boot.loadAddon(FRAMEXML_TRADESKILL_ADDON);
      if (disposed || failed) return;
      // The native window closed by its own controls while the files were on their way is a close
      // too: neither the stock window nor, after a failure, a reopened native one follows it.
      if (desired !== undefined && fallbackClosed(desired)) desired = undefined;
      if (!result.ok) { fail(); return; }
      renderer.addRoots(result.roots);
      // The root is parented into UIParent, so the add-on's own roots can be empty; reconcile first.
      renderer.sync();
      const gate = frameXmlTradeSkillGate(seam, boot, renderer);
      if (disposed || failed) return;
      if (!gate) { fail(); return; }
      frame = gate.frame;
      installListPointer(frame);
      // A close while the files were on their way cleared the intent; a later open renewed it.
      if (desired !== undefined) showStock(desired);
    } catch {
      if (!disposed) fail();
    }
  };

  return {
    isOpen: () => !disposed && !failed && (pending !== undefined
      ? desired !== undefined && !fallbackClosed(desired)
      : frame !== undefined && boot.bridge.isVisible(frame)),
    open: (skillId) => {
      if (disposed || failed) return false;
      if (!seam.tradeSkill?.canOpen(skillId)) return false;
      if (frame && boot.bridge.isVisible(frame) && seam.tradeSkill.showing && seam.tradeSkill.skillId === skillId) {
        // The opener of the line already showing closes it, as a second press of the profession's
        // button does in the client (owner check: the live client's toggle).
        desired = undefined;
        boot.vm.executeReported("HideUIPanel(TradeSkillFrame)", "@webclient/tradeskill-toggle");
        return true;
      }
      desired = skillId;
      if (frame) {
        try { showStock(skillId); } catch { fail(); }
        return true;
      }
      // The native window is the visible answer until the stock one is proven — unless the mount's
      // loading window already has the add-on in (L5c 3.24): the gate then follows within this task,
      // and a failed one still opens the native window (`fail`).
      const preloaded = typeof boot.isAddonLoaded === "function" && boot.isAddonLoaded(FRAMEXML_TRADESKILL_ADDON);
      fallback = !preloaded && native.open(skillId) ? skillId : undefined;
      pending ??= load().finally(() => { pending = undefined; });
      return true;
    },
    close: () => {
      if (disposed) return false;
      const wanted = desired !== undefined && !fallbackClosed(desired);
      desired = undefined;
      if (pending) return wanted;
      if (frame && boot.bridge.isVisible(frame)) {
        boot.vm.executeReported("HideUIPanel(TradeSkillFrame)", "@webclient/tradeskill-close");
        return true;
      }
      return false;
    },
    targeting: () => !disposed && !failed && seam.tradeSkill?.targeting !== undefined,
    cancelTargeting: () => !disposed && seam.tradeSkill?.cancelTargeting() === true,
    demote: fail,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      desired = undefined;
      if (frame && boot.bridge.isVisible(frame)) {
        // OnHide's CloseTradeSkill ends the line (and its repeat queue), as leaving the world does.
        try { boot.bridge.Hide(frame); } catch { /* teardown */ }
      }
      releaseListPointer?.();
      releaseListPointer = undefined;
      frame = undefined;
    },
  };
}
