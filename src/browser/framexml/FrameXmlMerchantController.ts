/**
 * Ownership boundary for the stock MerchantFrame.
 *
 * The native vendor panel remains the fallback until FrameXmlWorldMount proves the complete
 * MerchantFrame tree and its vendor seam. Keeping one owner here prevents a vendor packet from
 * painting two panels, and gives Escape/teardown an identity-safe close path.
 */

export type FrameXmlMerchantEvent = "show" | "update" | "closed";

export interface FrameXmlMerchantOwner {
  isOpen(): boolean;
  show(): void;
  hide(): void;
  /** Deliver a world vendor transition to the stock root's event handler. */
  refresh(event: FrameXmlMerchantEvent, force?: boolean): void;
}

let owner: FrameXmlMerchantOwner | undefined;

export function publishFrameXmlMerchant(next: FrameXmlMerchantOwner): () => void {
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

export function frameXmlMerchantOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

export function closeFrameXmlMerchant(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.hide(); } catch { /* mount owns final teardown */ }
  return true;
}

/** Forward a vendor callback to the one published stock owner. */
export function notifyFrameXmlMerchant(event: FrameXmlMerchantEvent, force = false): boolean {
  const current = owner;
  if (!current) return false;
  try {
    current.refresh(event, force);
    return true;
  } catch {
    return false;
  }
}
