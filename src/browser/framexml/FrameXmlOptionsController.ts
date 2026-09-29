/**
 * The ownership seam between the stock Video/Audio/Interface options frames and the native settings
 * window.
 *
 * GameMenuFrame's «Изображение», «Звук» and «Интерфейс» (FrameXmlGameMenuOwner.ts), `/settings` and
 * the native menu's «Настройки» (Settings.toggleSettingsWindow) ask here first. While nothing is
 * published, or once the lazy owner has failed its load or gate, every function answers false and
 * the caller opens the native window instead.
 */

/** Which frame to open: the three stock frames, or InterfaceOptionsFrame on the «WebClient» category. */
export type FrameXmlOptionsWindow = "video" | "audio" | "interface" | "webclient";

export interface FrameXmlOptionsOwner {
  /** A load or gate failure: the route then answers false for good. */
  readonly failed: boolean;
  /** Any of the three frames shown, or an open still waiting for the first load. */
  isOpen(): boolean;
  /** Open (or start loading); `fromGameMenu` returns to GameMenuFrame on close, as stock does. */
  open(window: FrameXmlOptionsWindow, fromGameMenu: boolean): boolean;
  /** Close whatever is open through its Cancel (unsaved changes revert); true if something was. */
  close(): boolean;
  dispose(): void;
}

let owner: FrameXmlOptionsOwner | undefined;

/** Publish the one options owner and return an identity-safe cleanup. */
export function publishFrameXmlOptions(next: FrameXmlOptionsOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.dispose(); } catch { /* a stale VM must not block the new owner */ }
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    try { next.dispose(); } catch { /* mount teardown continues */ }
    owner = undefined;
  };
}

function usable(): FrameXmlOptionsOwner | undefined {
  const current = owner;
  return current && !current.failed ? current : undefined;
}

export function frameXmlOptionsPublished(): boolean {
  return usable() !== undefined;
}

export function frameXmlOptionsOpen(): boolean {
  try { return usable()?.isOpen() === true; } catch { return false; }
}

/** Open a stock options frame; false tells the caller to open its native window. */
export function openFrameXmlOptions(window: FrameXmlOptionsWindow, fromGameMenu = false): boolean {
  const current = usable();
  if (!current) return false;
  try { return current.open(window, fromGameMenu); } catch { return false; }
}

/** Close the open stock frame, or open `window`; false tells the caller to use its native window. */
export function toggleFrameXmlOptions(window: FrameXmlOptionsWindow): boolean {
  const current = usable();
  if (!current) return false;
  try {
    if (current.isOpen()) {
      current.close();
      return true;
    }
    return current.open(window, false);
  } catch {
    return false;
  }
}

/** Close a stock options frame if one is up; false when nothing stock was open. */
export function closeFrameXmlOptions(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.close(); } catch { return false; }
}
