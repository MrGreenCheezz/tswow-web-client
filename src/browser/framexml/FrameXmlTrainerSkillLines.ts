/**
 * Plan item 3.29 (L12, 04.10): the trainer's skill-line filter and «buy everything», as Wow.exe 3.3.5a
 * 12340 has them (ClassTrainerFrame.cpp; read-only Ghidra, 2026-10-01/-04). The lines themselves — their
 * order, headers and collapsing — are FrameXmlTrainerGroups.ts.
 *
 * - The filter is one 32-bit mask (0x00c0e4ac), a bit per line at the line's position in the sorted
 *   lines (`1 << (position & 31)`); every new list sets it to all lines (0x00596450). A line shows only
 *   while its bit is set (0x00594ba0, beside the type filter); its header and services go with it.
 * - `GetTrainerSkillLines()` (0x00594650): every line's name in that order, hidden lines included (nil for
 *   a number SkillLine does not name).
 * - `GetTrainerSkillLineFilter(i)` (0x00593eb0): needs a number (else "Usage: …"); `i - 1` below 0 asks
 *   whether every line is on, past the last line is the error "Bad skill line in …"; the answer is 1 or nil.
 * - `SetTrainerSkillLineFilter(i, on, exclusive)` (0x00596010): needs a number; `i - 1` below 0 turns every
 *   line on (the other arguments unread); past the last line is "Bad skill line in …"; `on` must be a number
 *   (else "Missing on//off parameter in …"): 0 clears the bit, anything else sets it — alone when
 *   `exclusive` is a number other than 0. Then the list is rebuilt, the selection reset (0x00594ba0) and
 *   TRAINER_UPDATE raised (0x00595010).
 * - `BuyTrainerService(i)` (0x00595e60): needs a number (else "Usage: BuyTrainerService(index)" and nothing
 *   is bought); `i - 1` below 0 buys every visible row in turn (0x00594e50 → 0x00594da0); otherwise row i.
 *   0x00594da0 sends CMSG_TRAINER_BUY_SPELL (0x1b2: the trainer guid, the row's spell) only for a row whose
 *   state is "available"; it checks no money — the realm does (Trainer::TeachSpell). A header row's state
 *   byte is never written by the list builder, so here a header buys nothing (the realm would refuse its
 *   spell id of -1 anyway). Stock calls it only with ClassTrainerFrame.selectedService, a row the Train
 *   button was enabled for (Blizzard_TrainerUI.lua:21, :400); 0 is an add-on's or a macro's «everything».
 *   Wow.exe also takes an index past the visible rows, reaching the hidden ones its sort keeps after them;
 *   this list keeps only the visible rows, so such an index buys nothing.
 *
 * Numbers are taken as Lua's `lua_isnumber` does (a numeric string counts) and truncated toward zero
 * (0x0088b9c0 = cvttsd2si).
 */
import { frameXmlLuaNumber } from "./FrameXmlPvpFlag.js";
import type { FrameXmlTrainerEntry, FrameXmlTrainerGroupRow, FrameXmlTrainerState } from "./FrameXmlTrainerGroups.js";

/** TRAINER_STATE_AVAILABLE (a type-only import: FrameXmlTrainerGroups.ts imports this file). */
const AVAILABLE: FrameXmlTrainerState = 0;

/** Every line on: what a new list starts with. */
export const TRAINER_LINE_FILTER_ALL = 0xffffffff;

const lineBit = (position: number): number => (1 << (position & 31)) >>> 0;

/** The mask and its three operations; positions are 0-based in the sorted lines. */
export class FrameXmlTrainerLineFilter {
  #mask = TRAINER_LINE_FILTER_ALL;

  get mask(): number {
    return this.#mask;
  }

  /** A new list: every line on again. */
  reset(): void {
    this.#mask = TRAINER_LINE_FILTER_ALL;
  }

  shown(position: number): boolean {
    return (this.#mask & lineBit(position)) !== 0;
  }

  /** `GetTrainerSkillLineFilter(0)`: every one of `count` lines on. */
  allShown(count: number): boolean {
    for (let position = 0; position < count; position++) if (!this.shown(position)) return false;
    return true;
  }

  /** 0x00596010 after its checks: `position` < 0 is every line. */
  set(position: number, on: boolean, exclusive: boolean): void {
    if (position < 0) this.#mask = TRAINER_LINE_FILTER_ALL;
    else if (!on) this.#mask = (this.#mask & ~lineBit(position)) >>> 0;
    else if (exclusive) this.#mask = lineBit(position);
    else this.#mask = (this.#mask | lineBit(position)) >>> 0;
  }
}

/** 0x00594e50: the spell of every visible row that is "available", in row order (headers have none). */
export function frameXmlTrainerBuyAll<Row extends FrameXmlTrainerGroupRow>(
  entries: readonly FrameXmlTrainerEntry<Row>[], buy: (spellId: number) => void,
): void {
  for (const entry of entries) {
    if (!entry.header && entry.state === AVAILABLE && entry.row.spellId > 0) buy(entry.row.spellId);
  }
}

/** What a seam offers the three line functions. */
export interface FrameXmlTrainerSkillLineModel {
  /** Every line's name, in the sorted order, hidden ones included. */
  names(): readonly (string | undefined)[];
  /** `GetTrainerSkillLineFilter`: undefined for a line past the last (a Lua error). */
  filter(position: number): boolean | undefined;
  /** `SetTrainerSkillLineFilter` after its argument checks; false for a line past the last (a Lua error). */
  setFilter(position: number, on: boolean, exclusive: boolean): boolean;
}

/** The list methods the model needs (FrameXmlTrainerList). */
export interface FrameXmlTrainerSkillLineList {
  skillLineNames(): (string | undefined)[];
  skillLineFilter(position: number): boolean | undefined;
  setSkillLineFilter(position: number, on: boolean, exclusive: boolean): boolean;
}

/** A seam's model over its trainer list; `changed` raises TRAINER_UPDATE after a filter write (0x00595010). */
export function frameXmlTrainerSkillLineModel(
  list: FrameXmlTrainerSkillLineList, changed: () => void,
): FrameXmlTrainerSkillLineModel {
  return {
    names: () => list.skillLineNames(),
    filter: (position) => list.skillLineFilter(position),
    setFilter: (position, on, exclusive) => {
      if (!list.setSkillLineFilter(position, on, exclusive)) return false;
      changed();
      return true;
    },
  };
}

/** The part of the world seam the bindings read. */
export interface FrameXmlTrainerSkillLineHost {
  readonly trainerSkillLines?: FrameXmlTrainerSkillLineModel | undefined;
  buyTrainerService(index: number): void;
}

/** A Lua number argument as the client reads it (`lua_isnumber` + cvttsd2si), or undefined. */
function luaIndex(value: unknown): number | undefined {
  const number = frameXmlLuaNumber(value);
  return number === undefined || !Number.isFinite(number) ? undefined : Math.trunc(number);
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const ONE: readonly unknown[] = Object.freeze([1]);
const NIL: readonly unknown[] = Object.freeze([undefined]);

export const FRAMEXML_TRAINER_SKILL_LINE_BINDINGS: Readonly<Record<string,
  (host: FrameXmlTrainerSkillLineHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  GetTrainerSkillLines: (host) => [...(host.trainerSkillLines?.names() ?? NOTHING)],
  GetTrainerSkillLineFilter: (host, args) => {
    const index = luaIndex(args[0]);
    if (index === undefined) throw new Error("Usage: GetTrainerSkillLineFilter(index)");
    const shown = host.trainerSkillLines?.filter(index - 1);
    if (shown === undefined) throw new Error("Bad skill line in GetTrainerSkillLineFilter");
    return shown ? ONE : NIL;
  },
  SetTrainerSkillLineFilter: (host, args) => {
    const index = luaIndex(args[0]);
    if (index === undefined) throw new Error("Usage: SetTrainerSkillLineFilter(index [, on\\off, exclusive])");
    const model = host.trainerSkillLines;
    if (index - 1 < 0) {
      model?.setFilter(-1, true, false);
      return NOTHING;
    }
    // The line is checked before the second argument (0x00596010).
    if (!model || model.filter(index - 1) === undefined) throw new Error("Bad skill line in SetTrainerSkillLineFilter");
    const on = luaIndex(args[1]);
    if (on === undefined) throw new Error("Missing on//off parameter in SetTrainerSkillLineFilter");
    const exclusive = luaIndex(args[2]);
    model.setFilter(index - 1, on !== 0, exclusive !== undefined && exclusive !== 0);
    return NOTHING;
  },
  // Over the base binding: a missing index is the client's usage error, never «everything» (slotOf's 0).
  BuyTrainerService: (host, args) => {
    const index = luaIndex(args[0]);
    if (index === undefined) throw new Error("Usage: BuyTrainerService(index)");
    host.buyTrainerService(index);
    return NOTHING;
  },
});
