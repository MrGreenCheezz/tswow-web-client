/**
 * 3.24 (12.10): the ownership seam between stock HelpFrame (with KnowledgeBaseFrame, its start page) and the native
 * GM ticket window (ui/GmTickets.ts). The world mount publishes the owner once its gate passed
 * (FrameXmlHelpOwner.ts); while it is published the help micro button, the native menu's «Помощь игрового мастера»
 * and Escape ask stock (ToggleHelpFrame, UIParent.lua:431-441), and the native window is the route only without it.
 */

export interface FrameXmlHelpOwner {
  isOpen(): boolean;
  /** Stock ToggleHelpFrame. */
  toggle(): void;
  close(): void;
}

let owner: FrameXmlHelpOwner | undefined;

/** Publish the gated stock owner and return an identity-safe cleanup. */
export function publishFrameXmlHelp(next: FrameXmlHelpOwner): () => void {
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    try { next.close(); } catch { /* the mount's teardown continues */ }
    owner = undefined;
  };
}

export function frameXmlHelpPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlHelpOpen(): boolean {
  if (!owner) return false;
  try { return owner.isOpen(); } catch { return false; }
}

/** The help key and menu entry: true while the stock owner is published, false to use the native window. */
export function toggleFrameXmlHelp(): boolean {
  if (!owner) return false;
  try { owner.toggle(); } catch { /* the stock route stays authoritative until the mount goes */ }
  return true;
}

export function closeFrameXmlHelp(): boolean {
  if (!owner) return false;
  try {
    if (!owner.isOpen()) return false;
    owner.close();
    return true;
  } catch {
    return false;
  }
}
