/**
 * Plan item 3.01 (06.11): the rest of the COMBAT_TEXT_UPDATE family — the messages the combat log's own entries raise,
 * as Wow.exe 3.3.5a (12340) raises them, in the same functions that write the entries (Ghidra read-only, 06.11;
 * .runtime/re-2026-11-06/301/notes.md). Each goes out with 0x0081b530(0x1e4, …) after the entry, and only for the
 * combat-text unit (CombatTextSetActiveUnit, 0x00ca1380). The type names are 0x00adb820's.
 *
 * - Damage (0x00750660, 0x007512b0 melee, 0x00751150 environment): resisted → RESIST (amount, resisted); blocked →
 *   BLOCK (amount, blocked); absorbed → ABSORB (amount, absorbed); critical → DAMAGE_CRIT (amount); else DAMAGE
 *   (amount). SPELL_DAMAGE (kind 9) takes the SPELL_ names; a ranged, a periodic and a melee hit take the plain ones.
 * - Misses (0x00750500, 0x007512b0, 0x00751c40 without damage): the miss type, type only, SPELL_ for SPELL_MISSED.
 * - DAMAGE_SHIELD (0x00752c90): the amount, for the unit the shield hurt.
 * - Heals (0x00750860): HEAL, HEAL_CRIT, PERIODIC_HEAL (healer's name, amount), and their _ABSORB forms with the
 *   absorbed amount; nothing for a periodic heal whose aura lasts over 30 s.
 * - Power (0x00750a90, 0x00750b60): ENERGIZE / PERIODIC_ENERGIZE (amount, power token); a drain or leech the unit
 *   suffers is ENERGIZE with the amount negative, the part a leech gives it ENERGIZE (PERIODIC_ENERGIZE when periodic).
 * - Auras (0x00752710): SPELL_AURA_START/_HARMFUL, SPELL_AURA_END/_HARMFUL (the spell's name) for a named, shown,
 *   non-passive spell without AttributesEx6 0x400; an end only on a living unit; a helpful start not for a spell
 *   whose cast already said so (AttributesEx6 0x40, SPELL_CAST).
 * - SPLIT_DAMAGE (0x00752de0): the share's damage message under the plain names (0x00750660 with kind 0x2a), then
 *   SPLIT_DAMAGE (amount), for the unit that took the share.
 * - INTERRUPT (0x007523d0): the interrupted spell's name, for the unit whose cast it was; SPELL_DISPELLED
 *   (0x00752930, SPELL_DISPEL and SPELL_STOLEN): the removed aura's name, for the unit that lost it. Both spells
 *   known, shown (no Attributes 0x180) and named. EXTRA_ATTACKS (0x00752520): the count, for the unit given them.
 *
 * Not from entries: FACTION, HONOR_GAINED, ARENA_POINTS_GAINED (FrameXmlCombatTextPoints.ts) and SPELL_ACTIVE.
 * SPELL_AURA_BROKEN's SPELL_DISPELLED (0x00752a40) rides SMSG_SPELLBREAKLOG, which the core never sends. A periodic
 * heal's duration is the row's, without SpellDuration's per-level growth, which no stock heal-over-time row uses.
 */

import { CL, type CombatLogEntry } from "../../world/CombatEventModel.js";

/** One COMBAT_TEXT_UPDATE: the type name, then its values. */
export type FrameXmlCombatTextMessage = readonly [type: string, ...values: (string | number)[]];

/** What the rules read beyond the entry. */
export interface FrameXmlCombatTextFacts {
  /** The combat-text unit's GUID, 0n before CombatTextSetActiveUnit names one. */
  readonly unit: bigint;
  /** 0x0074d750: a GUID's name, undefined when unknown (the caller's UNKNOWNOBJECT then). */
  name(guid: bigint): string | undefined;
  /** The global string UNKNOWNOBJECT, or undefined. */
  unknownName(): string | undefined;
  /** A spell row: attribute words, name and duration (ms, SpellDuration resolved); undefined while not known. */
  spell(id: number): { readonly attributes?: readonly number[]; readonly name?: string; readonly duration?: number;
    readonly maxDuration?: number } | undefined;
  /** Whether the unit is alive (health above 0), for an aura's end. */
  alive(guid: bigint): boolean;
}

/** SpellMissInfo → the plain and the SPELL_ type (0x00750500's switch; IMMUNE for 7 and 8). */
const MISS_TYPES: readonly (readonly [string, string] | undefined)[] = [
  undefined, ["MISS", "SPELL_MISS"], ["RESIST", "SPELL_RESIST"], ["DODGE", "SPELL_DODGE"], ["PARRY", "SPELL_PARRY"],
  ["BLOCK", "SPELL_BLOCK"], ["EVADE", "SPELL_EVADE"], ["IMMUNE", "SPELL_IMMUNE"], ["IMMUNE", "SPELL_IMMUNE"],
  ["DEFLECT", "SPELL_DEFLECT"], ["ABSORB", "SPELL_ABSORB"], ["REFLECT", "SPELL_REFLECT"],
];

/** 0x007fe4b0: the power token; past the list, an empty string. */
const POWER_TOKENS = ["MANA", "RAGE", "FOCUS", "ENERGY", "HAPPINESS", "RUNES", "RUNIC_POWER"] as const;

export function frameXmlCombatTextPowerToken(powerType: number): string {
  return POWER_TOKENS[powerType] ?? "";
}

/** 0x00750860: a heal-over-time whose aura lasts over this many milliseconds raises nothing. */
export const FRAMEXML_COMBAT_TEXT_PERIODIC_HEAL_MAX_MS = 30_000;

const ATTR0_HIDDEN = 0x80 | 0x100;
const ATTR0_PASSIVE = 0x40;
const ATTR6_COMBAT_TEXT_CAST = 0x40;
const ATTR6_NO_AURA_TEXT = 0x400;

function damageMessage(entry: CombatLogEntry, spell: boolean): FrameXmlCombatTextMessage {
  const amount = entry.n1;
  if (entry.n5 > 0) return [spell ? "SPELL_RESIST" : "RESIST", amount, entry.n5];
  if (entry.n6 !== 0) return [spell ? "SPELL_BLOCK" : "BLOCK", amount, entry.n6];
  if (entry.n4 !== 0) return [spell ? "SPELL_ABSORB" : "ABSORB", amount, entry.n4];
  if ((entry.bits & 1) !== 0) return [spell ? "SPELL_DAMAGE_CRIT" : "DAMAGE_CRIT", amount];
  return [spell ? "SPELL_DAMAGE" : "DAMAGE", amount];
}

function healerName(entry: CombatLogEntry, facts: FrameXmlCombatTextFacts): string {
  const name = facts.name(entry.source);
  if (name) return name;
  const unknown = facts.unknownName();
  return unknown ? unknown : "UKNOWNOBJECT";
}

function healMessage(entry: CombatLogEntry, facts: FrameXmlCombatTextFacts): FrameXmlCombatTextMessage | undefined {
  const periodic = entry.event === CL.SPELL_PERIODIC_HEAL;
  if (periodic) {
    const spell = facts.spell(entry.spellId);
    const duration = spell?.duration ?? 0;
    const lasts = spell?.maxDuration && spell.maxDuration > 0 ? Math.min(duration, spell.maxDuration) : duration;
    if (lasts > FRAMEXML_COMBAT_TEXT_PERIODIC_HEAL_MAX_MS) return undefined;
  }
  const name = healerName(entry, facts);
  const critical = (entry.bits & 1) !== 0;
  if (entry.n2 !== 0) {
    return [periodic ? "PERIODIC_HEAL_ABSORB" : critical ? "HEAL_CRIT_ABSORB" : "HEAL_ABSORB", name, entry.n0, entry.n2];
  }
  return [periodic ? "PERIODIC_HEAL" : critical ? "HEAL_CRIT" : "HEAL", name, entry.n0];
}

function auraMessage(entry: CombatLogEntry, facts: FrameXmlCombatTextFacts): FrameXmlCombatTextMessage | undefined {
  const start = entry.event === CL.SPELL_AURA_APPLIED;
  if (!start && !facts.alive(entry.dest)) return undefined;
  const spell = facts.spell(entry.spellId);
  if (!spell || entry.spellId === 0 || !spell.name) return undefined;
  const attr0 = spell.attributes?.[0] ?? 0;
  const attr6 = spell.attributes?.[6] ?? 0;
  if ((attr0 & (ATTR0_HIDDEN | ATTR0_PASSIVE)) !== 0 || (attr6 & ATTR6_NO_AURA_TEXT) !== 0) return undefined;
  const harmful = (entry.bits & 1) !== 0;
  if (!start) return [harmful ? "SPELL_AURA_END_HARMFUL" : "SPELL_AURA_END", spell.name];
  if (harmful) return ["SPELL_AURA_START_HARMFUL", spell.name];
  return (attr6 & ATTR6_COMBAT_TEXT_CAST) === 0 ? ["SPELL_AURA_START", spell.name] : undefined;
}

/** A known, shown and named spell's name (0x004cfd20, Attributes 0x180, the name's first byte). */
function shownSpellName(facts: FrameXmlCombatTextFacts, id: number): string | undefined {
  const spell = facts.spell(id);
  if (!spell?.name || ((spell.attributes?.[0] ?? 0) & ATTR0_HIDDEN) !== 0) return undefined;
  return spell.name;
}

/** 0x007523d0, 0x00752930: the entry's spell and its extra spell both pass; the extra one's name. */
function extraSpellName(entry: CombatLogEntry, facts: FrameXmlCombatTextFacts): string | undefined {
  return shownSpellName(facts, entry.spellId) !== undefined ? shownSpellName(facts, entry.n0) : undefined;
}

/**
 * The COMBAT_TEXT_UPDATE messages one combat-log entry raises, in order; none when the combat-text unit is neither
 * side the entry's sender asks about. `source` and `dest` are the entry's GUIDs before any spawn-counter masking.
 */
export function frameXmlCombatTextForEntry(entry: CombatLogEntry, source: bigint, dest: bigint,
  facts: FrameXmlCombatTextFacts): readonly FrameXmlCombatTextMessage[] {
  const unit = facts.unit;
  if (unit === 0n) return [];
  const toUnit = dest === unit;
  switch (entry.event) {
    case CL.ENVIRONMENTAL_DAMAGE: case CL.SWING_DAMAGE: case CL.RANGE_DAMAGE: case CL.SPELL_PERIODIC_DAMAGE:
      return toUnit ? [damageMessage(entry, false)] : [];
    case CL.SPELL_DAMAGE:
      return toUnit ? [damageMessage(entry, true)] : [];
    case CL.DAMAGE_SHIELD:
      return toUnit ? [["DAMAGE_SHIELD", entry.n1]] : [];
    case CL.DAMAGE_SPLIT:
      return toUnit ? [damageMessage(entry, false), ["SPLIT_DAMAGE", entry.n1]] : [];
    case CL.SPELL_INTERRUPT: case CL.SPELL_DISPEL: case CL.SPELL_STOLEN: {
      const name = toUnit ? extraSpellName(entry, facts) : undefined;
      return name ? [[entry.event === CL.SPELL_INTERRUPT ? "INTERRUPT" : "SPELL_DISPELLED", name]] : [];
    }
    case CL.SPELL_EXTRA_ATTACKS:
      return toUnit && entry.n0 !== 0 ? [["EXTRA_ATTACKS", entry.n0]] : [];
    case CL.SWING_MISSED: case CL.RANGE_MISSED: case CL.SPELL_MISSED: case CL.SPELL_PERIODIC_MISSED: {
      const names = toUnit ? MISS_TYPES[entry.n0] : undefined;
      return names ? [[names[entry.event === CL.SPELL_MISSED ? 1 : 0]]] : [];
    }
    case CL.SPELL_HEAL: case CL.SPELL_PERIODIC_HEAL: {
      const message = toUnit ? healMessage(entry, facts) : undefined;
      return message ? [message] : [];
    }
    case CL.SPELL_ENERGIZE: case CL.SPELL_PERIODIC_ENERGIZE:
      return toUnit ? [[entry.event === CL.SPELL_ENERGIZE ? "ENERGIZE" : "PERIODIC_ENERGIZE", entry.n0,
        frameXmlCombatTextPowerToken(entry.n1)]] : [];
    case CL.SPELL_DRAIN: case CL.SPELL_LEECH: case CL.SPELL_PERIODIC_DRAIN: case CL.SPELL_PERIODIC_LEECH: {
      const messages: FrameXmlCombatTextMessage[] = [];
      const token = frameXmlCombatTextPowerToken(entry.n1);
      if (toUnit && entry.n0 !== 0) messages.push(["ENERGIZE", -entry.n0, token]);
      if (source === unit && entry.n2 !== 0) {
        messages.push([entry.event === CL.SPELL_PERIODIC_LEECH ? "PERIODIC_ENERGIZE" : "ENERGIZE", entry.n2, token]);
      }
      return messages;
    }
    case CL.SPELL_AURA_APPLIED: case CL.SPELL_AURA_REMOVED: {
      const message = toUnit ? auraMessage(entry, facts) : undefined;
      return message ? [message] : [];
    }
    default:
      return [];
  }
}
