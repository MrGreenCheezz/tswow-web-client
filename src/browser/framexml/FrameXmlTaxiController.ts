/**
 * The ownership seam for the flight map: stock TaxiFrame once the world mount's gate published it, else
 * the native flight list in #gossip-window (Npc.ts `showTaxiMenu`).
 *
 * The window is server-driven — stock opens it from its own event handler — so the controller only
 * answers whether the stock owner holds the route, whether it is open, and closes it (Escape).
 * Every answer is `false` while nothing is published.
 */

export interface FrameXmlTaxiPublishedOwner {
  isOpen(): boolean;
  close(): void;
  /** Raise whatever TAXIMAP_* edge the world's flight map moved to. */
  sync?(): void;
}

let owner: FrameXmlTaxiPublishedOwner | undefined;

/** Publish the one gated stock owner and return an identity-safe cleanup. */
export function publishFrameXmlTaxi(next: FrameXmlTaxiPublishedOwner): () => void {
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner === next) owner = undefined;
  };
}

export function frameXmlTaxiPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlTaxiOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

export function closeFrameXmlTaxi(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.close(); } catch { /* the mount's teardown owns the final cleanup */ }
  return true;
}

/**
 * The world forgot its flight map without an event (`WorldClient.closeTaxiMenu`, e.g. through
 * `closeNpcServices` when another NPC is clicked). `true`: the stock owner settled TAXIMAP_CLOSED.
 */
export function notifyFrameXmlTaxi(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.sync?.(); } catch { /* the native window stays hidden while stock owns the route */ }
  return true;
}
