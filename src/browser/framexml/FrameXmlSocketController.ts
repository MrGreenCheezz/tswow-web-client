/**
 * The ownership seam between the stock ItemSocketingFrame (load-on-demand Blizzard_ItemSocketingUI)
 * and the native socketing window (`#socketing-window`, ui/Socketing.ts).
 *
 * The native «Вставить камни» entry asks here first: while the world mount has a usable stock owner
 * published, the request goes through the same Lua entry point the stock bags and paper doll use
 * (`SocketInventoryItem`/`SocketContainerItem`), so gem-abilities' hooks see it too. Every answer is
 * false while nothing usable is published — before the mount, after teardown, and after a failed
 * load or gate — which leaves the native window in charge.
 */
import type { FrameXmlSocketTarget } from "./FrameXmlSocketModel.js";

export interface FrameXmlSocketRoute {
  /** Run the stock entry point for the item; false when the stock window cannot take it. */
  open(target: FrameXmlSocketTarget): boolean;
  isOpen(): boolean;
  close(): boolean;
}

let route: FrameXmlSocketRoute | undefined;

/** Publish the one stock socketing route and return an identity-safe cleanup. */
export function publishFrameXmlSocket(next: FrameXmlSocketRoute): () => void {
  route = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (route === next) route = undefined;
  };
}

/**
 * The Lua address of a native inventory slot (ui/Socketing.ts `openSocketingFromLua`'s inverse):
 * equipment 255/0..18 is slot 1..19, the backpack 255/23..38 is bag 0, bags 19..22 are bags 1..4.
 */
export function frameXmlSocketTarget(bag: number, slot: number): FrameXmlSocketTarget | undefined {
  if (!Number.isInteger(bag) || !Number.isInteger(slot)) return undefined;
  if (bag === 255 && slot >= 0 && slot <= 18) return { location: 0, bag: 0, slot: slot + 1 };
  if (bag === 255 && slot >= 23 && slot <= 38) return { location: 1, bag: 0, slot: slot - 22 };
  if (bag >= 19 && bag <= 22 && slot >= 0) return { location: 1, bag: bag - 18, slot: slot + 1 };
  return undefined;
}

/** Open the stock socketing window for a native slot; false tells the caller to use the native one. */
export function openFrameXmlSocket(bag: number, slot: number): boolean {
  const current = route;
  const target = frameXmlSocketTarget(bag, slot);
  if (!current || !target) return false;
  try { return current.open(target); } catch { return false; }
}

export function frameXmlSocketOpen(): boolean {
  const current = route;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Close the stock socketing window; false when nothing stock was open. */
export function closeFrameXmlSocket(): boolean {
  const current = route;
  if (!current) return false;
  try { return current.close(); } catch { return false; }
}
