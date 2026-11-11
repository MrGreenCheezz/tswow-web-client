// 3.68 (11.11): the order of a unit's aura list, the one UnitAura, UnitBuff and UnitDebuff count through, as Wow.exe keeps it
// (read-only Ghidra, .runtime/re-2026-11-11/usable/u1.c, u5.c, .runtime/re-2026-11-11/fxapi/d1.c, d3.c):
//
// - 0x0072C510 brings the list up to date before a read (0x0072C9B0 runs it while the unit's +0xA30 bit 0x40000 is clear):
//   an entry whose slot no longer holds its spell, or holds it with none of the three effect bits, leaves the list; then
//   the slots are walked from the last down to the first, and a listed aura (0x0053D580, AuraListed.ts) the list does not
//   hold yet — same spell, same slot — is inserted by 0x00727C00.
// - 0x00727C00 inserts by class: an aura of the player's own (0x0053BD70) goes after the last own entry, one of the second
//   class (0x0053D750) after the last own or second-class entry, any other at the end. Entries keep their places, so each
//   class is in the order its auras arrived; auras that arrive together go in by falling slot.
// - 0x0053BD70, own: the caster is the player, or the caster's UNIT_FIELD_CHARM (else UNIT_FIELD_SUMMON) is the player, or
//   its UNIT_FIELD_CHARMEDBY (else UNIT_FIELD_CREATEDBY) is (0x004F5F20).
// - 0x0053D750, second class: a spell the player's book (the bit set at 0x00BE8DC4, set by 0x00542030) or the pet's book
//   (0x0053B900, the list at 0x00BE7D98) holds, with an effect 0x0076BD50 takes — APPLY_AURA (6) or an area aura (27, 35, 65,
//   119, 128, 129, 143); or a caster charmed or created by someone whose entry is one the player's book summons (the list at
//   0x00BE8E48/0x00BE8E4C: 0x00542030 adds Effect 28 or 56's EffectMiscValue as a spell is learned). That caster check also
//   asks the unit's +0x964, not read; a summoned creature is taken to pass it.

import { AURA_FLAGS, type ActiveAura } from "./AuraProtocol.js";

/** The three effect bits of an aura's flags. */
const AURA_EFFECT_BITS = 0x07;
/** 0x0076BD50: APPLY_AURA and the area auras. */
const SECOND_CLASS_EFFECTS = new Set([6, 0x1b, 0x23, 0x41, 0x77, 0x80, 0x81, 0x8f]);

/** What the order asks of the world about one unit's auras. */
export interface AuraOrderRules {
  /** 0x0053D580 with the effect bits: whether the list holds the aura at all (AuraListed.ts). */
  listed(aura: ActiveAura): boolean;
  /** 0x0053BD70 for the aura's caster. */
  own(caster: bigint): boolean;
  /** 0x0053D750's first half: the spell is in the player's or the pet's book, with its Effect types (undefined: no row). */
  bookSpell(spellId: number): readonly number[] | undefined;
  /** 0x0053D750's second half: the caster is charmed or created and its entry is one the player's book summons. */
  summonedCaster(caster: bigint): boolean;
}

interface Entry {
  readonly slot: number;
  readonly spellId: number;
}

/** The aura's caster: the unit itself when the caster bit says so (SMSG_AURA_UPDATE sends no guid then). */
function casterOf(aura: ActiveAura, unit: bigint): bigint | undefined {
  return (aura.flags & AURA_FLAGS.caster) !== 0 ? unit : aura.casterGuid;
}

function secondClass(aura: ActiveAura, caster: bigint | undefined, rules: AuraOrderRules): boolean {
  if (rules.bookSpell(aura.spellId)?.some((effect) => SECOND_CLASS_EFFECTS.has(effect)) === true) return true;
  return caster !== undefined && rules.summonedCaster(caster);
}

/** Per unit, the list as it stood after the last read. */
export class AuraOrder {
  readonly #lists = new Map<bigint, Entry[]>();
  /** A unit seen once and gone keeps its list until this many are held; then the oldest go. */
  readonly #limit: number;

  constructor(limit = 256) {
    this.#limit = limit;
  }

  /** The unit's listed auras in the list's order (0x0072C510, 0x00727C00). */
  order(unit: bigint, auras: readonly ActiveAura[], rules: AuraOrderRules): ActiveAura[] {
    const bySlot = new Map<number, ActiveAura>();
    for (const aura of auras) bySlot.set(aura.slot, aura);
    const previous = this.#lists.get(unit) ?? [];
    const list = previous.filter((entry) => {
      const aura = bySlot.get(entry.slot);
      return aura !== undefined && aura.spellId === entry.spellId && (aura.flags & AURA_EFFECT_BITS) !== 0;
    });
    const classOf = (aura: ActiveAura): 0 | 1 | 2 => {
      const caster = casterOf(aura, unit);
      if (caster !== undefined && rules.own(caster)) return 0;
      return secondClass(aura, caster, rules) ? 1 : 2;
    };
    const slots = [...bySlot.keys()].sort((left, right) => right - left);
    for (const slot of slots) {
      const aura = bySlot.get(slot)!;
      if (aura.spellId <= 0 || !rules.listed(aura)) continue;
      if (list.some((entry) => entry.slot === slot && entry.spellId === aura.spellId)) continue;
      const kind = classOf(aura);
      let at = list.length;
      if (kind !== 2) {
        while (at > 0) {
          const before = bySlot.get(list[at - 1]!.slot)!;
          if (classOf(before) <= kind) break;
          at--;
        }
      }
      list.splice(at, 0, { slot, spellId: aura.spellId });
    }
    this.#lists.delete(unit);
    this.#lists.set(unit, list);
    if (this.#lists.size > this.#limit) this.#lists.delete(this.#lists.keys().next().value!);
    return list.map((entry) => bySlot.get(entry.slot)!);
  }

  /** A unit whose list starts again (it left and came back, or the world changed). */
  forget(unit: bigint): void {
    this.#lists.delete(unit);
  }
}
