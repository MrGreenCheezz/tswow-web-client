/**
 * The world mount's one entry into this lane: publish the lazy stock MacroFrame and KeyBindingFrame
 * owners, route the stock Lua entry points to them, and give KeyBindingFrame its keyboard.
 *
 * Nothing is loaded here — both add-ons are load-on-demand and cost nothing until first opened.
 * `publish` is called after `boot.load()` (the stock globals it re-points exist by then) and
 * returns the cleanup the mount runs before destroying the VM.
 *
 * The routes: stock `ShowMacroFrame` (the `/macro` slash command, the chat menu's «Макрос» and
 * GameMenuButtonMacros) and GameMenuButtonKeybindings reach the host's open functions, which ask
 * these owners first and open the native windows otherwise. In Lua, `LoadAddOn` is only a status
 * view, so the stock `MacroFrame_LoadUI(); MacroFrame_Show()` pair would answer «not loaded».
 */

import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import { createLazyFrameXmlMacroOwner } from "./FrameXmlMacroOwner.js";
import { createLazyFrameXmlBindingOwner, installFrameXmlKeyBindingKeyboard } from "./FrameXmlBindingOwner.js";
import { publishFrameXmlMacro } from "./FrameXmlMacroController.js";
import { publishFrameXmlKeyBindings } from "./FrameXmlBindingController.js";

export interface FrameXmlMacroBindingHost {
  /** Open the macro window (stock when published, native otherwise): `Macros.openMacroWindow`. */
  openMacros(): void;
  /** The native macro window alone, for a stock load that failed while the player waited. */
  openNativeMacros(): void;
  openNativeKeyBindings(): void;
}

const SHOW_MACRO_FRAME = "__fxWebClientShowMacroFrame";

export function mountFrameXmlMacroBindingWindows(
  seam: Pick<FrameXmlWorldSeam, "macros" | "keyBindings">,
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  host: FrameXmlMacroBindingHost,
): { publish(): () => void } {
  return {
    publish: () => {
      const macroCleanup = publishFrameXmlMacro(createLazyFrameXmlMacroOwner(seam, boot, renderer, host.openNativeMacros));
      const bindingCleanup = publishFrameXmlKeyBindings(
        createLazyFrameXmlBindingOwner(seam, boot, renderer, host.openNativeKeyBindings));
      boot.vm.registerGlobal(SHOW_MACRO_FRAME, () => { host.openMacros(); return []; });
      boot.vm.executeReported(`ShowMacroFrame = ${SHOW_MACRO_FRAME}`, "@webclient/macro-route");
      const keyboardCleanup = installFrameXmlKeyBindingKeyboard(boot);
      // A CLICK binding presses the stock button it names, in this VM.
      seam.keyBindings?.setClicker((button, mouseButton) => {
        boot.vm.executeReported(
          "local button, mouse = ...\nlocal frame = _G[button]\nif type(frame) == 'table' and frame.Click then frame:Click(mouse) end",
          "@webclient/binding-click", [button, mouseButton]);
      });
      // A SPELL, ITEM or MACRO binding (SetBindingSpell/Item/Macro, 3.11 D) runs the stock call, in this VM.
      seam.keyBindings?.setCommandRunner((kind, value) => {
        const call = kind === "SPELL" ? "CastSpellByName" : kind === "ITEM" ? "UseItemByName" : "RunMacro";
        const argument = kind === "MACRO" && /^\d+$/.test(value) ? Number(value) : value;
        boot.vm.executeReported(`local value = ...\n${call}(value)`, "@webclient/binding-command", [argument]);
      });
      let cleaned = false;
      return () => {
        if (cleaned) return;
        cleaned = true;
        seam.keyBindings?.setClicker(undefined);
        seam.keyBindings?.setCommandRunner(undefined);
        keyboardCleanup();
        bindingCleanup();
        macroCleanup();
      };
    },
  };
}
