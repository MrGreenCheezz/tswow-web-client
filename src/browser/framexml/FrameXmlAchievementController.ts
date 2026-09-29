/**
 * The one published owner of the stock AchievementFrame (Blizzard_AchievementUI, load-on-demand).
 *
 * There is no native achievement window, so there is nothing to fall back to: every answer is
 * false while nothing is published (the AchievementMicroButton then stays disabled), and a failed
 * owner answers false too. The first toggle of a session loads the add-on (FrameXmlAchievementOwner.ts)
 * and shows the frame once its gate has passed.
 */

export interface FrameXmlAchievementOwner {
  /** AchievementFrame shows (a load in flight counts as closed). */
  isOpen(): boolean;
  /** `AchievementFrame_ToggleAchievementFrame(stats)`, loading the add-on first; false once failed. */
  toggle(stats?: boolean): boolean;
  /** The player's close (Escape): stock's HideUIPanel; false when nothing was open. */
  close(): boolean;
  dispose?(): void;
}

let owner: FrameXmlAchievementOwner | undefined;

/** Publish the one lazy stock achievement owner and return an identity-safe cleanup. */
export function publishFrameXmlAchievement(next: FrameXmlAchievementOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.close(); } catch { /* stale VM teardown must not block the new owner */ }
    try { previous.dispose?.(); } catch { /* a pending LoD must not outlive its replacement */ }
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    owner = undefined;
    try { next.close(); } catch { /* mount cleanup continues */ }
    try { next.dispose?.(); } catch { /* the mount owns final teardown */ }
  };
}

export function frameXmlAchievementPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlAchievementOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** The AchievementMicroButton's click (no key binding reaches it yet): false when no stock owner can open. */
export function toggleFrameXmlAchievement(stats = false): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.toggle(stats); } catch { return false; }
}

export function closeFrameXmlAchievement(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.close(); } catch { return false; }
}
