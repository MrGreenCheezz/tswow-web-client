/**
 * The ownership seam between the stock MacroFrame (load-on-demand Blizzard_MacroUI) and the native
 * `#macro-window`.
 *
 * `Macros.ts`'s toggle/open/close ask here first, so the game menu's «Макросы», the `/macro`
 * command, the chat menu and stock ShowMacroFrame reach the stock window once the world mount has
 * published its owner, and the native Panel otherwise. Every answer is false while nothing usable is
 * published — before the mount, after teardown, and after a failed load or gate.
 */

import { FrameXmlLodWindowRoute, type FrameXmlLodWindowOwner } from "./FrameXmlMacroBindingLod.js";

const route = new FrameXmlLodWindowRoute();

export function publishFrameXmlMacro(owner: FrameXmlLodWindowOwner): () => void {
  return route.publish(owner);
}

export function frameXmlMacroPublished(): boolean {
  return route.published();
}

export function frameXmlMacroOpen(): boolean {
  return route.isOpen();
}

/** Toggle the stock window; false tells the caller to use the native one. */
export function toggleFrameXmlMacro(): boolean {
  return route.toggle();
}

/** Open (or keep open) the stock window; false tells the caller to use the native one. */
export function openFrameXmlMacro(): boolean {
  return route.open();
}

/** Close the stock window; false when it was not open. */
export function closeFrameXmlMacro(): boolean {
  return route.close();
}
