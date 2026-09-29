/**
 * The ownership seam for the book and letter reader: stock ItemTextFrame once the world mount's gate published it, else
 * nothing (there is no native reader; an unpublished reader leaves items used, not read).
 *
 * The window is server-driven — stock opens it from its own event handler — so the controller only
 * answers whether the stock owner holds the route, whether it is open, and closes it (Escape).
 * Every answer is `false` while nothing is published.
 */

export interface FrameXmlItemTextPublishedOwner {
  isOpen(): boolean;
  close(): void;
}

let owner: FrameXmlItemTextPublishedOwner | undefined;

/** Publish the one gated stock owner and return an identity-safe cleanup. */
export function publishFrameXmlItemText(next: FrameXmlItemTextPublishedOwner): () => void {
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner === next) owner = undefined;
  };
}

export function frameXmlItemTextPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlItemTextOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

export function closeFrameXmlItemText(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.close(); } catch { /* the mount's teardown owns the final cleanup */ }
  return true;
}
