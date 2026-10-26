/**
 * 10.28 (26.10): full screen as the game has it — the owner's decision of 21.10. Alt+Enter switches it, as in
 * Wow.exe, and so does the stock Video options' «Оконный режим» (`gxWindow`, FrameXmlSettingsCVar.ts): checked is
 * a window, unchecked is the whole screen.
 *
 * In full screen the keyboard is locked to the page (Keyboard Lock API), so Esc reaches the game's menus instead
 * of leaving full screen, and holding Esc leaves it (the browser's own rule while a lock is held, with its own
 * notice). Where the API is missing — a page over plain http from another machine is not a secure context —
 * full screen still works and a press of Esc leaves it, the browser's ordinary way.
 *
 * Electron's F11 (electron/main.cjs) remains the window's own full screen; this is the page's.
 */

/** The parts of `navigator.keyboard` used here (not in every browser's types). */
interface KeyboardLock {
  lock(keys?: string[]): Promise<void>;
  unlock(): void;
}

function keyboardOf(win: Window): KeyboardLock | undefined {
  const keyboard = (win.navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard;
  return typeof keyboard?.lock === "function" && typeof keyboard.unlock === "function" ? keyboard as KeyboardLock : undefined;
}

function documentOf(): Document | undefined {
  return typeof document === "undefined" ? undefined : document;
}

/** Whether the page fills the screen now. */
export function isFullscreen(doc: Document | undefined = documentOf()): boolean {
  return doc?.fullscreenElement != null;
}

/**
 * Into full screen (`on`) or out of it. Entering needs the user's gesture (a key, a click); a refusal is
 * swallowed — the window stays as it was and the options show it as it is.
 */
export function setFullscreen(on: boolean, doc: Document | undefined = documentOf()): void {
  if (doc === undefined || on === isFullscreen(doc)) return;
  const win = doc.defaultView;
  if (on) {
    const root = doc.documentElement;
    if (typeof root.requestFullscreen !== "function") return;
    void root.requestFullscreen({ navigationUI: "hide" }).then(() => {
      // Every key, Esc first: the game's menus answer it, holding it leaves full screen.
      if (win) void keyboardOf(win)?.lock().catch(() => undefined);
    }, () => undefined);
  } else if (typeof doc.exitFullscreen === "function") {
    void doc.exitFullscreen().catch(() => undefined);
  }
}

export function toggleFullscreen(doc: Document | undefined = documentOf()): void {
  setFullscreen(!isFullscreen(doc), doc);
}

/** Alt+Enter, whatever has the focus (an edit box included, as in Wow.exe). */
export function isFullscreenChord(event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): boolean {
  return event.key === "Enter" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

/** Alt+Enter, and the lock let go when full screen ends (by Esc, F11 or the system). Returns the uninstaller. */
export function installFullscreen(doc: Document = document, win: Window = window): () => void {
  const keydown = (event: KeyboardEvent): void => {
    if (!isFullscreenChord(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) toggleFullscreen(doc);
  };
  const change = (): void => {
    if (!isFullscreen(doc)) keyboardOf(win)?.unlock();
  };
  win.addEventListener("keydown", keydown, true);
  doc.addEventListener("fullscreenchange", change);
  return () => {
    win.removeEventListener("keydown", keydown, true);
    doc.removeEventListener("fullscreenchange", change);
  };
}
