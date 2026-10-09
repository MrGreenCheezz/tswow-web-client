/**
 * The keyboard for a shown CoinPickupFrame (plan item 3.09, L5c 04.10).
 *
 * CoinPickupFrame is `enableKeyboard="true"` with OnChar (CoinPickupFrame_OnChar: a digit types the
 * amount) and OnKeyDown (CoinPickupFrame_OnKeyDown: BACKSPACE/DELETE erase, ENTER is «OK», the key
 * GetBindingFromClick names TOGGLEGAMEMENU is «Cancel», LEFT/DOWN and RIGHT/UP step the amount; any
 * other key runs its own binding, CoinPickupFrame.lua:150-180). The client gives a shown
 * keyboard-enabled frame each press as OnKeyDown with the key's name and, for a character, OnChar.
 *
 * The browser mount has no general keyboard dispatch to frames (FrameXmlBindingOwner.ts has the one
 * for KeyBindingFrame), so this is that dispatch for this frame: a capture-phase `keydown` on the
 * window, before Controls.ts. Only the keys the dialog answers itself are taken — digits, the erase
 * and arrow keys, Enter and Escape — and kept from the world; every other key goes on to its binding
 * as the stock RunBinding passthrough intends, so the character can still move with the dialog up.
 */

import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import { frameXmlKeyName } from "./FrameXmlBinding.js";

/** The client key names CoinPickupFrame_OnKeyDown answers itself (besides the digits). */
const DIALOG_KEYS: ReadonlySet<string> = new Set([
  "BACKSPACE", "DELETE", "ENTER", "ESCAPE", "LEFT", "RIGHT", "UP", "DOWN", "NUMPADENTER",
]);

function typingInto(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

/** One press as the dialog sees it: the OnKeyDown name, and the OnChar text for a digit. */
export function frameXmlCoinPickupPress(code: string, key: string): { readonly keyName: string; readonly char?: string } | undefined {
  const keyName = frameXmlKeyName(code);
  const digit = /^[0-9]$/.test(key) ? key : undefined;
  if (digit === undefined && !DIALOG_KEYS.has(keyName)) return undefined;
  // The numpad's Enter reaches the stock handler as ENTER, as the main one does.
  return digit === undefined ? { keyName: keyName === "NUMPADENTER" ? "ENTER" : keyName } : { keyName, char: digit };
}

export function installFrameXmlCoinPickupKeyboard(
  boot: Pick<FrameXmlBoot, "bridge">,
  target: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = typeof window === "undefined" ? undefined : window,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const frame = boot.bridge.getFrame("CoinPickupFrame");
    if (!frame || !boot.bridge.isVisible(frame) || typingInto(event.target)) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const press = frameXmlCoinPickupPress(event.code, event.key);
    if (!press) return;
    event.preventDefault();
    event.stopPropagation();
    boot.bridge.runInMutationBatch(() => {
      boot.bridge.fireScript(frame, "OnKeyDown", press.keyName);
      if (press.char !== undefined && boot.bridge.isVisible(frame)) boot.bridge.fireScript(frame, "OnChar", press.char);
    });
  };
  target?.addEventListener("keydown", onKeyDown as EventListener, true);
  return () => {
    target?.removeEventListener("keydown", onKeyDown as EventListener, true);
  };
}
