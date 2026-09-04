/**
 * The ownership seam between the stock PvP summary and (when gated) stock ArenaFrame.
 *
 * PVPFrame is deliberately published only after the mount has proved that the real stock
 * PVPParentFrame tree and its owned honor/battleground pages are usable. The optional ArenaFrame
 * is attached to that same owner only after its own structural/context gate succeeds; otherwise
 * the native ArenaWindow remains the fallback.
 */

export interface FrameXmlPvpOwner {
  isOpen(): boolean;
  show(): void;
  hide(): void;
  /** Optional sibling ArenaFrame owned by the same mounted stock controller. */
  isArenaOpen?(): boolean;
  showArena?(): void;
  hideArena?(): void;
}

let owner: FrameXmlPvpOwner | undefined;

/** Publish the one gated stock PvP owner and return an identity-safe cleanup. */
export function publishFrameXmlPvp(next: FrameXmlPvpOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.hide(); } catch { /* stale VM teardown must not block the new owner */ }
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    try { next.hide(); } catch { /* mount cleanup continues */ }
    owner = undefined;
  };
}

export function frameXmlPvpOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen() || current.isArenaOpen?.() === true; } catch { return false; }
}

/** Toggle the stock summary. A missing owner tells the caller to use its native fallback. */
export function toggleFrameXmlPvp(): boolean {
  const current = owner;
  if (!current) return false;
  try {
    if (current.isOpen()) current.hide();
    else current.show();
  } catch {
    // Keep the stock route authoritative until mount teardown; do not open ArenaWindow beside it.
  }
  return true;
}

export function closeFrameXmlPvp(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.hide(); } catch { /* teardown owns the final cleanup */ }
  return true;
}
