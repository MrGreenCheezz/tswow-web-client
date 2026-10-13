/**
 * 13.10: a CLICK binding's key edges, as Wow.exe 3.3.5a (12340) hands them to the button it names. Read-only notes:
 * .runtime/re-2026-10-11/glue-1110/cv311-g.txt (0x00563150), 1013-k3.txt (0x0096e9c0), 1013-k4.txt (the Button vtable at
 * 0x00aa0f50), 1013-k5.txt (0x0096fa80, 0x0096fb60, 0x0096fd70).
 *
 * - 0x00563150, `CLICK <button>:<mouse button>`: the frame by name (0x00562990), then its vtable +0xac — the mouse-down
 *   handler — on the key's press, +0xb0 — the mouse-up handler — on its release, each handed the mouse button's name.
 * - The Button's mouse-down (0x0096fa80) with a binding's name: no hit test; nothing while disabled (state & 0xf = 0);
 *   a click `(button, true)` (+0xe8 → 0x0096fd70) when the button is registered for any `…Down` (the mask is 0x7fffffff,
 *   every down flag of RegisterForClicks, 0x0096e9c0); then the state goes PUSHED (+0xf0(2)).
 * - Its mouse-up (0x0096fb60): nothing unless the state is PUSHED (& 0xf = 2); a click `(button, false)` when registered
 *   for any `…Up` (0x80000000 and the high word); then the state goes NORMAL (+0xf0(1)). A button no RegisterForClicks
 *   touched keeps 3.3.5's default, LeftButtonUp (FrameXmlTypes.clickRegistrations).
 *
 * Not taken over: OnMouseDown/OnMouseUp (0x0048fc30, 0x0048fce0, the base handlers both run first), OnDoubleClick
 * within 300 ms of the last click (0x0096fb60), and the lock bit SetButtonState(state, true) sets (0x20), which this
 * runtime does not keep. A CLICK binding on a frame that is no Button does nothing here.
 */

import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";

/** 0x0096e9c0: the names RegisterForClicks knows, upper-cased as the runtime keeps them; any other sets no flag. */
const CLICK_NAME = /^(?:LEFTBUTTON|RIGHTBUTTON|MIDDLEBUTTON|BUTTON(?:[4-9]|[12][0-9]|3[01])|ANY)(DOWN|UP)$/;

/** Whether a binding's press (`down`) or release clicks a button registered for `registrations` (0x0096fa80, 0x0096fb60). */
export function bindingClickRegistered(registrations: ReadonlySet<string>, down: boolean): boolean {
  if (registrations.size === 0) return !down;
  const phase = down ? "DOWN" : "UP";
  for (const name of registrations) if (CLICK_NAME.exec(name)?.[1] === phase) return true;
  return false;
}

/** One key edge of a CLICK binding on `frame` with the binding's mouse button `mouse`. */
export function frameXmlBindingClickEdge(
  bridge: Pick<FrameXmlUiBridge, "resolve" | "Click" | "update">,
  frame: FrameXmlFrame | undefined,
  mouse: string,
  down: boolean,
): void {
  const button = bridge.resolve(frame);
  if (!button || (button.type !== "Button" && button.type !== "CheckButton") || !button.enabled) return;
  if (!down && button.buttonState !== "PUSHED") return;
  if (bindingClickRegistered(button.clickRegistrations, down)) bridge.Click(button, mouse, down);
  // After the click, which may have disabled the button: a disabled one keeps its state (`state & 0xf` read again).
  const after = bridge.resolve(button);
  if (!after?.enabled) return;
  const state = down ? "PUSHED" : "NORMAL";
  // As Button:SetButtonState writes it (GlueWidgets.ts).
  if (after.buttonState !== state) bridge.update(after, (mutable) => { mutable.buttonState = state; });
}
