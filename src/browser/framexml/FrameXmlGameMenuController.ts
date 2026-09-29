/**
 * The ownership seam between the stock GameMenuFrame and the native `#game-menu` Panel.
 *
 * GameMenu.ts's `toggleGameMenu`/`gameMenuOpen`/`closeGameMenu` ask here first, so Escape
 * (Controls.backOut), the gear button, the MainMenuMicroButton adapter and a world reset reach the
 * stock menu once the mount has published it, and the native Panel otherwise. Every function
 * answers `false` while nothing is published.
 *
 * Escape itself is stock `ToggleGameMenu` once published (UIParent.lua:2868-2903, installed by
 * FrameXmlGameMenuOwner.ts): a chain that dismisses one thing per press — a StaticPopup, the open
 * menu, a chat or dropdown menu, a cast, a targeting cursor, every window, the target — and opens
 * the menu only when nothing was left. This client's own windows and states take their stock
 * places in that chain through {@link FrameXmlNativeEscape}, which Controls.ts registers.
 */

export interface FrameXmlGameMenuOwner {
  isOpen(): boolean;
  show(): void;
  hide(): void;
  /** One Escape press through stock ToggleGameMenu's chain; absent, Controls keeps its native chain. */
  escape?(): void;
}

/**
 * The native pieces of the Escape chain, by the stock step each one stands beside. Each dismisses
 * what it owns if anything is up and answers whether it did, as the stock C functions do.
 */
export interface FrameXmlNativeEscape {
  /** After `StaticPopup_EscapePressed`: native stand-ins for stock popups (the CAMP countdown). */
  popups(): boolean;
  /** `SpellStopCasting()`: the player's own cast or channel. */
  stopCasting(): boolean;
  /** `SpellStopTargeting()`: the ground-target reticle. */
  stopTargeting(): boolean;
  /** Beside `CloseAllWindows()`, on the same press: every native Escape-closable window. */
  windows(): boolean;
  /** `ClearTarget()`. */
  clearTarget(): boolean;
  /**
   * Not a step: `SpellIsTargeting()`, whether what {@link stopTargeting} dismisses is up. Stock asks
   * it before `SpellStopTargeting` in the secure "stop" action and a unit frame's right click
   * (SecureTemplates.lua:396-400, :564-567), and before `SpellTargetUnit` in the "target" action.
   */
  isTargeting?(): boolean;
}

export type FrameXmlNativeEscapeStep = Exclude<keyof FrameXmlNativeEscape, "isTargeting">;

let owner: FrameXmlGameMenuOwner | undefined;
let nativeEscape: FrameXmlNativeEscape | undefined;

/** Publish the one gated stock menu owner and return an identity-safe cleanup. */
export function publishFrameXmlGameMenu(next: FrameXmlGameMenuOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) {
    try { previous.hide(); } catch { /* stale VM teardown must not block the new owner */ }
  }
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    try { next.hide(); } catch { /* mount cleanup continues */ }
    owner = undefined;
  };
}

export function frameXmlGameMenuPublished(): boolean {
  return owner !== undefined;
}

export function frameXmlGameMenuOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/** Toggle the stock menu. A missing owner tells the caller to use its native fallback. */
export function toggleFrameXmlGameMenu(): boolean {
  const current = owner;
  if (!current) return false;
  try {
    if (current.isOpen()) current.hide();
    else current.show();
  } catch {
    // Keep the stock route authoritative until mount teardown; never open the native menu beside it.
  }
  return true;
}

export function closeFrameXmlGameMenu(): boolean {
  const current = owner;
  if (!current) return false;
  try { current.hide(); } catch { /* teardown owns the final cleanup */ }
  return true;
}

/**
 * One Escape press through the published stock chain. False — the caller runs its native chain —
 * while nothing is published or the owner has no chain; true otherwise, even if the chain threw,
 * so the native chain never runs beside the stock one on the same press.
 */
export function escapeFrameXmlGameMenu(): boolean {
  const current = owner;
  if (!current?.escape) return false;
  try { current.escape(); } catch { /* the chain's own Lua errors are already reported */ }
  return true;
}

/** Register the native Escape steps (Controls.ts, once at start-up); identity-safe cleanup. */
export function registerFrameXmlNativeEscape(steps: FrameXmlNativeEscape): () => void {
  nativeEscape = steps;
  return (): void => {
    if (nativeEscape === steps) nativeEscape = undefined;
  };
}

/** Run one native step for the stock chain; false when none is registered or it threw (logged). */
export function runFrameXmlNativeEscape(step: FrameXmlNativeEscapeStep): boolean {
  const steps = nativeEscape;
  const run = steps?.[step];
  if (typeof run !== "function") return false;
  try {
    return run.call(steps) === true;
  } catch (error) {
    console.error(`[Escape] native step ${step} failed`, error);
    return false;
  }
}

/** `SpellIsTargeting()` from the registered steps; false when none is registered or it threw (logged). */
export function frameXmlNativeTargeting(): boolean {
  const steps = nativeEscape;
  const query = steps?.isTargeting;
  if (typeof query !== "function") return false;
  try {
    return query.call(steps) === true;
  } catch (error) {
    console.error("[Escape] native targeting query failed", error);
    return false;
  }
}
