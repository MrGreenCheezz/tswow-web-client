/**
 * The small ownership boundary between the stock FrameXML spellbook and the legacy HTML panel.
 *
 * This module intentionally knows neither how FrameXML is mounted nor how the native panel is
 * built.  The mount publishes a handle after its structural gate succeeds; input and Windows can
 * then route to that handle without importing the expensive FrameXML boot on the ordinary input
 * path.  Keeping the owner as one slot also makes remounts and teardown deterministic.
 */

export interface FrameXmlSpellBookOwner {
  /** Whether the stock root is currently visible through its FrameXML parent chain. */
  isOpen(): boolean;
  /** Direct bridge calls, so Lua OnShow/OnHide handlers run exactly as they do in-game. */
  show(): void;
  hide(): void;
}

let owner: FrameXmlSpellBookOwner | undefined;

/** Publish the one gated stock owner and return an idempotent unpublish/close cleanup. */
export function publishFrameXmlSpellBook(next: FrameXmlSpellBookOwner): () => void {
  // A successful mount is the only publisher.  If a stale cleanup arrives after a remount it must
  // not close or clear the new owner, so the identity check below is part of the contract.
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.hide(); } catch { /* the old bridge may already be tearing down */ }
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    try { next.hide(); } catch { /* teardown continues through the mount owner */ }
    owner = undefined;
  };
}

/** Whether a gated stock spellbook is currently open. */
export function frameXmlSpellBookOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Toggle the stock owner. Returns true when the stock route handled the request. */
export function toggleFrameXmlSpellBook(): boolean {
  const current = owner;
  if (!current) return false;
  try {
    if (current.isOpen()) current.hide();
    else current.show();
  } catch {
    // An owner is still authoritative until mount teardown. Do not open the native fallback after
    // a bridge error, which would create two competing spellbook owners.
  }
  return true;
}

/** Close the stock owner when Escape or the global window closer backs out. */
export function closeFrameXmlSpellBook(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.hide(); } catch { /* the mount's cleanup will finish the teardown */ }
  return true;
}
