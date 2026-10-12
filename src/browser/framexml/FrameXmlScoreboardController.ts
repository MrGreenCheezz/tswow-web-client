/**
 * The ownership seam for stock WorldStateScoreFrame (3.24, 12.10): TOGGLEWORLDSTATESCORES (Actions.ts), `/score`
 * (Chat.ts), the native menu's «Таблица боя» (GameMenu.ts) and Escape (Windows.ts) ask the published owner
 * first; with none — no stock interface, or a refused gate (FrameXmlScoreboardOwner.ts) — the native
 * #scoreboard-window (ui/Scoreboard.ts) is the route.
 */

export interface FrameXmlScoreboardOwner {
  isOpen(): boolean;
  /** Stock ToggleWorldStateScoreFrame: its own refusals (an arena, no running battleground) are kept. */
  toggle(): void;
  hide(): void;
}

let owner: FrameXmlScoreboardOwner | undefined;

/** Publish the one gated stock scoreboard and return an identity-safe cleanup. */
export function publishFrameXmlScoreboard(next: FrameXmlScoreboardOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.hide(); } catch { /* a stale VM's teardown must not block the new owner */ }
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

export function frameXmlScoreboardPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlScoreboardOpen(): boolean {
  try { return owner?.isOpen() === true; } catch { return false; }
}

/**
 * The scoreboard key. True while the stock owner is published, whatever stock decided — in an arena, or with
 * no battleground running, ToggleWorldStateScoreFrame opens nothing, as Wow.exe's key does; false tells the
 * caller to use the native window.
 */
export function toggleFrameXmlScoreboard(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.toggle(); } catch { /* the stock route stays authoritative until the mount goes */ }
  return true;
}

export function closeFrameXmlScoreboard(): boolean {
  const current = owner;
  if (!current) return false;
  try {
    if (!current.isOpen()) return false;
    current.hide();
    return true;
  } catch {
    return false;
  }
}
