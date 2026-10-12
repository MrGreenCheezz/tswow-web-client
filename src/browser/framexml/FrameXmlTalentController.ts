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

/**
 * 3.45: beside an add-on's N (3.26) the stock PlayerTalentFrame still exists, hosting the glyph tab
 * (FrameXmlWorldMount `createFrameXmlTalentOwners`). What asks for *the stock* talent frame — the
 * talent-wipe question, whose stock path is TalentFrame_LoadUI and PlayerTalentFrame, never an add-on's
 * window — opens that one. Without an add-on's N there is none, and the published owner is the stock one.
 */
let stockBeside: FrameXmlTalentOwner | undefined;

/** Publish the stock talent frame kept beside an add-on's N; returns an identity-safe cleanup. */
export function publishFrameXmlStockTalentBeside(next: FrameXmlTalentOwner): () => void {
  stockBeside = next;
  return (): void => {
    if (stockBeside === next) stockBeside = undefined;
  };
}

/**
 * Open the stock talent frame (3.45): the one beside an add-on's N when there is one, else the
 * published owner, which is then the stock one. A failure of the frame beside is its own: it is not
 * the N owner, so nothing is demoted here.
 */
export function openFrameXmlStockTalent(): void {
  const beside = stockBeside;
  if (beside) {
    try { if (!beside.isOpen()) beside.show(); } catch { /* the native question remains */ }
    return;
  }
  if (!frameXmlTalentOpen()) toggleFrameXmlTalent();
}
