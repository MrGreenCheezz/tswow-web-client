/**
 * The ownership boundary between one validated FrameXML talent panel and the native talent view.
 *
 * The add-on is load-on-demand, so the published owner may be lazy: its `show()` can begin one
 * coalesced load while `isOpen()` reports the pending open intent. The mount owns the actual
 * VM/renderer and calls `onFailure` when that load or gate fails, allowing the native route to
 * remain the fallback.
 */

export interface FrameXmlTalentOwner {
  isOpen(): boolean;
  show(): void;
  hide(): void;
  dispose?(): void;
  onFailure?(): void;
}

let owner: FrameXmlTalentOwner | undefined;

function closeAndDispose(current: FrameXmlTalentOwner): void {
  try { current.hide(); } catch { /* teardown continues through the mount */ }
  try { current.dispose?.(); } catch { /* native fallback remains available */ }
}

function demote(current: FrameXmlTalentOwner): void {
  if (owner === current) owner = undefined;
  closeAndDispose(current);
  try { current.onFailure?.(); } catch { /* fail closed */ }
}

function invoke(current: FrameXmlTalentOwner, action: () => void): boolean {
  try {
    action();
    return true;
  } catch {
    demote(current);
    return false;
  }
}

/** Publish one mount-owned talent owner and return an identity-safe cleanup. */
export function publishFrameXmlTalent(next: FrameXmlTalentOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) closeAndDispose(previous);
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    closeAndDispose(next);
    owner = undefined;
  };
}

export function frameXmlTalentOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Route the talent key/button to the validated FrameXML owner when one exists. */
export function toggleFrameXmlTalent(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => {
    if (current.isOpen()) current.hide();
    else current.show();
  });
}

/** Close the FrameXML panel for Escape and the global window closer. */
export function closeFrameXmlTalent(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => current.hide());
}
