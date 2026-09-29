/**
 * The ownership seam between the stock load-on-demand TradeSkillFrame and the native profession
 * windows (`ui/Professions.ts`).
 *
 * Every route into a profession — the opener spell from either spellbook or an action button, the
 * native skills pane's «Открыть», the profession list — ends in `openProfession`, which asks here
 * first. Every answer is false while nothing is published (or the owner declines a line), which
 * leaves the native craft window in charge.
 */

export interface FrameXmlTradeSkillOwner {
  /** The stock window shows, or the first open is still waiting for Blizzard_TradeSkillUI. */
  isOpen(): boolean;
  /** Show this profession line in TradeSkillFrame; false: not taken, the native window opens. */
  open(skillId: number): boolean;
  /** The player's close (Escape, the profession key); false when nothing stock was open. */
  close(): boolean;
  /** An enchant's DoTradeSkill is waiting for the item it goes on. */
  targeting?(): boolean;
  /** Drop that waiting enchant (Escape); true when there was one. */
  cancelTargeting?(): boolean;
  dispose?(): void;
  /** Demote an owner whose call crossed a broken VM boundary. */
  demote?(): void;
}

let owner: FrameXmlTradeSkillOwner | undefined;

/** Publish the one gated stock trade skill owner and return an identity-safe cleanup. */
export function publishFrameXmlTradeSkill(next: FrameXmlTradeSkillOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.close(); } catch { /* stale VM teardown must not block a new mount */ }
    try { previous.dispose?.(); } catch { /* a pending LoD must not outlive its replacement */ }
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    owner = undefined;
    try { next.close(); } catch { /* cleanup remains idempotent */ }
    try { next.dispose?.(); } catch { /* the bridge owns final teardown */ }
  };
}

function demote(current: FrameXmlTradeSkillOwner): void {
  try { current.demote?.(); } catch { /* identity-safe demotion is best effort */ }
}

export function frameXmlTradeSkillPublished(): boolean {
  return owner !== undefined;
}

/** Whether the stock window (or an enchant waiting for its item) is up; Escape asks this. */
export function frameXmlTradeSkillOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen() || current.targeting?.() === true; } catch { return false; }
}

/** Route a profession line to the stock window; false: the caller opens the native one. */
export function openFrameXmlTradeSkill(skillId: number): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.open(skillId); }
  catch {
    demote(current);
    return false;
  }
}

/**
 * Escape: a waiting enchant is dropped and that is the whole press, as stock ToggleGameMenu stops at
 * a SpellStopTargeting that dropped something; the next press closes the window.
 */
export function closeFrameXmlTradeSkill(): boolean {
  const current = owner;
  if (!current) return false;
  try {
    if (current.cancelTargeting?.() === true) return true;
    return current.close();
  } catch {
    demote(current);
    return false;
  }
}

/**
 * SpellStopTargeting from outside the VM — a right click on the world (Controls.ts): the waiting
 * enchant is dropped and the window stays; false when no enchant was waiting.
 */
export function stopFrameXmlTradeSkillTargeting(): boolean {
  const current = owner;
  if (!current?.cancelTargeting) return false;
  try { return current.cancelTargeting() === true; }
  catch {
    demote(current);
    return false;
  }
}
