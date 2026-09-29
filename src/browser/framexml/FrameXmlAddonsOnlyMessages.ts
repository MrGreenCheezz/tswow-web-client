/**
 * The stock dialogs and error lines of the «WebClient + TSWoW add-ons» mode (`addonsOnly`,
 * FrameXmlWorldMount.ts): the native HUD, and over it only what our modules draw.
 *
 * The modules raise stock surfaces themselves: tswow-store confirms a purchase with
 * `StaticPopup_Show("SHOW_CONFIRM_SALE", …)` (Components/Items.ts), retail-talents asks before a
 * tree or a full reset (talent-ui.ts, RESET_TREE_POPUP/RESET_ALL_POPUP), survival warns of hunger and
 * thirst with `UIErrorsFrame:AddMessage` (survival-ui.ts warnOnce). StaticPopup.xml and
 * UIErrorsFrame.xml are in the vertical this mode loads, so the frames existed — but nothing painted
 * them (FrameXmlTsAddonPresentation.ts), so «Купить» and «Сбросить» asked a question no one could
 * see and answer, and the warnings went nowhere. They are painted now (FRAMEXML_ADDONS_ONLY_SURFACES)
 * and get here what the full interface's mount gives them: the popup adapters (a dialog sized by
 * its measured text, not 61 high with the text under its buttons) and Escape — plus a raise of the
 * overlay whenever one appears, since what an event shows would otherwise land under a native window
 * opened since (the overlay rises only on pointerdown, the native windows on every show).
 *
 * What stays the native HUD's:
 * - The server's questions. The popup model keeps `popupsOwned` false (FrameXmlPopups.ts: no
 *   show event fires) and the popup owner is not published (FrameXmlPopupsController.ts: every
 *   native prompt keeps asking), so an invite, a duel or a resurrection is never asked twice. The
 *   contract for every new world event stock UIParent turns into StaticPopup_Show: it fires only
 *   while `popupsOwned`. Escape reaches stock through the native chain's first step
 *   (escapeFrameXmlAddonDialogs), not the published owner, and the owner is built without the model,
 *   so it can only dismiss what the modules raised — and a press that closed a dialog is spent there.
 * - The world's notices. UIErrorsFrame_OnLoad registers SYSMSG, UI_INFO_MESSAGE and
 *   UI_ERROR_MESSAGE (UIErrorsFrame.lua:3-5); the seam's models fire them (FrameXmlLoot, FrameXmlTrade,
 *   FrameXmlBank …) and the native notice line already says each one, so the stock frame leaves those
 *   three events for good — /uierrorson (ChatFrame.lua SlashCmdList.UI_ERRORS_ON) and a module's
 *   suppress-then-restore included — and keeps only what is added to it directly.
 */
import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import { frameXmlSilentProbe } from "./FrameXmlGameMenuOwner.js";
import {
  createFrameXmlPopupsOwner, FRAMEXML_STATIC_POPUP_COUNT, installFrameXmlPopupsAdapters,
} from "./FrameXmlPopupsOwner.js";
import { publishFrameXmlAddonDialogsEscape } from "./FrameXmlTsAddonPresentation.js";

/** What UIErrorsFrame_OnLoad registers (UIErrorsFrame.lua:3-5): the world's messages. */
export const FRAMEXML_ADDONS_ONLY_WORLD_MESSAGE_EVENTS: readonly string[] = Object.freeze([
  "SYSMSG", "UI_INFO_MESSAGE", "UI_ERROR_MESSAGE",
]);

/** The one-shot host binding the counting hooks capture; it is nil again before any module runs. */
const SHOWN_GLOBAL = "__fxAddonsOnlySurfaceShown";

/**
 * UIErrorsFrame leaves the world's three message events, and stays off them: its RegisterEvent
 * answers those three with nothing from now on, so /uierrorson (`UIErrorsFrame:RegisterEvent(
 * "UI_ERROR_MESSAGE")`, ChatFrame.lua) or a module restoring what it suppressed cannot bring the
 * world's errors back in twice. By name rather than UnregisterAllEvents: those three are all stock
 * registers, and any other event a module registers on the frame is its own and works.
 * Answers whether none of the three reaches the frame now (false when there is no UIErrorsFrame).
 */
export function installFrameXmlAddonsOnlyMessages(boot: Pick<FrameXmlBoot, "vm" | "bridge">): boolean {
  const frame = boot.bridge.getFrame("UIErrorsFrame");
  if (!frame) return false;
  frameXmlSilentProbe(boot, "webclient/addons-only-messages", `
    local frame = UIErrorsFrame
    if type(frame) ~= "table" or type(frame.UnregisterEvent) ~= "function"
      or type(frame.RegisterEvent) ~= "function" then return 0 end
    local world = {}
    for _, event in ipairs({ ${FRAMEXML_ADDONS_ONLY_WORLD_MESSAGE_EVENTS.map((event) => `"${event}"`).join(", ")} }) do
      world[event] = true
      frame:UnregisterEvent(event)
    end
    local register = frame.RegisterEvent
    frame.RegisterEvent = function(self, event, ...)
      if self == frame and world[event] then return end
      return register(self, event, ...)
    end
    return 1
  `, 1);
  return FRAMEXML_ADDONS_ONLY_WORLD_MESSAGE_EVENTS.every((event) => !frame.registeredEvents.has(event));
}

/** `frameXmlWorld().surfaces` in this mode: what was shown since the mount. */
export interface FrameXmlAddonsOnlySurfaceCounts {
  /** StaticPopup dialogs shown — here, the modules' own. */
  readonly popups: number;
  /** Lines added to UIErrorsFrame — here, the modules' own; the world's are the native line's. */
  readonly errors: number;
  /** Who answers the server's confirmations: "native" in this mode, whatever a module shows. */
  readonly serverQuestions: "native" | "stock";
}

export interface FrameXmlAddonsOnlySurfaces {
  /** `installFrameXmlPopupsAdapters`' count (5 on the stock corpus). */
  readonly adapters: number;
  /** Whether UIErrorsFrame left the world's message events. */
  readonly messagesDetached: boolean;
  counts(): FrameXmlAddonsOnlySurfaceCounts;
  /**
   * Withdraws the Escape step and stops raising the overlay (idempotent). The Lua adapters and
   * counting hooks live in the VM and go with it; a remount builds a fresh VM and installs them once.
   */
  dispose(): void;
}

/** The seam's two popup models, read for the diagnostic only: this mode never takes them. */
export interface FrameXmlAddonsOnlySeam {
  readonly popups?: { readonly popupsOwned: boolean } | undefined;
  readonly lfd?: { readonly popupsOwned: boolean } | undefined;
}

export interface FrameXmlAddonsOnlyHost {
  /**
   * Bring the overlay above the native windows (GameWindows.ts `raiseLayer` on the host): run when a
   * dialog shows and when a line is added to UIErrorsFrame.
   */
  raise?(): void;
}

/**
 * Everything the `addonsOnly` branch installs for the stock dialogs and error lines, after
 * `boot.load()` and before the host is shown (so a first dialog never shows at its unmeasured
 * height). The cleanup is `dispose`, run from the mount's add-on entry-point cleanup.
 */
export function mountFrameXmlAddonsOnlySurfaces(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  seam: FrameXmlAddonsOnlySeam,
  host: FrameXmlAddonsOnlyHost,
): FrameXmlAddonsOnlySurfaces {
  const adapters = installFrameXmlPopupsAdapters(boot);
  const messagesDetached = installFrameXmlAddonsOnlyMessages(boot);
  let popups = 0;
  let errors = 0;
  let disposed = false;
  // Counted where they happen: each dialog's OnShow and each UIErrorsFrame:AddMessage, whoever
  // calls it — and the overlay raised with each, over whatever native window opened since. The
  // binding is captured by the hooks and cleared from _G in the same chunk.
  boot.vm.registerGlobal(SHOWN_GLOBAL, (args) => {
    if (args[0] === "popup") popups += 1;
    else if (args[0] === "error") errors += 1;
    else return [];
    if (!disposed) {
      try { host.raise?.(); } catch { /* the layer order is cosmetic; the line is already said */ }
    }
    return [];
  });
  try {
    frameXmlSilentProbe(boot, "webclient/addons-only-counters", `
      local shown = ${SHOWN_GLOBAL}
      ${SHOWN_GLOBAL} = nil
      if type(shown) ~= "function" then return 0 end
      local hooked = 0
      for index = 1, STATICPOPUP_NUMDIALOGS or 0 do
        local dialog = _G["StaticPopup" .. index]
        if type(dialog) == "table" and type(dialog.HookScript) == "function" then
          dialog:HookScript("OnShow", function() shown("popup") end)
          hooked = hooked + 1
        end
      end
      if type(UIErrorsFrame) == "table" and type(hooksecurefunc) == "function" then
        hooksecurefunc(UIErrorsFrame, "AddMessage", function() shown("error") end)
        hooked = hooked + 1
      end
      return hooked
    `, 1);
  } finally {
    boot.vm.setGlobal(SHOWN_GLOBAL, undefined);
  }
  // Built without the popup model: its destroy-item and cursor-drop routes stay inert, and it is
  // not published, so the native prompts keep the server's questions. Escape asks it first and is
  // spent when it closed something (escapeFrameXmlAddonDialogs, Controls.ts backOut).
  const owner = createFrameXmlPopupsOwner(boot);
  const withdrawEscape = publishFrameXmlAddonDialogsEscape(() => {
    if (disposed || boot.vm.closed || !owner.isOpen()) return false;
    owner.close();
    return true;
  });
  return {
    adapters,
    messagesDetached,
    counts: () => ({
      popups,
      errors,
      serverQuestions: seam.popups?.popupsOwned === true || seam.lfd?.popupsOwned === true ? "stock" : "native",
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      withdrawEscape();
    },
  };
}

/** The dialogs the popups owner shows, the ones `watchFrameXmlDialogLayer` keeps over the native windows. */
const DIALOG_LAYER_FRAMES: readonly string[] = Object.freeze([
  ...Array.from({ length: FRAMEXML_STATIC_POPUP_COUNT }, (_unused, index) => `StaticPopup${index + 1}`),
  "ReadyCheckFrame",
]);

/** The one-shot host binding the layer hooks capture; nil again in the same chunk. */
const LAYER_GLOBAL = "__fxDialogLayerChanged";

/**
 * The full stock HUD's stock dialogs over the native windows. The overlay host sits at z-index 3,
 * under every native window (GameWindows.ts: 31 and up, opened near the top of the viewport). While
 * dialogs were modal such a window went inert and a click on the popup under it fell through to the
 * popup; now the window takes the click, and a PARTY_INVITE or DELETE_ITEM popup under an open
 * GM-ticket or barber window could not be answered until the window moved. So while any of
 * StaticPopup1-4 or ReadyCheckFrame is shown the host is raised over the native windows — again at
 * every show, over whatever opened since — and when the last one hides it falls back.
 * `addonsOnly` does not use this: its overlay is a window of its own (raised on pointerdown and by
 * mountFrameXmlAddonsOnlySurfaces). Answers the release; the hooks live and die with the VM.
 */
export function watchFrameXmlDialogLayer(
  boot: Pick<FrameXmlBoot, "vm" | "bridge">,
  layer: { raise(): void; lower(): void },
): () => void {
  let active = true;
  let raised = false;
  const shown = (): boolean => DIALOG_LAYER_FRAMES.some((name) => {
    const frame = boot.bridge.getFrame(name);
    return frame !== undefined && boot.bridge.isVisible(frame);
  });
  const settle = (showing: boolean): void => {
    if (!active) return;
    try {
      if (showing) {
        layer.raise();
        raised = true;
      } else if (raised && !shown()) {
        layer.lower();
        raised = false;
      }
    } catch {
      // The layer order is cosmetic; the dialog itself is already shown or gone.
    }
  };
  boot.vm.registerGlobal(LAYER_GLOBAL, (args) => {
    settle(args[0] === true);
    return [];
  });
  try {
    frameXmlSilentProbe(boot, "webclient/dialog-layer", `
      local changed = ${LAYER_GLOBAL}
      ${LAYER_GLOBAL} = nil
      if type(changed) ~= "function" then return 0 end
      local hooked = 0
      for _, name in ipairs({ ${DIALOG_LAYER_FRAMES.map((name) => `"${name}"`).join(", ")} }) do
        local frame = _G[name]
        if type(frame) == "table" and type(frame.HookScript) == "function" then
          frame:HookScript("OnShow", function() changed(true) end)
          frame:HookScript("OnHide", function() changed(false) end)
          hooked = hooked + 1
        end
      end
      return hooked
    `, 1);
  } finally {
    boot.vm.setGlobal(LAYER_GLOBAL, undefined);
  }
  // A dialog already up when the watch starts (shown while the corpus loaded) is lifted at once.
  if (shown()) settle(true);
  return () => { active = false; };
}
