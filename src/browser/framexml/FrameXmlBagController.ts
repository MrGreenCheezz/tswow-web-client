/**
 * The ownership boundary between stock ContainerFrame and the native HTML bags.
 *
 * The mount is the only publisher.  Keyboard, button and Escape routes can therefore ask this
 * small module whether a gated stock owner exists without importing the FrameXML boot or keeping a
 * second set of container-frame state.  Until publication every route returns `false`, leaving the
 * existing `Bags.ts` implementation as the fallback.
 */

export interface FrameXmlBagOwner {
  /** Whether at least one stock container frame is currently visible. */
  isOpen(): boolean;
  /** The stock MainMenuBarBackpackButton click path. */
  toggleBackpack(): void;
  /** The stock CharacterBag1..4Slot click path; the argument is 1-based. */
  toggleBag(index: number): void;
  /** The stock KeyRingButton click path. */
  toggleKeyring(): void;
  /** The stock OpenAllBags/CloseAllBags equivalent. */
  toggleAllBags(): void;
  /** Close every owned stock container before the mount is torn down. */
  close(): void;
  /** Release VM-local compatibility globals after the owner has been closed. */
  dispose?(): void;
  /** Demote this owner after a bridge mutation reports a runtime diagnostic/error. */
  onFailure?(): void;
}

/** Plural spelling retained for callers that name the whole ContainerFrame group. */
export type FrameXmlBagsOwner = FrameXmlBagOwner;

let owner: FrameXmlBagOwner | undefined;

function closeAndDispose(current: FrameXmlBagOwner): void {
  try { current.close(); } catch { /* the old bridge may already be tearing down */ }
  try { current.dispose?.(); } catch { /* mount cleanup continues */ }
}

function demote(current: FrameXmlBagOwner): void {
  // Remove the route before running the close path so a failure callback cannot observe a second
  // active owner. The callback restores native DOM ownership; close/dispose then finish the stock
  // VM cleanup even if the mount is already halfway through teardown.
  if (owner === current) owner = undefined;
  closeAndDispose(current);
  try { current.onFailure?.(); } catch { /* fail closed even if visual cleanup also failed */ }
}

function invoke(current: FrameXmlBagOwner, action: () => void): boolean {
  try {
    action();
    return true;
  } catch {
    demote(current);
    return false;
  }
}

/**
 * Publish one gated stock owner and return an idempotent unpublish cleanup.
 *
 * A stale cleanup from an earlier mount must not close or clear a newer owner.  Closing a previous
 * owner here also prevents a remount from leaving two sets of ContainerFrame DOM nodes visible.
 */
export function publishFrameXmlBags(next: FrameXmlBagOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    closeAndDispose(previous);
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    closeAndDispose(next);
    owner = undefined;
  };
}

/** Whether a gated stock container owner is currently open. */
export function frameXmlBagsOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Route the all-bags action (`B`) to stock when it is available. */
export function toggleFrameXmlBags(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => current.toggleAllBags());
}

/** Route the backpack action to stock when it is available. */
export function toggleFrameXmlBackpack(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => current.toggleBackpack());
}

/** Route a stock container id: 0 is the backpack, 1..4 are the four carried bags. */
export function toggleFrameXmlBag(index?: number): boolean {
  if (index === undefined) return toggleFrameXmlBags();
  const current = owner;
  if (!current || !Number.isInteger(index) || index < 0 || index > 4) return false;
  return invoke(current, () => {
    if (index === 0) current.toggleBackpack();
    else current.toggleBag(index);
  });
}

/** Route the keyring action to stock when it is available. */
export function toggleFrameXmlKeyring(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => current.toggleKeyring());
}

/** Close the stock owner for Escape and the global window closer. */
export function closeFrameXmlBags(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => current.close());
}

/** Compatibility aliases for callers that use singular/explicit-all wording. */
export const publishFrameXmlBagOwner = publishFrameXmlBags;
export const frameXmlBagOpen = frameXmlBagsOpen;
export const toggleFrameXmlAllBags = toggleFrameXmlBags;
export const closeFrameXmlBag = closeFrameXmlBags;
