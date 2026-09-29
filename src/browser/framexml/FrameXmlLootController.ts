/**
 * The ownership seam between the stock loot UI (LootFrame, GroupLootFrame1-4, GroupLootDropDown
 * and UIParent's LOOT_BIND/CONFIRM_LOOT_ROLL popups) and the native `#loot-window` and
 * `LootRolls.ts` dialogs.
 *
 * Loot is server-driven: nothing here opens a window. The world mount publishes an owner only after
 * the stock tree passed its gate; from then on FrameXmlLoot.ts raises the stock events from the
 * world's loot state, and the native `showLoot`/`showLootRolls` step aside while
 * `frameXmlLootPublished()` answers true. Escape and `closeGameWindows` close the stock window
 * through `closeFrameXmlLoot`, which answers false while nothing is published.
 */

export interface FrameXmlLootOwner {
  /** LootFrame is on screen. */
  isOpen(): boolean;
  /** Close LootFrame the way its own button does: HideUIPanel, whose OnHide releases the loot. */
  hide(): void;
  /**
   * Give the route back without releasing anything: disown the model, then take the stock frames
   * down. The native window repaints whatever loot is still open.
   */
  release(): void;
}

let owner: FrameXmlLootOwner | undefined;

/** Publish the one gated stock loot owner and return an identity-safe cleanup. */
export function publishFrameXmlLoot(next: FrameXmlLootOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.release(); } catch { /* stale VM teardown must not block the new owner */ }
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    owner = undefined;
    try { next.release(); } catch { /* mount cleanup continues */ }
  };
}

/** Whether the stock loot UI owns loot: the native window and roll dialogs step aside while true. */
export function frameXmlLootPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlLootOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Close the stock loot window (Escape). A missing owner tells the caller to use its native path. */
export function closeFrameXmlLoot(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.hide(); } catch { /* teardown owns the final cleanup */ }
  return true;
}
