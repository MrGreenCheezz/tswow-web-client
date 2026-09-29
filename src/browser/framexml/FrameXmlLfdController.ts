/**
 * The ownership seam between the stock dungeon finder (LFDParentFrame and its ready/role-check
 * popups) and the native `#lfg-window`.
 *
 * The world mount publishes an owner only after the stock tree passed its gate over a catalog that
 * carries the version-2 fields. Every entry point — the micro button, `I`, the HUD button, `/lfg`,
 * the native menu entry and stock `ToggleLFDParentFrame` — goes through `toggleLfgWindow` in
 * Social.ts, which asks here first: a `false` answer means "not published, use the native window".
 */

export interface FrameXmlLfdOwner {
  isOpen(): boolean;
  show(): void;
  hide(): void;
}

let owner: FrameXmlLfdOwner | undefined;

/** Publish the one gated stock LFD owner and return an identity-safe cleanup. */
export function publishFrameXmlLfd(next: FrameXmlLfdOwner): () => void {
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

/**
 * Whether the stock finder owns the route, and with it the proposal, role-check, boot-vote and
 * continue prompts: the native window and InteractionPrompts step aside while this is true.
 */
export function frameXmlLfdPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlLfdOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Toggle the stock finder. A missing owner tells the caller to use its native fallback. */
export function toggleFrameXmlLfd(): boolean {
  const current = owner;
  if (!current) return false;
  try {
    if (current.isOpen()) current.hide();
    else current.show();
  } catch {
    // The stock route stays authoritative until mount teardown; do not open the native window too.
  }
  return true;
}

export function closeFrameXmlLfd(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.hide(); } catch { /* teardown owns the final cleanup */ }
  return true;
}
