/**
 * The ownership seam between the stock KeyBindingFrame (load-on-demand Blizzard_BindingUI) and the
 * native `#keybindings-window`.
 *
 * `KeyBindings.ts`'s toggle/open/close ask here first, so the game menu's «Назначение клавиш» and
 * this client's own `K` reach the stock window once the world mount has published its owner, and
 * the native Panel otherwise. Every answer is false while nothing usable is published — before the
 * mount, after teardown, and after a failed load or gate.
 */

import { FrameXmlLodWindowRoute, type FrameXmlLodWindowOwner } from "./FrameXmlMacroBindingLod.js";

const route = new FrameXmlLodWindowRoute();

export function publishFrameXmlKeyBindings(owner: FrameXmlLodWindowOwner): () => void {
  return route.publish(owner);
}

export function frameXmlKeyBindingsPublished(): boolean {
  return route.published();
}

export function frameXmlKeyBindingsOpen(): boolean {
  return route.isOpen();
}

/** Toggle the stock window; false tells the caller to use the native one. */
export function toggleFrameXmlKeyBindings(): boolean {
  return route.toggle();
}

/** Open (or keep open) the stock window; false tells the caller to use the native one. */
export function openFrameXmlKeyBindings(): boolean {
  return route.open();
}

/** Close the stock window; false when it was not open. */
export function closeFrameXmlKeyBindings(): boolean {
  return route.close();
}
