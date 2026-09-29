/**
 * The ownership seam for the bank window: stock BankFrame once the world mount's gate published it, else
 * the native #bank-window (Bank.ts `showBank`).
 *
 * The window is server-driven — stock opens it from its own event handler — so the controller only
 * answers whether the stock owner holds the route, whether it is open, and closes it (Escape).
 * Every answer is `false` while nothing is published.
 */

export interface FrameXmlBankPublishedOwner {
  isOpen(): boolean;
  close(): void;
}

let owner: FrameXmlBankPublishedOwner | undefined;

/** Publish the one gated stock owner and return an identity-safe cleanup. */
export function publishFrameXmlBank(next: FrameXmlBankPublishedOwner): () => void {
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner === next) owner = undefined;
  };
}

export function frameXmlBankPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlBankOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

export function closeFrameXmlBank(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.close(); } catch { /* the mount's teardown owns the final cleanup */ }
  return true;
}
