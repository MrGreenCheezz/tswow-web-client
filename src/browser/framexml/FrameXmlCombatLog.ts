/**
 * Plan item 3.01, slice B: the combat log's entry buffer, its filters and its C API, as Wow.exe
 * 3.3.5a 12340 keeps them (read-only Ghidra, .runtime/re-2026-10-02/a2-m8/d1.c, d2.c, d6.c).
 *
 * - Entries live in one list, oldest first, kept by time only: a new entry recycles the oldest when
 *   it is older than `combatLogRetentionTime` (CVar, default 300 s; 0x00750400). Here the list is a
 *   ring of pooled entries with a count cap as well (`FRAMEXML_COMBAT_LOG_CAPACITY`).
 * - The arguments (0x0074e290): timestamp (seconds since the epoch, millisecond fraction), the
 *   subevent, source GUID ("0x" + 16 hex digits), source name (nil when unknown or empty), source
 *   flags, the same three for the destination; then, when the entry has a spell, `spellId,
 *   spellName, spellSchool` from the spell's row (nil, 0 when the row is not known); then the suffix
 *   values in the order of `CombatLogSuffix` in world/CombatEventModel.ts. In the damage block
 *   resisted, blocked and absorbed are nil when 0 and critical/glancing/crushing are 1 or nil; heal's
 *   absorbed is always a number; a drain's extra amount is nil when 0.
 * - `CombatLogGetNumEntries(ignoreFilter)` (0x0074fa70) counts the entries that pass the filter.
 *   `CombatLogSetCurrentEntry(index, ignoreFilter)` (0x0074fae0): index ≥ 1 is the index-th passing
 *   entry from the oldest; index ≤ 0 counts back from the newest (0 the newest). `CombatLogAdvanceEntry
 *   (count, ignoreFilter)` (0x0074fc20) steps that many passing entries, positive towards the newest.
 *   Both answer 1 or nil and leave no current entry when they run off the end. `CombatLogGetCurrentEntry`
 *   (0x0074f2b0) answers the current entry's arguments, or nothing.
 * - Filters (0x0074ff70, 0x0074e050, 0x0074e1a0): `CombatLogAddFilter(events, source, dest)` adds one;
 *   an entry passes when any filter matches (no filter: everything passes). `events` is a list of
 *   subevent names split at commas and spaces (nil: all; "": none); `source`/`dest` is a flag mask, a
 *   GUID string, or nil (anything). A mask matches when the entry's flags share a bit with it in each of
 *   the four groups (affiliation 0xf, reaction 0xf0, control 0x300, type 0xfc00) or any bit in
 *   0xffff0000; a mask that cannot (not every group present and no special bit) is refused with
 *   "CombatLogAddFilter(): incomplete filter for srcMask"/"dstMask". `CombatLog_Object_IsA(flags, mask)`
 *   (0x0074d600) is that same test.
 * - Firing (0x0074f910): COMBAT_LOG_EVENT for an entry that passes the filter, then
 *   COMBAT_LOG_EVENT_UNFILTERED, each only to registered frames; synchronously as the entry is made.
 */

import {
  COMBAT_LOG_ENVIRONMENT_TYPES, COMBAT_LOG_MISS_TYPES, COMBAT_LOG_SUBEVENTS, CombatLogSuffix,
  createCombatLogEntry, type CombatLogEntry,
} from "../../world/CombatEventModel.js";
import type { FrameXmlSeamBinding } from "./FrameXmlWorldSeam.js";

/** The entries kept at most, besides the retention time. */
export const FRAMEXML_COMBAT_LOG_CAPACITY = 4096;
/** `combatLogRetentionTime`'s default (Wow.exe registers the CVar with "300"). */
export const FRAMEXML_COMBAT_LOG_RETENTION = 300;

/** The spell facts an argument list reads: name and school mask. */
export interface FrameXmlCombatLogSpells {
  spell(id: number): { name: string; schoolMask: number } | undefined;
}

/** 0x0074d0d0: "0x" and sixteen upper-case hex digits, as UnitGUID answers too; zero is sixteen zeros. */
export function frameXmlCombatLogGuid(guid: bigint): string {
  return `0x${guid.toString(16).toUpperCase().padStart(16, "0")}`;
}

/** The mask test of 0x0074e1a0 / 0x0074d1a0 / CombatLog_Object_IsA. */
export function frameXmlCombatLogFlagsMatch(flags: number, mask: number): boolean {
  const both = (flags & mask) >>> 0;
  if ((both & 0xffff0000) !== 0) return true;
  return (both & 0xf) !== 0 && (both & 0xf0) !== 0 && (both & 0x300) !== 0 && (both & 0xfc00) !== 0;
}

/** Whether a mask can match anything at all (0x0074ff70's «incomplete filter» check). */
function completeMask(mask: number): boolean {
  return frameXmlCombatLogFlagsMatch(0xffffffff, mask);
}

const SUBEVENT_INDEX: ReadonlyMap<string, number> = new Map(COMBAT_LOG_SUBEVENTS.map((name, index) => [name, index]));

interface CombatLogFilter {
  /** Two words of subevent bits; null for all. */
  readonly events: Uint32Array | null;
  readonly sourceGuid: bigint | undefined;
  readonly sourceMask: number;
  readonly destGuid: bigint | undefined;
  readonly destMask: number;
}

function parseGuid(text: string): bigint | undefined {
  const digits = text.startsWith("0x") || text.startsWith("0X") ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{1,16}$/.test(digits)) return undefined;
  return BigInt(`0x${digits}`);
}

/** Lua numbers for the flag words: signed 32-bit, as LuaBitOp and the original push them. */
function signed(flags: number): number {
  return flags | 0;
}

function maybe(value: number): number | undefined {
  return value === 0 ? undefined : value;
}

/**
 * The buffer, the filters and the argument list. `push` writes one entry the caller filled (from the
 * pool `next` hands out); `args` writes an entry's arguments into a reused array.
 */
export class FrameXmlCombatLogBuffer {
  readonly #capacity: number;
  readonly #ring: CombatLogEntry[] = [];
  readonly #seqs: number[] = [];
  #start = 0;
  #count = 0;
  #nextSeq = 1;
  /** The current entry's sequence number; 0 for none. */
  #current = 0;
  #retention = FRAMEXML_COMBAT_LOG_RETENTION;
  readonly #filters: CombatLogFilter[] = [];
  #spare: CombatLogEntry;
  readonly #spells: FrameXmlCombatLogSpells;
  readonly #args: unknown[] = [];

  constructor(spells: FrameXmlCombatLogSpells, capacity = FRAMEXML_COMBAT_LOG_CAPACITY) {
    this.#spells = spells;
    this.#capacity = Math.max(1, capacity);
    this.#spare = createCombatLogEntry();
  }

  get size(): number {
    return this.#count;
  }

  /** A cleared entry to fill: the slot the next push will use. */
  next(): CombatLogEntry {
    const entry = this.#count < this.#capacity
      ? (this.#ring[(this.#start + this.#count) % this.#capacity] ??= createCombatLogEntry())
      : this.#spare;
    entry.time = 0; entry.event = 0; entry.source = 0n; entry.dest = 0n; entry.spellId = 0; entry.suffix = 0;
    entry.n0 = 0; entry.n1 = 0; entry.n2 = 0; entry.n3 = 0; entry.n4 = 0; entry.n5 = 0; entry.n6 = 0; entry.bits = 0;
    entry.s0 = ""; entry.s1 = "";
    entry.sourceName = undefined; entry.sourceFlags = 0x80000000; entry.destName = undefined; entry.destFlags = 0x80000000;
    return entry;
  }

  /** Keep the entry `next` handed out; recycles by retention time and capacity first. */
  push(entry: CombatLogEntry): void {
    while (this.#count > 0) {
      const oldest = this.#ring[this.#start]!;
      if (this.#count < this.#capacity && entry.time - oldest.time <= this.#retention) break;
      this.#dropOldest();
    }
    const slot = (this.#start + this.#count) % this.#capacity;
    if (entry === this.#spare) {
      // The ring was full when `next` ran: swap the spare in and keep the dropped slot as the spare.
      const reused = this.#ring[slot];
      this.#ring[slot] = entry;
      this.#spare = reused ?? createCombatLogEntry();
    } else {
      this.#ring[slot] = entry;
    }
    this.#seqs[slot] = this.#nextSeq++;
    this.#count += 1;
  }

  #dropOldest(): void {
    if (this.#seqs[this.#start] === this.#current) this.#current = 0;
    this.#start = (this.#start + 1) % this.#capacity;
    this.#count -= 1;
  }

  clear(): void {
    this.#start = 0;
    this.#count = 0;
    this.#current = 0;
  }

  get retention(): number {
    return this.#retention;
  }

  set retention(seconds: number) {
    this.#retention = Number.isFinite(seconds) && seconds >= 0 ? seconds : FRAMEXML_COMBAT_LOG_RETENTION;
  }

  // ---- filters ----

  resetFilter(): void {
    this.#filters.length = 0;
  }

  addFilter(events: unknown, source: unknown, dest: unknown): void {
    let eventBits: Uint32Array | null = null;
    if (typeof events === "string") {
      eventBits = new Uint32Array(2);
      for (const name of events.split(/[ ,]+/)) {
        const index = SUBEVENT_INDEX.get(name);
        if (index !== undefined) eventBits[index >>> 5]! |= 1 << (index & 31);
      }
    }
    const side = (value: unknown, label: string): { guid: bigint | undefined; mask: number } => {
      if (typeof value === "number") {
        const mask = Math.round(value) >>> 0;
        if (!completeMask(mask)) throw new Error(`CombatLogAddFilter(): incomplete filter for ${label}`);
        return { guid: undefined, mask };
      }
      if (typeof value === "string") return { guid: parseGuid(value) ?? 0n, mask: 0 };
      return { guid: undefined, mask: 0xffffffff };
    };
    const src = side(source, "srcMask");
    const dst = side(dest, "dstMask");
    this.#filters.push({ events: eventBits, sourceGuid: src.guid, sourceMask: src.mask, destGuid: dst.guid, destMask: dst.mask });
  }

  passes(entry: CombatLogEntry): boolean {
    if (this.#filters.length === 0) return true;
    for (const filter of this.#filters) {
      if (filter.events !== null && ((filter.events[entry.event >>> 5]! >>> (entry.event & 31)) & 1) === 0) continue;
      if (filter.sourceGuid !== undefined ? entry.source !== filter.sourceGuid
        : !frameXmlCombatLogFlagsMatch(entry.sourceFlags, filter.sourceMask)) continue;
      if (filter.destGuid !== undefined ? entry.dest !== filter.destGuid
        : !frameXmlCombatLogFlagsMatch(entry.destFlags, filter.destMask)) continue;
      return true;
    }
    return false;
  }

  // ---- the cursor ----

  #at(position: number): CombatLogEntry {
    return this.#ring[(this.#start + position) % this.#capacity]!;
  }

  #positionOf(seq: number): number {
    if (seq === 0 || this.#count === 0) return -1;
    const first = this.#seqs[this.#start]!;
    const position = seq - first;
    return position >= 0 && position < this.#count ? position : -1;
  }

  numEntries(ignoreFilter: boolean): number {
    if (ignoreFilter || this.#filters.length === 0) return this.#count;
    let count = 0;
    for (let position = 0; position < this.#count; position++) if (this.passes(this.#at(position))) count += 1;
    return count;
  }

  setCurrent(index: number, ignoreFilter: boolean): boolean {
    this.#current = 0;
    if (index >= 1) {
      let remaining = index;
      for (let position = 0; position < this.#count; position++) {
        if (!ignoreFilter && !this.passes(this.#at(position))) continue;
        remaining -= 1;
        if (remaining === 0) { this.#current = this.#seqs[(this.#start + position) % this.#capacity]!; break; }
      }
    } else {
      let remaining = -index;
      for (let position = this.#count - 1; position >= 0; position--) {
        if (!ignoreFilter && !this.passes(this.#at(position))) continue;
        if (remaining === 0) { this.#current = this.#seqs[(this.#start + position) % this.#capacity]!; break; }
        remaining -= 1;
      }
    }
    return this.#current !== 0;
  }

  advance(count: number, ignoreFilter: boolean): boolean {
    if (count === 0) return this.#positionOf(this.#current) >= 0;
    const from = this.#positionOf(this.#current);
    this.#current = 0;
    if (from < 0) return false;
    const step = count > 0 ? 1 : -1;
    let remaining = Math.abs(count);
    for (let position = from + step; position >= 0 && position < this.#count; position += step) {
      if (!ignoreFilter && !this.passes(this.#at(position))) continue;
      remaining -= 1;
      if (remaining === 0) { this.#current = this.#seqs[(this.#start + position) % this.#capacity]!; break; }
    }
    return this.#current !== 0;
  }

  current(): CombatLogEntry | undefined {
    const position = this.#positionOf(this.#current);
    return position < 0 ? undefined : this.#at(position);
  }

  // ---- arguments ----

  /** 0x0074e290 into a reused array; the caller copies before it keeps them. */
  args(entry: CombatLogEntry): unknown[] {
    const out = this.#args;
    out.length = 0;
    out.push(entry.time, COMBAT_LOG_SUBEVENTS[entry.event], frameXmlCombatLogGuid(entry.source),
      entry.sourceName || undefined, signed(entry.sourceFlags), frameXmlCombatLogGuid(entry.dest),
      entry.destName || undefined, signed(entry.destFlags));
    if (entry.spellId !== 0) this.#spell(out, entry.spellId);
    const suffix = entry.suffix;
    if (suffix === 0) return out;
    if (suffix & CombatLogSuffix.NUMBER) out.push(entry.n0);
    if (suffix & CombatLogSuffix.STRING) out.push(entry.s0);
    if (suffix & CombatLogSuffix.MISS) out.push(COMBAT_LOG_MISS_TYPES[entry.n0] ?? "NONE");
    if (suffix & CombatLogSuffix.ENVIRONMENT) out.push(COMBAT_LOG_ENVIRONMENT_TYPES[entry.n0]);
    if (suffix & CombatLogSuffix.DAMAGE) {
      out.push(entry.n1, entry.n2, entry.n3, maybe(entry.n5), maybe(entry.n6), maybe(entry.n4),
        entry.bits & 1 ? 1 : undefined, entry.bits & 2 ? 1 : undefined, entry.bits & 4 ? 1 : undefined);
    }
    if (suffix & CombatLogSuffix.MISS_ABSORB) out.push(entry.n4);
    if (suffix & CombatLogSuffix.MISS_RESIST) out.push(entry.n5);
    if (suffix & CombatLogSuffix.MISS_BLOCK) out.push(entry.n6);
    if (suffix & CombatLogSuffix.HEAL) out.push(entry.n0, entry.n1, entry.n2, entry.bits & 1 ? 1 : undefined);
    if (suffix & CombatLogSuffix.ENERGIZE) out.push(entry.n0, entry.n1);
    if (suffix & CombatLogSuffix.DRAIN) out.push(entry.n0, entry.n1, maybe(entry.n2));
    if (suffix & CombatLogSuffix.EXTRA_SPELL) this.#spell(out, entry.n0);
    if (suffix & CombatLogSuffix.NAME) out.push(entry.s0);
    if (suffix & CombatLogSuffix.ITEM) out.push(entry.n0, entry.s1);
    if (suffix & CombatLogSuffix.AURA_TYPE) out.push(entry.bits & 1 ? "DEBUFF" : "BUFF");
    if (suffix & CombatLogSuffix.DOSE) out.push(entry.n2);
    return out;
  }

  #spell(out: unknown[], spellId: number): void {
    const spell = this.#spells.spell(spellId);
    if (spell) out.push(spellId, spell.name, spell.schoolMask);
    else out.push(spellId, undefined, 0);
  }
}

/** What the seam's `combatLog` member answers. */
export interface FrameXmlCombatLogModel {
  readonly buffer: FrameXmlCombatLogBuffer;
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const ONE: readonly unknown[] = Object.freeze([1]);

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function integer(value: unknown, usage: string): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw new Error(usage);
  return Math.trunc(number);
}

/** The C API, answered by `seam.combatLog`; a seam without it keeps an empty log. */
export const FRAMEXML_COMBAT_LOG_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  CombatLogGetNumEntries: (seam, args) => [seam.combatLog?.buffer.numEntries(truthy(args[0])) ?? 0],
  CombatLogSetCurrentEntry: (seam, args) => {
    const index = integer(args[0], "Usage: CombatLogSetCurrentEntry(index [,ignoreFilter])");
    return seam.combatLog?.buffer.setCurrent(index, truthy(args[1])) ? ONE : NOTHING;
  },
  CombatLogGetCurrentEntry: (seam) => {
    const buffer = seam.combatLog?.buffer;
    const entry = buffer?.current();
    return entry && buffer ? [...buffer.args(entry)] : NOTHING;
  },
  CombatLogAdvanceEntry: (seam, args) => {
    const count = integer(args[0], "Usage: CombatLogAdvanceEntry(count [,ignoreFilter])");
    return seam.combatLog?.buffer.advance(count, truthy(args[1])) ? ONE : NOTHING;
  },
  CombatLogResetFilter: (seam) => {
    seam.combatLog?.buffer.resetFilter();
    return NOTHING;
  },
  CombatLogAddFilter: (seam, args) => {
    seam.combatLog?.buffer.addFilter(args[0], args[1], args[2]);
    return NOTHING;
  },
  CombatLogClearEntries: (seam) => {
    seam.combatLog?.buffer.clear();
    return NOTHING;
  },
  CombatLogGetRetentionTime: (seam) => [seam.combatLog?.buffer.retention ?? FRAMEXML_COMBAT_LOG_RETENTION],
  CombatLogSetRetentionTime: (seam, args) => {
    const seconds = integer(args[0], "Usage: CombatLogSetRetentionTime(seconds)");
    if (seam.combatLog) seam.combatLog.buffer.retention = seconds;
    return NOTHING;
  },
  CombatLog_Object_IsA: (_seam, args) =>
    frameXmlCombatLogFlagsMatch(Math.round(Number(args[0]) || 0) >>> 0, Math.round(Number(args[1]) || 0) >>> 0) ? ONE : NOTHING,
});
