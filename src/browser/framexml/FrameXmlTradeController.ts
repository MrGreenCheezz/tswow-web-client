/**
 * The ownership seam between the stock TradeFrame and the native `#trade-window`'s open-trade view.
 *
 * The trade window is server-driven: TRADE_STATUS_OPEN_WINDOW opens it and the stock TradeFrame
 * shows itself on the TRADE_SHOW its model fires. The native window steps aside for an *open* trade
 * while this owner is published; the incoming-request prompt (tradePending) is not this owner's.
 * Every answer is false while nothing is published, which leaves Social.showTrade in charge.
 */

export interface FrameXmlTradeOwner {
  isOpen(): boolean;
  hide(): void;
}

let owner: FrameXmlTradeOwner | undefined;

/** Publish the one gated stock trade owner and return an identity-safe cleanup. */
export function publishFrameXmlTrade(next: FrameXmlTradeOwner): () => void {
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

/** Whether stock TradeFrame owns the open-trade view; the native window steps aside while it does. */
export function frameXmlTradePublished(): boolean {
  return owner !== undefined;
}

export function frameXmlTradeOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Close the stock trade window (its OnHide cancels the trade). False: use the native close. */
export function closeFrameXmlTrade(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.hide(); } catch { /* teardown owns the final cleanup */ }
  return true;
}
