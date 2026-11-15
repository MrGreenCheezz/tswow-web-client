// 05.11 (3.68): which of a unit's auras its aura list holds, what UnitAura counts and the buff bar shows. Wow.exe's rule, 0x0072C510
// and 0x0053D580, checked on the client spell by spell (F:\WowOracle\tools\aura-list.mjs). The server sends many more than these:
// 10,000 spells of Spell.dbc carry Attributes 0x80 and 4,000 more AttributesEx 0x10000000, and a spell the client has no row for
// (a service aura of a module, say) showed here with its number for a name and no icon.

import { AURA_FLAGS, type ActiveAura } from "./AuraProtocol.js";

/** The three effect bits of an aura's flags: one with none of them holds nothing and is not listed. */
const AURA_EFFECT_BITS = 0x07;

const ATTR0_PASSIVE = 0x40;
const ATTR0_HIDDEN_CLIENTSIDE = 0x80;
const ATTR1_DONT_DISPLAY_IN_AURA_BAR = 0x10000000;
const ATTR5_DONT_SHOW_IF_SELF_CAST = 0x08000000;
const ATTR5_DONT_SHOW_IF_OTHER_CAST = 0x10000000;
const ATTR6_ONLY_VISIBLE_TO_CASTER = 0x00100000;

/**
 * 0x0076BED0: the effects that show a passive spell — the area auras, SPELL_EFFECT 27, 35, 65, 119, 128, 129, 143. Any other
 * passive stays out of the list. 3.68 (11.11): 0x0053D580 reads them at record +0x11C, the Effect column (71; the record is
 * Spell.dbc's columns in order — Attributes at +0x10, AttributesExE at +0x24), not EffectApplyAuraName.
 */
const PASSIVE_EFFECTS_SHOWN = new Set([0x1b, 0x23, 0x41, 0x77, 0x80, 0x81, 0x8f]);

export interface AuraListedSpell {
  /** `Attributes` … `AttributesExG`; a browser's older cached row may lack them. */
  readonly attributes?: readonly number[];
  /** Spell.dbc Effect; a row served without it (an older gateway) is read by its aura types, as before 11.11. */
  readonly effects?: readonly number[] | undefined;
  readonly effectAura: readonly number[];
  /** 3.68 (15.11): Spell.dbc RequiredAuraVision (`/dbc/spells?v=23`); a row without it (an older gateway) reads 0. */
  readonly requiredAuraVision?: number | undefined;
}

/**
 * `spell` undefined is the client having no row: Wow.exe has the whole table to hand and leaves the aura out, and here the row
 * appears once the metadata lands. The list's order (0x00727C00) is AuraOrder.ts.
 *
 * 3.68 (15.11): RequiredAuraVision, last (0x0053D580 → 0x004F72E0; Ghidra .runtime/re-2026-11-15/spell7/s1.c): a spell with a
 * value v is listed only while there is an active player and bit v − 1 of its PLAYER_FIELD_BYTES2 byte 3 is set — the byte
 * TrinityCore's PLAYER_FIELD_BYTES_2_OFFSET_AURA_VISION, which SPELL_AURA_DETECT_AMORE raises as `1 << (misc − 1)`
 * (SpellAuraEffects.cpp HandleDetectAmore; the invisibility and stealth detections set bits of it too). `auraVision` is that byte; undefined is no active player. 0x004F72E0 has this one
 * caller, so nothing else (no drawing path) asks the bits.
 */
export function auraListed(
  aura: Pick<ActiveAura, "flags" | "casterGuid">,
  spell: AuraListedSpell | undefined,
  playerGuid: bigint | undefined,
  petGuid: bigint | undefined,
  auraVision?: number,
): boolean {
  if ((aura.flags & AURA_EFFECT_BITS) === 0 || spell === undefined) return false;
  const attributes = spell.attributes;
  const attr0 = attributes?.[0] ?? 0;
  if ((attr0 & ATTR0_HIDDEN_CLIENTSIDE) !== 0 || ((attributes?.[1] ?? 0) & ATTR1_DONT_DISPLAY_IN_AURA_BAR) !== 0) return false;
  if ((attr0 & ATTR0_PASSIVE) !== 0 && !(spell.effects ?? spell.effectAura).some((type) => PASSIVE_EFFECTS_SHOWN.has(type))) return false;
  const selfCast = (aura.flags & AURA_FLAGS.caster) !== 0;
  if (((attributes?.[5] ?? 0) & (selfCast ? ATTR5_DONT_SHOW_IF_SELF_CAST : ATTR5_DONT_SHOW_IF_OTHER_CAST)) !== 0) return false;
  if (((attributes?.[6] ?? 0) & ATTR6_ONLY_VISIBLE_TO_CASTER) !== 0) {
    const caster = aura.casterGuid;
    if (caster === undefined ? !selfCast : caster !== playerGuid && caster !== petGuid) return false;
  }
  return auraVisionAllows(spell.requiredAuraVision ?? 0, auraVision);
}

/** 3.68 (15.11): 0x004F72E0 for 0x0053D580 — bit (vision − 1) of the active player's aura-vision byte. */
export function auraVisionAllows(vision: number, auraVision: number | undefined): boolean {
  if (vision === 0) return true;
  if (auraVision === undefined) return false;
  return ((1 << ((vision - 1) & 0x1f)) & auraVision & 0xff) !== 0;
}
