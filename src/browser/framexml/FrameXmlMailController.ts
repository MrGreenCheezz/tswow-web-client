/**
 * The ownership seam between the stock MailFrame (with OpenMailFrame) and the native `#mail-window`.
 *
 * The mailbox is server-driven: SMSG_SHOW_MAILBOX (or a mailbox gameobject) opens it and the stock
 * MailFrame shows itself on the MAIL_SHOW its model fires. Nothing routes *to* this owner; it tells
 * the native window to step aside (`frameXmlMailPublished`) and gives Escape and teardown one close
 * path. Every answer is false while nothing is published, which leaves Mail.ts in charge.
 */

export interface FrameXmlMailOwner {
  isOpen(): boolean;
  hide(): void;
}

let owner: FrameXmlMailOwner | undefined;

/** Publish the one gated stock mail owner and return an identity-safe cleanup. */
export function publishFrameXmlMail(next: FrameXmlMailOwner): () => void {
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

/** Whether stock MailFrame owns the mailbox route; the native window stays hidden while it does. */
export function frameXmlMailPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlMailOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Close the stock mailbox (MailFrame's OnHide calls CloseMail). False: use the native close. */
export function closeFrameXmlMail(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.hide(); } catch { /* teardown owns the final cleanup */ }
  return true;
}
