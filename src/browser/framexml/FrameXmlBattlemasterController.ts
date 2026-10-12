/**
 * 3.24 (12.10): the ownership seam between stock BattlefieldFrame — the battlemaster's battleground list —
 * and its native fallback, the service dialog Npc.ts draws on BATTLEFIELD_LIST_CHANGED. The world mount
 * publishes the owner once its gate passed (FrameXmlBattlemasterOwner.ts); while it is published, a
 * battlemaster's battleground list is stock's (BATTLEFIELDS_SHOW, BattlefieldFrame.lua:40-53; a random
 * battleground's NPC_PVPQUEUE_ANYWHERE opens PVPParentFrame, PVPBattlegroundFrame.lua:209-217) and the
 * native dialog steps aside, as it does for the arena's.
 *
 * The list is the server's, so the controller only answers whether a stock owner holds it, whether it is
 * open, closes it (Escape), and is told when the world forgot the battlemaster without an event
 * (`closeNpcServices`: another NPC was clicked).
 */

export interface FrameXmlBattlemasterOwner {
  isOpen(): boolean;
  close(): void;
}

let owner: FrameXmlBattlemasterOwner | undefined;

/** Publish the gated stock owner and return an identity-safe cleanup. */
export function publishFrameXmlBattlemaster(next: FrameXmlBattlemasterOwner): () => void {
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    try { next.close(); } catch { /* the mount's teardown continues */ }
    owner = undefined;
  };
}

export function frameXmlBattlemasterPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlBattlemasterOpen(): boolean {
  if (!owner) return false;
  try { return owner.isOpen(); } catch { return false; }
}

export function closeFrameXmlBattlemaster(): boolean {
  if (!owner) return false;
  try {
    if (!owner.isOpen()) return false;
    owner.close();
    return true;
  } catch {
    return false;
  }
}

/** The world forgot its battlemaster without an event; BattlefieldFrame closes with it. */
export function notifyFrameXmlBattlemaster(): void {
  try { if (owner?.isOpen()) owner.close(); } catch { /* a stock failure must not reopen the native list */ }
}
