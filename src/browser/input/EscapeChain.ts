/**
 * Escape as the original client runs it: one thing per press (WORK_PLAN 4.04).
 *
 * Stock `ToggleGameMenu` (UIParent.lua:2868-2903) is a list of `if … then dismiss; return end`
 * steps — popups, the game menu, the option frames, menus, `SpellStopCasting`, `SpellStopTargeting`,
 * `CloseAllWindows`, `ClearTarget` — and only when none of them had anything to dismiss does it
 * open the menu. A step answers whether it dismissed something; the first that does spends the press.
 */

/** One step of the chain: dismisses its thing and answers true, or answers false and does nothing. */
export type EscapeStep = () => boolean;

/** Runs the steps in order until one answers true; answers whether any did. */
export function runEscapeChain(steps: readonly EscapeStep[]): boolean {
  for (const step of steps) {
    if (step()) return true;
  }
  return false;
}
