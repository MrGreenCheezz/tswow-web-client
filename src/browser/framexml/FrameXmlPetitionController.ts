/**
 * The ownership seam between the stock charter windows and their native fallbacks: TabardFrame and
 * the native emblem designer in `#gossip-window` (Npc.ts `showTabardVendor`), the two registrar
 * frames and the vendor half of `#petition-window`, PetitionFrame and its charter half
 * (Petition.ts). Each is published by the world mount once its gate passed; while it is, its native
 * fallback stays hidden and the stock frame opens from its own events.
 *
 * All four are server-driven, so the controller only answers whether a stock owner holds the
 * window, whether it is open, closes it (Escape), and is told when the world forgot an NPC service
 * without an event (`closeNpcServices`, another NPC clicked).
 */

export type FrameXmlCharterWindow = "tabard" | "registrar" | "petition";

export interface FrameXmlCharterOwner {
  isOpen(): boolean;
  close(): void;
  /** Raise whatever edge the world's state moved to. */
  sync?(): void;
}

const owners = new Map<FrameXmlCharterWindow, FrameXmlCharterOwner>();

/** Publish one gated stock owner and return an identity-safe cleanup. */
export function publishFrameXmlCharterWindow(window: FrameXmlCharterWindow, next: FrameXmlCharterOwner): () => void {
  owners.set(window, next);
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owners.get(window) === next) owners.delete(window);
  };
}

export function frameXmlCharterPublished(window: FrameXmlCharterWindow): boolean {
  return owners.has(window);
}

export function frameXmlCharterOpen(window: FrameXmlCharterWindow): boolean {
  const current = owners.get(window);
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

export function closeFrameXmlCharterWindow(window: FrameXmlCharterWindow): boolean {
  const current = owners.get(window);
  if (!current) return false;
  try { current.close(); } catch { /* the mount's teardown owns the final cleanup */ }
  return true;
}

/**
 * The world forgot its NPC services without an event (`WorldClient.closeNpcServices`: another NPC
 * was clicked). The tabard designer's guid is gone, so TabardFrame closes; an open charter vendor
 * is closed the way the panel manager would close it for the next NPC's window.
 */
export function notifyFrameXmlCharters(): void {
  for (const window of ["tabard", "registrar"] as const) {
    const current = owners.get(window);
    if (!current) continue;
    try {
      if (window === "registrar") { if (current.isOpen()) current.close(); } else current.sync?.();
    } catch { /* a stock failure must not reopen the native window */ }
  }
}
