/**
 * The ownership seam between the stock GuildBankFrame (Blizzard_GuildBankUI, load-on-demand) and the
 * native `#guild-bank-window` (ui/GuildBank.ts).
 *
 * The guild bank is server-driven: the banker's first list opens it, and the stock GuildBankFrame
 * shows itself on the GUILDBANKFRAME_OPENED its model fires. The first bank of a session loads the
 * add-on; while that load is in flight the native window owns the visit, and it steps aside only once
 * the stock tree has passed its gate (`frameXmlGuildBankOwnsWindow`). Every answer is false while
 * nothing is published, which leaves ui/GuildBank.ts in charge.
 */

export interface FrameXmlGuildBankOwner {
  /** Stock intent: the add-on is loading for an open bank, or GuildBankFrame shows. */
  isOpen(): boolean;
  /** Stock GuildBankFrame holds the guild bank route; the native window stays hidden while it does. */
  ownsWindow(): boolean;
  /** User-facing close (Escape): stock's own HideUIPanel, or the bank itself while loading. */
  close(): boolean;
  /** Teardown: hide the stock window without closing the bank (the native window takes it back). */
  hide(): void;
  dispose?(): void;
}

let owner: FrameXmlGuildBankOwner | undefined;

/** Publish the one lazy stock guild bank owner and return an identity-safe cleanup. */
export function publishFrameXmlGuildBank(next: FrameXmlGuildBankOwner): () => void {
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

/** Whether stock GuildBankFrame owns the guild bank now; ui/GuildBank.ts then steps aside. */
export function frameXmlGuildBankOwnsWindow(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.ownsWindow(); } catch { return false; }
}

export function frameXmlGuildBankOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Close the stock guild bank (GuildBankFrame's OnHide calls CloseGuildBankFrame). False: native close. */
export function closeFrameXmlGuildBank(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.close(); } catch { return false; }
}
