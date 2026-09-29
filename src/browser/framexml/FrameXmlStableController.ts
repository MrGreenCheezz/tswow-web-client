/**
 * The ownership seam between stock PetStableFrame and its native fallback — the stable rows on the
 * character sheet's collections page (StableControls.ts) and the STABLE_CHANGED notice/page switch
 * in EnterWorld.ts. The world mount publishes the owner once its gate passed; while it is, the
 * native rows step aside and the stock frame opens from its own events (PET_STABLE_SHOW).
 *
 * The stable is server-driven, so the controller only answers whether a stock owner holds it,
 * whether it is open, closes it (Escape), and is told when the world forgot the master without an
 * event (`closeNpcServices`: another NPC was clicked).
 */

export interface FrameXmlStableOwner {
  isOpen(): boolean;
  close(): void;
  /** Raise whatever edge the world's state moved to. */
  sync?(): void;
}

let owner: FrameXmlStableOwner | undefined;

/** Publish the gated stock owner and return an identity-safe cleanup. */
export function publishFrameXmlStable(next: FrameXmlStableOwner): () => void {
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner === next) owner = undefined;
  };
}

export function frameXmlStablePublished(): boolean {
  return owner !== undefined;
}

export function frameXmlStableOpen(): boolean {
  if (!owner) return false;
  try { return owner.isOpen(); } catch { return false; }
}

export function closeFrameXmlStable(): boolean {
  if (!owner) return false;
  try { owner.close(); } catch { /* the mount's teardown owns the final cleanup */ }
  return true;
}

/** The world forgot its stable master without an event; PetStableFrame closes with it. */
export function notifyFrameXmlStable(): void {
  try { owner?.sync?.(); } catch { /* a stock failure must not reopen the native rows */ }
}
