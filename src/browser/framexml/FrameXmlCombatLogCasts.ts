/**
 * Plan item 3.01 (03.10, slice 3.01-castlog): which cast entries the combat log writes — the rules of
 * Wow.exe 3.3.5a (12340), read-only notes .runtime/re-2026-10-03/stock-small/g1.c, g2.c.
 *
 * - SPELL_CAST_START. Opcode 0x131 reaches 0x00806700 (dispatcher 0x0080fee0, registered at
 *   0x008100e5). Only a start without CAST_FLAG_PENDING (flags & 1) goes on, first to the cast bar
 *   (0x00805330: UNIT_SPELLCAST_START, event 0x144) and then to 0x00751920, which writes entry 5 when
 *   the caster is a unit in view (0x004d4db0, type mask 8), the spell is not kept out of the log
 *   (0x0074d3f0) and the caster's cast time for it — virtual +0x148: 0x0071ad20 for a unit,
 *   0x006d68d0 for a player — is not 0. A start the caster is not a unit for (a game object's) has
 *   no cast bar and no entry: 0x00806700 gives up first.
 * - SPELL_CAST_SUCCESS. Opcode 0x132 reaches 0x0080e1b0, which calls 0x007519e0 for a GO without
 *   CAST_FLAG_PENDING, or with it when AttributesEx7 has 0x80000000 (record +0x2c). 0x007519e0
 *   writes entry 6 when the caster is a unit in view, the spell is not kept out (0x0074d3f0), opens
 *   no lock (0x0074d3d0: no effect 33, SPELL_EFFECT_OPEN_LOCK) and its cast time IS 0 — a spell with
 *   a cast time has its START, an instant (and a channel) its SUCCESS. The destination is the
 *   target block's object (cast record +0x30), never a hit.
 * - SPELL_CAST_FAILED. Only 0x00808200 writes it (through 0x00751ad0), and it is reached from
 *   SMSG_CAST_FAILED's handler 0x00809af0 (opcode 0x130) and from the client's own checks before a
 *   cast; SMSG_SPELL_FAILURE (0x00809c70) and SMSG_SPELL_FAILED_OTHER (0x00806ad0) write nothing.
 *   0x00808200 stays quiet for SPELL_FAILED_DONT_REPORT (27) and SPELL_FAILED_CUSTOM_ERROR (172), for
 *   the auto-repeat spell's (0x007fe140 keeps it at 0x00d397cc) result repeated, and for the same
 *   spell with the same result again within 3000 ms of the last one (0x00d397c4/c0/bc; the clock
 *   restarts on every repeat). Every GO without CAST_FLAG_PENDING, whoever cast it, zeroes 0x00d397c4
 *   (0x0080e1b0, before its 0x007fecc0 with 187), so the next refusal after it is written (03.10
 *   review, .runtime/re-2026-10-03/stock-small-review/v1.c: the only writers are 0x00808200, the
 *   registration 0x008100e0 and 0x0080e1b0). 0x00751ad0 itself wants a text, a spell record, ATTR0
 *   without 0x180 and a name. The source is the active player.
 *
 * 0x0074d3f0 keeps a spell out when ATTR0 has 0x180 (HIDDEN_CLIENTSIDE, HIDE_IN_COMBAT_LOG), its name
 * is empty, one of its effects is 36 (SPELL_EFFECT_LEARN_SPELL) or AttributesEx4 has 0x1.
 *
 * The cast time: 0x0071ad20/0x006d68d0 take the CastingTimeIndex row (Base + PerLevel × levels over
 * BaseLevel, at least Minimum), scale it by the caster's cast speed unless ATTR0 0x30 or ATTR3
 * 0x20000000, and make a ranged spell (ATTR0 0x2) 0x7fffffff (unit) or +500 ms (player). For this
 * dataset's SpellCastTimes.dbc (2803 rows) a row with Base ≠ 0 always resolves to at least its
 * Minimum > 0 and a row with Base 0 has PerLevel 0 and Minimum 0, so «not 0» is `castTime !== 0` of
 * the gateway's row (its Base). The active player's spell modifiers (0x006d68d0 applies them through
 * 0x007fdb50, op 10 — Presence of Mind, Nature's Swiftness) are not tracked here: the server's
 * START cast time, which carries the same modifiers, stands in for the player's own casts, and the
 * GO reuses the decision its START made.
 *
 * Deliberate differences: a spell row not fetched yet is not kept out (nil name, as the other entries
 * do) and its cast time is the packet's; the name test reads the gateway's placeholder
 * `Spell <id>` (gateway/SpellMetadata.ts) as the empty name it stands for. 05.10-3.01: SPELL_FAILED_TOO_MANY_OF_ITEM
 * (129) with a limit category, which 0x00808200 writes past the repeat test with another text, is `forced`
 * (FrameXmlCombatLogFailed.ts), and 0x007fe190's resets of the auto-repeat result are `autoRepeatReset`
 * (was: «not modelled, whenever auto-repeat stops» — its callers are the attack paths, not the repeat's
 * end). Not modelled (03.10 review): 0x0080e1b0 handles a GO only when 0x007fd830 can resolve the GUIDs at
 * cast record +0x48/+0x50 (the target block's location transports [assumed]), which this log does not check.
 */

import type { SpellMetadata } from "../SpellMetadata.js";

/** `CAST_FLAG_PENDING` (Spell.h:81): a triggered cast (Spell.cpp:4427-4428, 4484-4485). */
export const CAST_LOG_PENDING = 0x1;
const ATTR0_RANGED = 0x2;
const ATTR0_HIDDEN = 0x180;
const ATTR4_NO_CAST_LOG = 0x1;
const ATTR7_ALWAYS_SUCCESS_LOG = 0x80000000;
const EFFECT_OPEN_LOCK = 33;
const EFFECT_LEARN_SPELL = 36;
const SPELL_FAILED_DONT_REPORT = 27;
const SPELL_FAILED_CUSTOM_ERROR = 172;
/** 0x00808200: the same spell and result again within this many milliseconds is not reported. */
export const CAST_LOG_REPEAT_MS = 3000;
/** Remembered starts, per caster; a bound for a crowd, not a rule of the original. */
const MAX_STARTS = 256;

/** The fields of a spell row these rules read; a test may hand a partial row. */
export type CastLogSpell = Partial<Pick<SpellMetadata, "id" | "name" | "attributes" | "effects" | "castTime" | "hidden">>;

function attribute(spell: CastLogSpell, word: number): number {
  const words = spell.attributes;
  if (words === undefined) return word === 0 && spell.hidden === true ? 0x80 : 0;
  return (words[word] ?? 0) >>> 0;
}

function unnamed(spell: CastLogSpell): boolean {
  return spell.name !== undefined && (spell.name === "" || (spell.id !== undefined && spell.name === `Spell ${spell.id}`));
}

/** 0x0074d3f0: a spell the START and SUCCESS entries never name. Unknown rows are not kept out. */
export function castLogHidden(spell: CastLogSpell | undefined): boolean {
  if (spell === undefined) return false;
  if ((attribute(spell, 0) & ATTR0_HIDDEN) !== 0 || unnamed(spell)) return true;
  if (spell.effects?.includes(EFFECT_LEARN_SPELL)) return true;
  return (attribute(spell, 4) & ATTR4_NO_CAST_LOG) !== 0;
}

/** 0x00751ad0's own test for SPELL_CAST_FAILED: ATTR0 0x180 or no name. */
export function castFailedHidden(spell: CastLogSpell | undefined): boolean {
  if (spell === undefined) return false;
  return (attribute(spell, 0) & ATTR0_HIDDEN) !== 0 || unnamed(spell);
}

/** Whether the caster's cast time for the spell is not 0 (virtual +0x148), from the row alone. */
function rowCastTimed(spell: CastLogSpell): boolean | undefined {
  if ((attribute(spell, 0) & ATTR0_RANGED) !== 0) return true;
  return spell.castTime === undefined ? undefined : spell.castTime !== 0;
}

export interface CastLogStart {
  readonly casterGuid: bigint;
  readonly spellId: number;
  readonly castId: number;
  readonly castFlags: number;
  /** The packet's cast time in milliseconds. */
  readonly castTime: number;
  /** The caster is a unit or a player in view (0x004d4db0, type mask 8). */
  readonly casterIsUnit: boolean;
  /** The caster is the active player. */
  readonly self: boolean;
}

export interface CastLogGo {
  readonly casterGuid: bigint;
  readonly spellId: number;
  readonly castId: number;
  readonly castFlags: number;
  readonly casterIsUnit: boolean;
}

export class FrameXmlCombatLogCastRules {
  /** What the last START of each caster decided: its spell, cast id and whether it was timed. */
  readonly #starts = new Map<bigint, { spellId: number; castId: number; timed: boolean }>();
  /** The last refusal written or kept quiet (0x00d397c4 spell, 0x00d397c0 result, 0x00d397bc time). */
  #last: { spellId: number; result: number; at: number } | undefined;
  #autoRepeatResult: number | undefined;

  /** SMSG_SPELL_START: whether SPELL_CAST_START is written (0x00806700 → 0x00751920). */
  start(start: CastLogStart, spell: CastLogSpell | undefined): boolean {
    if ((start.castFlags & CAST_LOG_PENDING) !== 0 || !start.casterIsUnit) return false;
    const row = spell === undefined ? undefined : rowCastTimed(spell);
    const ranged = spell !== undefined && (attribute(spell, 0) & ATTR0_RANGED) !== 0;
    const timed = ranged || (start.self || row === undefined ? start.castTime !== 0 : row);
    // 03.10 review: the caster's record is rewritten in place — no allocation per packet once it exists.
    const record = this.#starts.get(start.casterGuid);
    if (record !== undefined) {
      record.spellId = start.spellId;
      record.castId = start.castId;
      record.timed = timed;
    } else {
      if (this.#starts.size >= MAX_STARTS) this.#starts.clear();
      this.#starts.set(start.casterGuid, { spellId: start.spellId, castId: start.castId, timed });
    }
    return timed && !castLogHidden(spell);
  }

  /** SMSG_SPELL_GO: whether SPELL_CAST_SUCCESS is written (0x0080e1b0 → 0x007519e0). */
  success(go: CastLogGo, spell: CastLogSpell | undefined): boolean {
    const started = this.#starts.get(go.casterGuid);
    const matched = started !== undefined && started.spellId === go.spellId && started.castId === go.castId;
    // Used up (a cast id is a byte, never -1); the record stays for the caster's next START.
    if (matched) started.castId = -1;
    const pending = (go.castFlags & CAST_LOG_PENDING) !== 0;
    // 03.10 review: 0x0080e1b0 zeroes 0x00d397c4 for every GO without CAST_FLAG_PENDING, whoever cast it,
    // before 0x007fecc0's 187 — the next refusal is never «the same one again» (FAILED's 3-second rule).
    if (!pending) this.#last = undefined;
    if (pending && (spell === undefined || (attribute(spell, 7) & ATTR7_ALWAYS_SUCCESS_LOG) === 0)) return false;
    if (!go.casterIsUnit || castLogHidden(spell)) return false;
    if (spell?.effects?.includes(EFFECT_OPEN_LOCK)) return false;
    const timed = matched ? started.timed : (spell === undefined ? false : rowCastTimed(spell) ?? false);
    return !timed;
  }

  /**
   * SMSG_CAST_FAILED: whether SPELL_CAST_FAILED is written (0x00809af0 → 0x00808200 → 0x00751ad0).
   * `now` is a millisecond clock; `autoRepeatSpellId` the spell auto-repeating now, if any — 05.10-3.01: the
   * one 0x00808200 compares is 0x00d397cc, the autoRangedCombat controller's wanted spell (0x007fe180; only
   * 0x006e2be0 sets it, through 0x007fe140 at 0x006e2d77), not the repeating one (0x00d397d0).
   */
  failed(spellId: number, result: number, now: number, autoRepeatSpellId: number | undefined,
    spell: CastLogSpell | undefined, forced = false): boolean { // 05.10-3.01: + forced
    let quiet = false;
    if (autoRepeatSpellId !== undefined && autoRepeatSpellId !== 0 && spellId === autoRepeatSpellId) {
      if (result === this.#autoRepeatResult) quiet = true;
      this.#autoRepeatResult = result;
    }
    const last = this.#last;
    if (last !== undefined && last.spellId === spellId && last.result === result) {
      if (now - last.at < CAST_LOG_REPEAT_MS) quiet = true;
      last.at = now;
    } else {
      this.#last = { spellId, result, at: now };
    }
    if (result === SPELL_FAILED_DONT_REPORT || result === SPELL_FAILED_CUSTOM_ERROR) return false;
    // 05.10-3.01: TOO_MANY_OF_ITEM with its limit-category row (FrameXmlCombatLogFailed.ts) is written past the
    // repeat tests (0x00808ac3 jumps over `local_14`), after they have updated their state above.
    return (forced || !quiet) && !castFailedHidden(spell);
  }

  /**
   * 05.10-3.01: 0x007fe190 — the auto-repeat spell's remembered result back to 187, so its next refusal is
   * written. Its only callers (a scan of every E8 call in .text): StopAttack 0x006e1660 (0x006e16d2,
   * unconditional), the swing 0x006e2610 (0x006e2862) and the autoRangedCombat controller 0x006e2be0
   * (0x006e2df3, when 0x0080da40 casts the shot) — world/AutoRangedCombat.ts counts them.
   */
  autoRepeatReset(): void {
    this.#autoRepeatResult = undefined;
  }

  /** A new world: nothing carries over. */
  reset(): void {
    this.#starts.clear();
    this.#last = undefined;
    this.#autoRepeatResult = undefined;
  }
}
