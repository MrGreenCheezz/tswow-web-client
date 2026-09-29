/**
 * The ownership seam between the stock GossipFrame and the native `#gossip-window`.
 *
 * Gossip is server-driven: the page arrives as `SMSG_GOSSIP_MESSAGE` and `WorldClient` reports it
 * through its single `onGossipChanged` slot, which the native `showGossip` (Npc.ts) holds. That
 * function asks here first; a `true` answer means the stock owner took the change (GOSSIP_SHOW or
 * GOSSIP_CLOSED through the real stock handlers) and the native window must stay hidden. `false`
 * — nothing published — leaves the native window as the route.
 */

export interface FrameXmlGossipOwner {
  /** The stock frame is on screen. */
  isOpen(): boolean;
  /** Raise whatever GOSSIP_* edge the world's page moved to. */
  sync(): void;
  /** Close as the player would (HideUIPanel → OnHide → CloseGossip). */
  close(): void;
}

let owner: FrameXmlGossipOwner | undefined;

/** Publish the one gated stock gossip owner and return an identity-safe cleanup. */
export function publishFrameXmlGossip(next: FrameXmlGossipOwner): () => void {
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner === next) owner = undefined;
  };
}

export function frameXmlGossipPublished(): boolean {
  return owner !== undefined;
}

/**
 * The world's gossip page changed. `true`: the stock frame owns gossip and has been told; the native
 * window must stay hidden. `false`: nothing is published, the native window answers the page.
 */
export function notifyFrameXmlGossip(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.sync(); } catch { /* a stock failure must not reopen a second window for the page */ }
  return true;
}

export function frameXmlGossipOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

export function closeFrameXmlGossip(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.close(); } catch { /* the mount's teardown owns the final cleanup */ }
  return true;
}
