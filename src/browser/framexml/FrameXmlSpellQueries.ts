/**
 * range8 (15.11): the spellbook globals' argument forms and the spell questions the world seam did not answer, as
 * Wow.exe 3.3.5a (12340) answers them. Read-only Ghidra, notes .runtime/re-2026-11-15/range8/a1.c, a2.c, a2.lst,
 * .runtime/re-2026-11-15/spell7/f1.c, f1.lst and .runtime/re-2026-11-15/widgets5/g5.c; behaviour described, no code
 * copied.
 *
 * **The argument parser, 0x00540670(nextArg, allowName).** A number in argument 1 (`lua_isnumber`, so a numeric string
 * too) with a string in argument 2 (`lua_isstring`, so a number too) is a book slot: index = argument 1 − 1 (truncated),
 * 0..0x3ff or a usage error; the book is the pet's when argument 2 is "pet" (0x009ff164), else the player's; the next
 * argument is 3. Otherwise, when the caller allows names and argument 1 is a string (or a number, which Lua reads as
 * one): a second string that the unit parser 0x0060abf0 refuses is a rank (0x005401d0 → 0x0053f5e0 with the name as
 * written, next argument 3); without one (or with a unit token there) 0x00540200 drops a leading `!`, looks the whole
 * text up, and failing that cuts it at the LAST `(` (0x0076e720 is a reverse search) and at the first `)` after it, and
 * looks the two halves up as name and rank (next argument 2). The name list holds the known spells of both books; the
 * spell must then be in the book array (0x0053b4e0), or the function answers nothing. So a lone number with no book is
 * a NAME («5»), which names no spell: GetSpellName(5) is nil in the original.
 *
 * Who takes names: every caller passes allowName 1 except CastSpell (0x00541250 pushes 0, 0): CastSpell(name) is a
 * usage error, so it is left to its own binding. GetSpellCooldown (0x00540e80) and IsCurrentSpell (0x00541500) take a
 * lone number (`lua_isnumber` and `lua_gettop` 1) as a spell id before the parser.
 *
 * **The questions** (each reads the slot's spell row, 0x004cfd20; no row answers nil):
 * - `IsHelpfulSpell` 0x00541800 / `IsHarmfulSpell` 0x005418f0: 0x007fe1b0 answers 1 / 2 (FrameXmlActionRange.ts
 *   `actionRangeSpellKind`).
 * - `IsAttackSpell` 0x00541420: the first effect is SPELL_EFFECT_ATTACK (78).
 * - `IsConsumableSpell` 0x005419f0: any of the eight reagents set with a count above 0.
 * - `GetSpellCount` 0x00540df0 → 0x00801770 → 0x007ffa30: how many casts the bags (not the bank) hold, the smallest
 *   count / need over the reagents; 0 without reagents or without a row — always a number once the parser succeeds.
 * - `IsAutoRepeatSpell` 0x005415d0: the player's book only; the spell is the repeating one (0x007fe130) or the wanted
 *   one (0x007fe180), FrameXmlAutoRepeatWanted.ts.
 * - `SpellHasRange` 0x00541af0: the caster is the player, or for the pet book the pet-bar unit (0x005d3390); without it
 *   nil. 0x00801650 without a target → 0x007ff480 gives the pair, and 1 is answered when either end differs from 0
 *   (0x00482900): an on-next-swing spell (0..100), a melee row (its max is at least the nominal 5 yards) and a ranged
 *   row (its min is at least 5) always; otherwise the row's slot — the friendly one when 0x007fe1b0 calls the spell
 *   helpful — with the ranged weapon's RangedModRange on a player's SPELL_ATTR0 0x2 max and SPELLMOD_RANGE.
 * - `IsSpellInRange` 0x00541c60: the same caster; the unit in the next argument through 0x0060abf0 (a non-string or a
 *   text it refuses: nil); then 0x00809610 as IsActionInRange and IsItemInRange: 1, 0, or nil when the spell cannot
 *   take the unit.
 *
 * - `FindSpellBookSlotByID(id[, isPet])` 0x0053b6c0: the 0-based index 0x0053b4e0 finds (searching the book array
 *   from its end) — not the 1-based slot the other globals take; nil when the spell is in neither array.
 *
 * Not modelled: a unit given by a character's name (0x0060a630) — such a second argument is read as a rank here; the
 * usage errors (0x00817ee0 + 0x0084f280) — a malformed call answers nothing.
 */
import type { FrameXmlSeamBinding, FrameXmlWorldSeam } from "./FrameXmlWorldSeam.js";
import { actionRangeSpellKind, applyRangeModifiers, type ActionRangeHost, type ActionRangeSpell } from "./FrameXmlActionRange.js";
import { frameXmlIsAttackSpell } from "./FrameXmlActionRepeat.js";

/**
 * The unit tokens 0x0060abf0 reads (a second string that is one is no rank). Not modelled: a unit by its name
 * (0x0060a630), which that parser also accepts.
 */
export const FRAMEXML_SPELL_UNIT_TOKEN =
  /^(player|vehicle|pet|target|partypet\d*|party\d*|raidpet\d*|raid\d*|arenapet\d*|arena\d*|commentator\d*|mouseover|focus|npc|questnpc|none)(-?target)*$/i;

/** A 1-based slot of the player's book (`pet` false) or the pet's. */
export interface FrameXmlSpellBookSlot {
  readonly slot: number;
  readonly pet: boolean;
}

/** The spell row columns the questions read (`/dbc/spells`). */
export interface FrameXmlSpellQueryRow extends ActionRangeSpell {
  readonly id: number;
  readonly effects?: readonly number[] | undefined;
  readonly reagents?: readonly { readonly itemId: number; readonly count: number }[] | undefined;
}

/** What the bindings ask of a world seam; a seam without them answers nothing (GetSpellCount 0). */
export interface FrameXmlSpellQuerySeam {
  /** 0x00540670's name form: `rank` undefined is 0x00540200 (`!`, `Name(Rank)`), defined is 0x005401d0 (verbatim). */
  spellBookSlotByName?(text: string, rank: string | undefined): FrameXmlSpellBookSlot | undefined;
  /** The row of a book slot's spell; nothing past the book's end or while the row is not cached. */
  spellBookRowAt?(slot: number, pet: boolean): FrameXmlSpellQueryRow | undefined;
  /** IsSpellInRange's 1 / 0 / nil for a book slot and a unit token. */
  spellInRangeAt?(slot: number, pet: boolean, unit: string): number | undefined;
  /** SpellHasRange for a book slot. */
  spellHasRangeAt?(slot: number, pet: boolean): boolean;
  /** GetSpellCount for a book slot (0x007ffa30). */
  spellCountAt?(slot: number, pet: boolean): number;
  /** IsAutoRepeatSpell's test of a spell id (the repeating or the wanted spell). */
  isAutoRepeatSpellId?(spellId: number): boolean;
  /** 0x0053b4e0: the 1-based book slot of a spell id in the player's or the pet's book array, searched from the end. */
  spellBookSlotOfId?(spellId: number, pet: boolean): number | undefined;
}

/** 0x00815500 with default 0: no argument or nil false, a boolean as is, a number when not 0. */
function flagOf(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Math.trunc(value) !== 0;
  return false;
}

/** The parser's answer: the book slot and the 1-based index of the argument after the spell. */
export interface FrameXmlSpellArgument extends FrameXmlSpellBookSlot {
  readonly next: number;
}

/** `lua_isnumber`: a number, or a string Lua converts to one. */
function luaNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const number = Number(value.trim());
  return Number.isFinite(number) ? number : undefined;
}

/** `lua_isstring`/`lua_tostring`: a string, or a number as Lua prints it. */
function luaString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** 0x00540670 (see the module comment); undefined where it fails (a usage error, or a name in neither book). */
export function frameXmlSpellArgument(
  seam: FrameXmlSpellQuerySeam, args: readonly unknown[], allowName = true,
): FrameXmlSpellArgument | undefined {
  const number = luaNumber(args[0]);
  const book = luaString(args[1]);
  if (number !== undefined && book !== undefined) {
    const index = Math.trunc(number - 1);
    if (index < 0 || index >= 0x400) return undefined;
    return { slot: index + 1, pet: book.toLowerCase() === "pet", next: 3 };
  }
  if (!allowName) return undefined;
  const text = luaString(args[0]);
  if (text === undefined) return undefined;
  if (book !== undefined && !(book !== "" && FRAMEXML_SPELL_UNIT_TOKEN.test(book))) {
    const found = seam.spellBookSlotByName?.(text, book);
    return found ? { ...found, next: 3 } : undefined;
  }
  const found = seam.spellBookSlotByName?.(text, undefined);
  return found ? { ...found, next: 2 } : undefined;
}

function querySeam(seam: FrameXmlWorldSeam): FrameXmlSpellQuerySeam {
  return seam as unknown as FrameXmlSpellQuerySeam;
}

const NOTHING: readonly unknown[] = Object.freeze([]);
const ONE: readonly unknown[] = Object.freeze([1]);
const ZERO: readonly unknown[] = Object.freeze([0]);

/** The globals whose book argument goes through 0x00540670 with names allowed, answered by an inner binding. */
const NAMED_BOOK_GLOBALS = [
  "GetSpellName", "GetSpellTexture", "GetSpellAutocast", "IsPassiveSpell", "IsSelectedSpell", "PickupSpell",
  "GetSpellCooldown",
] as const;

/**
 * The bindings with 0x00540670's forms in front: a name becomes its book slot and book type, a lone number with no
 * book is a name (and names nothing), then the inner binding answers the slot as before. GetSpellCooldown's lone
 * number is a spell id and passes untouched (0x00540e80); IsCurrentSpell's slot or name becomes the spell id the
 * inner binding takes (0x00541500). Applied outermost, so the pet book's own answers (FrameXmlPetActionBar.ts) see
 * the book type the name resolved to.
 */
export function frameXmlWithSpellNames(
  bindings: Readonly<Record<string, FrameXmlSeamBinding>>,
): Record<string, FrameXmlSeamBinding> {
  const wrapped: Record<string, FrameXmlSeamBinding> = { ...bindings };
  for (const name of NAMED_BOOK_GLOBALS) {
    const inner = bindings[name];
    if (!inner) continue;
    wrapped[name] = (seam, args) => {
      if (name === "GetSpellCooldown" && typeof args[0] === "number" && (args.length < 2 || args[1] === undefined)) {
        return inner(seam, args);
      }
      const parsed = frameXmlSpellArgument(querySeam(seam), args);
      if (!parsed) return NOTHING;
      return inner(seam, [parsed.slot, parsed.pet ? "pet" : "spell", ...args.slice(parsed.next - 1)]);
    };
  }
  const current = bindings.IsCurrentSpell;
  if (current) {
    wrapped.IsCurrentSpell = (seam, args) => {
      const id = luaNumber(args[0]);
      if (id !== undefined && (args.length < 2 || args[1] === undefined)) return current(seam, [id]);
      const parsed = frameXmlSpellArgument(querySeam(seam), args);
      const row = parsed ? querySeam(seam).spellBookRowAt?.(parsed.slot, parsed.pet) : undefined;
      return row ? current(seam, [row.id]) : NOTHING;
    };
  }
  return wrapped;
}

/** The row of the spell the arguments name, with the parsed slot; undefined where the original answers nothing. */
function rowOf(seam: FrameXmlWorldSeam, args: readonly unknown[]): FrameXmlSpellQueryRow | undefined {
  const parsed = frameXmlSpellArgument(querySeam(seam), args);
  return parsed ? querySeam(seam).spellBookRowAt?.(parsed.slot, parsed.pet) : undefined;
}

/** 0x005419f0 / 0x005173e0's reagent half: a reagent set with a count above 0. */
export function frameXmlSpellHasReagents(row: Pick<FrameXmlSpellQueryRow, "reagents"> | undefined): boolean {
  return (row?.reagents ?? []).some((reagent) => reagent.itemId !== 0 && reagent.count > 0);
}

/** 0x00482900 against 0: the two differ by at least 0x009ea27c. */
const DIFFERENT = 2.384185791015625e-7;
const ATTR0_RANGED = 0x2;
const ATTR0_ON_NEXT_SWING_ANY = 0x404;
const SPELL_RANGE_MELEE = 1;
const SPELL_RANGE_RANGED = 2;

/**
 * SpellHasRange / ItemHasRange's test (0x00541af0, 0x0051c870): 0x00801650 without a target → 0x007ff480, and either end
 * not 0. A melee row's max is the reach term, at least the nominal 5 yards; a ranged row's min likewise at least 5.
 */
export function frameXmlSpellHasRange(
  spell: ActionRangeSpell, casterIsPlayer: boolean,
  host: Pick<ActionRangeHost, "rangedModRange" | "playerSpellFamily" | "spellModifiers">,
): boolean {
  const attr0 = spell.attributes?.[0] ?? 0;
  if ((attr0 & ATTR0_ON_NEXT_SWING_ANY) !== 0) return true;
  if ((spell.rangeFlags & (SPELL_RANGE_MELEE | SPELL_RANGE_RANGED)) !== 0) return true;
  const helpful = actionRangeSpellKind(spell) === 1;
  const min = helpful ? spell.rangeMinFriendly ?? spell.rangeMin : spell.rangeMin;
  let max = helpful ? spell.rangeMaxFriendly ?? spell.rangeMax : spell.rangeMax;
  if ((attr0 & ATTR0_RANGED) !== 0 && casterIsPlayer) {
    const modRange = host.rangedModRange();
    if (modRange !== undefined) max = modRange * 0.01 * max;
  }
  max = applyRangeModifiers(spell, max, host);
  return Math.abs(min) >= DIFFERENT || Math.abs(max) >= DIFFERENT;
}

/** The spell globals the world seam had no binding for (see the module comment). */
export const FRAMEXML_SPELL_QUERY_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  IsHelpfulSpell: (seam, args) => {
    const row = rowOf(seam, args);
    return row && actionRangeSpellKind(row) === 1 ? ONE : NOTHING;
  },
  IsHarmfulSpell: (seam, args) => {
    const row = rowOf(seam, args);
    return row && actionRangeSpellKind(row) === 2 ? ONE : NOTHING;
  },
  IsAttackSpell: (seam, args) => (frameXmlIsAttackSpell(rowOf(seam, args)) ? ONE : NOTHING),
  IsConsumableSpell: (seam, args) => (frameXmlSpellHasReagents(rowOf(seam, args)) ? ONE : NOTHING),
  GetSpellCount: (seam, args) => {
    const parsed = frameXmlSpellArgument(querySeam(seam), args);
    if (!parsed) return NOTHING;
    return [querySeam(seam).spellCountAt?.(parsed.slot, parsed.pet) ?? 0];
  },
  IsAutoRepeatSpell: (seam, args) => {
    const parsed = frameXmlSpellArgument(querySeam(seam), args);
    if (!parsed || parsed.pet) return NOTHING;
    const row = querySeam(seam).spellBookRowAt?.(parsed.slot, false);
    return row && querySeam(seam).isAutoRepeatSpellId?.(row.id) ? ONE : NOTHING;
  },
  SpellHasRange: (seam, args) => {
    const parsed = frameXmlSpellArgument(querySeam(seam), args);
    return parsed && querySeam(seam).spellHasRangeAt?.(parsed.slot, parsed.pet) ? ONE : NOTHING;
  },
  IsSpellInRange: (seam, args) => {
    const parsed = frameXmlSpellArgument(querySeam(seam), args);
    const unit = parsed ? args[parsed.next - 1] : undefined;
    if (!parsed || typeof unit !== "string") return NOTHING;
    // Range add-ons ask every frame or so: the answers are shared frozen arrays, as IsActionInRange's.
    const answer = querySeam(seam).spellInRangeAt?.(parsed.slot, parsed.pet, unit);
    return answer === undefined ? NOTHING : answer === 1 ? ONE : ZERO;
  },
  // 0x0053b6c0: a number above 0 (else the usage error), the book by 0x00815500's flag; 0x0053b4e0's index is pushed
  // as it is (0x0084e2d0 pushes the integer) — the array index, one less than the slot GetSpellName takes.
  FindSpellBookSlotByID: (seam, args) => {
    const id = luaNumber(args[0]);
    const spellId = id === undefined ? 0 : Math.trunc(id);
    if (spellId <= 0) throw new Error("Usage: FindSpellBookSlotByID(spellID[, isPet])");
    const slot = querySeam(seam).spellBookSlotOfId?.(spellId, flagOf(args[1]));
    return slot === undefined ? NOTHING : [slot - 1];
  },
});
