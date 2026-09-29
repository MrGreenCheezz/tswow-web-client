/** Ownership boundary for the load-on-demand stock ClassTrainerFrame. */

export type FrameXmlTrainerEvent = "show" | "update" | "closed";

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
