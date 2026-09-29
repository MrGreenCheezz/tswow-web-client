/**
 * The ownership seam between the stock AuctionFrame (Blizzard_AuctionUI, load-on-demand) and the
 * native `#auction-window`.
 *
 * The auction house is server-driven: MSG_AUCTION_HELLO opens it, and the stock AuctionFrame shows
 * itself on the AUCTION_HOUSE_SHOW its model fires. The first visit of a session loads the add-on;
 * while that load is in flight the native window owns the visit, and it steps aside only once the
 * stock tree has passed its gate (`frameXmlAuctionOwnsWindow`). Every answer is false while nothing
 * is published, which leaves Social.showAuctions in charge.
 */

export interface FrameXmlAuctionOwner {
  /** Stock intent: the add-on is loading for an open house, or AuctionFrame shows. */
  isOpen(): boolean;
  /** Stock AuctionFrame holds the auction route; the native window stays hidden while it does. */
  ownsWindow(): boolean;
  /** User-facing close (Escape): stock's own HideUIPanel, or the house itself while loading. */
  close(): boolean;
  /** Teardown: hide the stock window without closing the house (the native window takes it back). */
  hide(): void;
  dispose?(): void;
}

let owner: FrameXmlAuctionOwner | undefined;

/** Publish the one lazy stock auction owner and return an identity-safe cleanup. */
export function publishFrameXmlAuction(next: FrameXmlAuctionOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.hide(); } catch { /* stale VM teardown must not block the new owner */ }
    try { previous.dispose?.(); } catch { /* a pending LoD must not outlive its replacement */ }
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    try { next.hide(); } catch { /* mount cleanup continues */ }
    try { next.dispose?.(); } catch { /* the mount owns final teardown */ }
    owner = undefined;
  };
}

/** Whether stock AuctionFrame owns the auction house now; Social.showAuctions then steps aside. */
export function frameXmlAuctionOwnsWindow(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.ownsWindow(); } catch { return false; }
}

export function frameXmlAuctionOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Close the stock auction house (AuctionFrame's OnHide calls CloseAuctionHouse). False: native close. */
export function closeFrameXmlAuction(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.close(); } catch { return false; }
}
