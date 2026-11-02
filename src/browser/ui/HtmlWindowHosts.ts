/**
 * Where the HTML windows that still exist follow the logic that outlives them: the spell book, the
 * action rows and the craft windows register here, and the logic asks only "is there one".
 *
 * A leaf on purpose. Those windows register while they evaluate, and the logic reaches them through
 * its own imports (Notices and Settings, the macro runner's chat), so a variable in the logic's module
 * could still be in its temporal dead zone at that moment.
 */

/**
 * The spell book window's half of the spell data: its list and the status line under its header,
 * which only it can see. Nothing reaches the player through it under the stock interface; a refusal
 * the player must read goes through `notice` beside the call.
 */
export interface SpellBookHost {
  redraw(): void;
  status(message: string, tone: "muted" | "error"): void;
}

/** The HTML craft windows' half of the craft queue. */
export interface ProfessionWindows {
  /** The queue moved; `force` throws away what the windows drew last, for a change their signature misses. */
  changed(force: boolean): void;
  /** The queue and its tracking are gone: every window closes. */
  closed(): void;
  /** One line's craft window. */
  open(skillId: number): boolean;
}

let spellBook: SpellBookHost | undefined;
let actionBarRedraw: (() => void) | undefined;
let craftWindows: ProfessionWindows | undefined;

export function setSpellBookHost(host: SpellBookHost | undefined): void {
  spellBook = host;
}

export function spellBookHost(): SpellBookHost | undefined {
  return spellBook;
}

export function setActionBarRedraw(redraw: (() => void) | undefined): void {
  actionBarRedraw = redraw;
}

export function redrawActionBar(): void {
  actionBarRedraw?.();
}

export function setProfessionWindows(windows: ProfessionWindows | undefined): void {
  craftWindows = windows;
}

export function professionWindows(): ProfessionWindows | undefined {
  return craftWindows;
}
