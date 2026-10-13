/**
 * 5.09 (13.10): the click a mouse command makes when it is let go, as Wow.exe 3.3.5a (12340) keeps it for
 * TurnOrAction, CameraOrSelectOrMove and Mouselook. Read-only notes: .runtime/re-2026-10-04/l8-movement/g1.c,
 * .runtime/re-2026-10-11/glue-1110/cv311-b.txt, cv311-f.txt, cv311-i.txt.
 *
 * - The input control ([0x00c24954]) keeps a click mode at +0x18: TurnOrActionStart (0x005fc610) sets 2 — interact —
 *   and CameraOrSelectOrMoveStart (0x005fc6c0) 1 — select — each only when neither command was down; MouselookStart
 *   and MouselookStop (0x005fcc10, 0x005fc890) set 0. MoveAndSteerStart is CameraOrSelectOrMove then TurnOrAction.
 * - 0x005fa170, setting a command's bit: the first of the mouse bits (0x6000003) restarts the gesture — the moved
 *   distances +8/+0xc to 0, the time +0x14 to now; a bit set while the other command is down clears the mode (two
 *   commands are no click).
 * - 0x005fba60 adds every mouse move's |dx| and |dy| to +8 and +0xc while a bit is set (the units it is handed; this
 *   client's are CSS pixels).
 * - 0x005fa450, clearing the last of the two command bits: unless 0x005f9600 calls it a drag — held 800 ms or more,
 *   or moved 8 or more on either axis and held 200 ms or more — mode 1 selects what is under the cursor and mode 2
 *   interacts with it (0x004f7880(1) and (4), the world click); the mode goes back to 0.
 *
 * Pure: Controls.ts feeds it the bits and the moves and runs the click it answers.
 */

export const MOUSE_CLICK_NONE = 0;
/** CameraOrSelectOrMove's: select under the cursor (0x004f7880(1)). */
export const MOUSE_CLICK_SELECT = 1;
/** TurnOrAction's: interact with what is under the cursor (0x004f7880(4)). */
export const MOUSE_CLICK_INTERACT = 2;

/** The two command bits (TurnOrAction/Mouselook 1, CameraOrSelectOrMove 2). */
const COMMANDS = 3;
const TURN_OR_ACTION = 1;
/** 0x005f9600: 800 and 200 ms (`param_2 + -800`, `+ -200`), 8 (0x00a1de4c). */
const DRAG_MS = 800;
const MOVED_DRAG_MS = 200;
const SLOP = 8;

/** 0x005f9600: whether a press held `heldMs` that moved `dx`, `dy` was a drag rather than a click. */
export function mouseCommandDragged(heldMs: number, dx: number, dy: number): boolean {
  if (heldMs >= DRAG_MS) return true;
  if (dx < SLOP && dy < SLOP) return false;
  return heldMs >= MOVED_DRAG_MS;
}

export class MouseCommandClick {
  #mode = MOUSE_CLICK_NONE;
  #since = 0;
  #dx = 0;
  #dy = 0;

  /** The mode a release would click with (tests). */
  get mode(): number {
    return this.#mode;
  }

  /**
   * A command's bit set: `bit` is 1 or 2, `before`/`after` the two command bits around it (the page's own buttons
   * counted), `mouselook` for MouselookStart.
   */
  down(bit: number, before: number, after: number, now: number, mouselook: boolean): void {
    if (mouselook) this.#mode = MOUSE_CLICK_NONE;
    else if ((before & COMMANDS) === 0) this.#mode = bit === TURN_OR_ACTION ? MOUSE_CLICK_INTERACT : MOUSE_CLICK_SELECT;
    if ((before & COMMANDS) === 0) {
      this.#dx = 0;
      this.#dy = 0;
      this.#since = now;
    }
    if ((after & COMMANDS) !== bit) this.#mode = MOUSE_CLICK_NONE;
  }

  /** A mouse move while a command is down. */
  moved(dx: number, dy: number): void {
    this.#dx += Math.abs(dx);
    this.#dy += Math.abs(dy);
  }

  /** A command's bit cleared: the click the release makes (0x005fa450), or none. */
  up(before: number, after: number, now: number, mouselook: boolean): number {
    if (mouselook) this.#mode = MOUSE_CLICK_NONE;
    if ((before & COMMANDS) === 0 || (after & COMMANDS) !== 0) return MOUSE_CLICK_NONE;
    const mode = this.#mode;
    this.#mode = MOUSE_CLICK_NONE;
    return mouseCommandDragged(now - this.#since, this.#dx, this.#dy) ? MOUSE_CLICK_NONE : mode;
  }

  /** Focus lost, the world changed: the commands went without a release. */
  reset(): void {
    this.#mode = MOUSE_CLICK_NONE;
  }
}
