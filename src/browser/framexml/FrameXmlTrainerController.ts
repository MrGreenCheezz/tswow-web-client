/** Ownership boundary for the load-on-demand stock ClassTrainerFrame. */

export type FrameXmlTrainerEvent = "show" | "update" | "closed";

/**
 * Whether stock ClassTrainerFrame answers a trainer of this SMSG_TRAINER_LIST type — every type the list
 * carries (Trainer.h TrainerType: class 0, mounts 1, trade skills 2, pets 3), as in Wow.exe, whose one
 * window serves them all (IsTradeskillTrainer switching the profession layout and question,
 * Blizzard_TrainerUI.lua:98, :397). 3.24 (12.10): type 2 joined, over UnitCharacterPoints' free
 * profession slots (3.30). Any other number stays with the native window.
 */
export function frameXmlStockTrainerType(type: number | undefined): boolean {
  return type === 0 || type === 1 || type === 2 || type === 3;
}

export interface FrameXmlTrainerOwner {
  isOpen(): boolean;
  show(): void;
  hide(): void;
  /** User-facing close; unlike hide(), this may close a pending native interaction. */
  close(): boolean;
  refresh(event: FrameXmlTrainerEvent): void;
  dispose?(): void;
  /** Demote an owner when a controller call crosses a broken VM boundary. */
  demote?(): void;
}

let owner: FrameXmlTrainerOwner | undefined;

export function publishFrameXmlTrainer(next: FrameXmlTrainerOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.hide(); } catch { /* stale VM teardown must not block a new mount */ }
    try { previous.dispose?.(); } catch { /* a pending LoD must not outlive its replacement */ }
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    try { next.hide(); } catch { /* cleanup remains idempotent */ }
    try { next.dispose?.(); } catch { /* the bridge owns final teardown */ }
    owner = undefined;
  };
}

export function frameXmlTrainerOpen(): boolean {
  try { return owner?.isOpen() === true; } catch { return false; }
}

export function closeFrameXmlTrainer(): boolean {
  if (!owner) return false;
  try { return owner.close(); }
  catch {
    try { owner.demote?.(); } catch { /* identity-safe demotion is best effort */ }
    return false;
  }
}

export function notifyFrameXmlTrainer(event: FrameXmlTrainerEvent): boolean {
  if (!owner) return false;
  try {
    owner.refresh(event);
    return true;
  } catch {
    try { owner.demote?.(); } catch { /* identity-safe demotion is best effort */ }
    return false;
  }
}
