/**
 * The tutorial flags and the lag report of the stock C API (WORK_PLAN 5.25, 8.17), by Wow.exe 3.3.5a
 * (`.runtime/re-2026-10-02/a3-mech/`, d3):
 * * `FlagTutorial(n)` (0x530750): `n − 1` below 60 goes to 0x530450, which sends `CMSG_TUTORIAL_FLAG`
 *   with `n − 1` unless that bit is already set, and sets it. TutorialFrame.lua:650 calls it.
 * * `IsTutorialFlagged(n)` (0x5307a0): `n − 1` below 60 answers 1 when the bit is set, nil when it is
 *   not or before the account's words arrived (0x5222b0 checks they did). TutorialFrame.lua:816.
 * * `GMReportLag(kind)` (0x5ad020 → 0x5acf30): `CMSG_GM_REPORT_LAG` with `kind − 1`, the map and
 *   the position; STATIC_CONSTANTS (FrameXmlMechanics' Lua half) gives HelpFrame its kinds.
 */

/** What the model needs of the world; `WorldClient` satisfies it. */
export interface FrameXmlSupportWorld {
  setTutorialSeen(index: number): void;
  isTutorialSeen(index: number): boolean | undefined;
  reportLag(kind: number): boolean;
}

/** The client's limit for the Lua tutorial ids (0x530750, 0x5307a0: `n − 1 < 0x3c`). */
const LUA_TUTORIALS = 60;
const NOTHING: readonly unknown[] = Object.freeze([]);
const ONE: readonly unknown[] = Object.freeze([1]);

/** Lua's number → C integer, as the client's `lua_tonumber` and truncation read an argument. */
function integerOf(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

export class FrameXmlSupportModel {
  readonly #world: () => FrameXmlSupportWorld | undefined;

  constructor(world: () => FrameXmlSupportWorld | undefined) {
    this.#world = world;
  }

  flagTutorial(value: unknown): void {
    const id = integerOf(value);
    if (id !== undefined && id - 1 >= 0 && id - 1 < LUA_TUTORIALS) this.#world()?.setTutorialSeen?.(id - 1);
  }

  isTutorialFlagged(value: unknown): boolean {
    const id = integerOf(value);
    if (id === undefined || id - 1 < 0 || id - 1 >= LUA_TUTORIALS) return false;
    return this.#world()?.isTutorialSeen?.(id - 1) === true;
  }

  reportLag(value: unknown): void {
    const kind = integerOf(value);
    if (kind !== undefined) this.#world()?.reportLag?.(kind);
  }
}

/** The part of the world seam the bindings read. */
export interface FrameXmlSupportHost {
  readonly support?: FrameXmlSupportModel | undefined;
}

export const FRAMEXML_SUPPORT_BINDINGS: Readonly<Record<string, (host: FrameXmlSupportHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  FlagTutorial: (host, args) => { host.support?.flagTutorial(args[0]); return NOTHING; },
  IsTutorialFlagged: (host, args) => (host.support?.isTutorialFlagged(args[0]) ? ONE : NOTHING),
  GMReportLag: (host, args) => { host.support?.reportLag(args[0]); return NOTHING; },
});
