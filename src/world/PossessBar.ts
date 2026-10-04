import { UPDATE_FIELDS } from "../generated/updateFields.js";
import type { ActiveAura } from "./AuraProtocol.js";
import { isVehicleActionBar, type PetActionButton } from "./PetProtocol.js";
import type { WorldObjectState } from "./WorldState.js";

/**
 * 11.02-IF: the possess bar of Wow.exe 3.3.5a 12340 — what puts a possessed unit's spells on the main
 * action bar and the two possess buttons beside it — as DOM-free rules over the world. The stock UI's
 * model is `browser/framexml/FrameXmlPossess.ts`; a native key path can read the same rules.
 *
 * Two pieces of client state (Ghidra, read only; `.runtime/re-2026-10-03/l1102if/`):
 *
 * * The possess spell (0x00c234e0). `IsPossessBarVisible` (0x005a8820) and `GetPossessInfo` (0x005d5820)
 *   read it. 0x005d62a0 finds it among the character's **own** auras — the first one without
 *   `AFLAG_NEGATIVE` (0x80) whose spell has, in any of its three EffectApplyAuraName columns,
 *   `SPELL_AURA_MOD_POSSESS` 2, `SPELL_AURA_MOD_POSSESS_PET` 128 or `SPELL_AURA_MOD_CHARM` 6, or
 *   `SPELL_AURA_CONTROL_VEHICLE` 236 while the character rides its charm (else its summon); failing
 *   that, a `SPELL_EFFECT_SUMMON` 28 whose SummonProperties.Control is 3 (a puppet: Eye of Kilrogg 126,
 *   SummonProperties 65). Mind Control 605 and Eyes of the Beast 1002 put a `SPELL_AURA_DUMMY` on the
 *   caster (effect 2, target 1 in Spell.dbc), which is the aura found. A miss keeps the spell already
 *   held. It is looked for when `PLAYER_FARSIGHT` changes and names an object in view (0x006e4fd0; a
 *   field without its object clears it, 0x005d30e0(0)), when the character's `UNIT_FIELD_CHARM`/
 *   `UNIT_FIELD_SUMMON` change (0x006d1970) and at world entry (0x005d6e60). Every change raises
 *   `UPDATE_BONUS_ACTIONBAR`.
 * * The main-bar bit (bit 0 of 0x00c1e5a0), set by 0x005d4ad0 on each `PLAYER_FARSIGHT` change and each
 *   `SMSG_PET_SPELLS` (0x005d6900): the bar's unit is the far sight unit and 0x005d35b0 lets it carry a
 *   bar — not in view, or in view with no `CREATURE_TYPE_FLAG_NO_PET_BAR` 0x2000 on its template
 *   (0x007226b0, creature cache +0xc), health at least 1, and not «a possess spell was found for this
 *   bar and is gone again» unless the unit is a hunter's pet (0x0071b630). For a vehicle the rider's
 *   seat must also show its abilities (VehicleSeat.VehicleAbilityDisplay, +0xa4) — slice F2's; this
 *   file leaves a vehicle's bar alone. While the bit is set `GetBonusBarOffset` is 5 (0x005a83c0),
 *   `GetActionBarPage` is 1 (0x005a7fd0), `PetHasActionBar` is nil (0x005d3720), and action slots
 *   121–130 (0x78–0x81 zero-based) are the pet bar's ten slots, 131–132 empty (0x005ab800 with
 *   0x005d3240: word `0x10000000 | i`, written without `CMSG_SET_ACTION_BUTTON`, one
 *   `ACTIONBAR_SLOT_CHANGED` a slot).
 */

/** `AuraType`, SpellAuraDefines.h:82, 86, 208, 316. */
export const SPELL_AURA_MOD_POSSESS = 2;
export const SPELL_AURA_MOD_CHARM = 6;
export const SPELL_AURA_MOD_POSSESS_PET = 128;
export const SPELL_AURA_CONTROL_VEHICLE = 236;

/** `GetBonusBarOffset()` under the possess bar: action page 11 (NUM_ACTIONBAR_PAGES 6 + 5). */
export const POSSESS_BONUS_BAR_OFFSET = 5;
/** The first of the page's 1-based action slots (Wow.exe 0x78 zero-based) and how many there are. */
export const POSSESS_FIRST_SLOT = 121;
export const POSSESS_PAGE_SLOTS = 12;
/** Slots that mirror the pet bar; the last two of the page stay empty (0x005d3240: `i < 10`). */
export const POSSESS_MIRRORED_SLOTS = 10;
/**
 * 11.02-IF-review: the page those slots are, 0-based as the native bar counts (`ActionBarProtocol.ts`
 * `actionPage`): stock `ActionButton_CalculateAction` gives a bonus button NUM_ACTIONBAR_PAGES 6 +
 * GetBonusBarOffset 5 = page 11, and keys 1–= press BonusActionButton1–12 while that bar is shown
 * (ActionButtonDown, ActionButton.lua).
 */
export const POSSESS_ACTION_PAGE = 10;

/** UnitDefines.h:159 and SharedDefines.h:2738. */
export const UNIT_FLAG_POSSESSED = 0x0100_0000;
export const CREATURE_TYPE_FLAG_NO_PET_BAR = 0x0000_2000;
/** `AFLAG_NEGATIVE` of an aura slot. */
const AURA_FLAG_NEGATIVE = 0x80;
const CLASS_HUNTER = 3;
const TYPEID_PLAYER = 4;

const CHARM = UPDATE_FIELDS.UNIT_FIELD_CHARM.offset;
const SUMMON = UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset;
const CHARMED_BY = UPDATE_FIELDS.UNIT_FIELD_CHARMEDBY.offset;
const CREATED_BY = UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset;
const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const PET_NUMBER = UPDATE_FIELDS.UNIT_FIELD_PETNUMBER.offset;
const BYTES_0 = UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset;

/** The part of a spell row the scan reads: the three EffectApplyAuraName columns (absent on a stub row). */
export interface PossessSpellRow {
  readonly effectAura?: readonly number[] | undefined;
}

/** A guid field's two words, unsigned; zero for a field the server has not sent. */
function words(object: WorldObjectState | undefined, offset: number): readonly [number, number] {
  return object === undefined ? [0, 0] : [(object.fields.get(offset) ?? 0) >>> 0, (object.fields.get(offset + 1) ?? 0) >>> 0];
}

function fieldEmpty(object: WorldObjectState, offset: number): boolean {
  const [low, high] = words(object, offset);
  return low === 0 && high === 0;
}

/** A guid field as a bigint, zero when empty. */
export function guidFieldOf(object: WorldObjectState | undefined, offset: number): bigint {
  const [low, high] = words(object, offset);
  return high === 0 ? BigInt(low) : (BigInt(high) << 32n) | BigInt(low);
}

/**
 * The guid 0x005d62a0 compares the character's transport with: `UNIT_FIELD_CHARM`, or
 * `UNIT_FIELD_SUMMON` while the charm is empty (also the stock "pet" token, 0x0060abf0).
 */
export function charmOrSummonOf(character: WorldObjectState | undefined): bigint {
  if (character === undefined) return 0n;
  return fieldEmpty(character, CHARM) ? guidFieldOf(character, SUMMON) : guidFieldOf(character, CHARM);
}

/** The character rides the unit it charms (or summons): `CONTROL_VEHICLE` then counts as a possess aura. */
export function drivesCharm(character: WorldObjectState | undefined): boolean {
  const transport = character?.transport?.guid;
  if (transport === undefined || transport === 0n || character === undefined) return false;
  return transport === charmOrSummonOf(character);
}

/** The spell's possess-like aura per 0x005d62a0's first loop. */
function possessAura(row: PossessSpellRow, driving: boolean): boolean {
  for (let effect = 0; effect < 3; effect++) {
    const aura = row.effectAura?.[effect];
    if (aura === SPELL_AURA_MOD_POSSESS || aura === SPELL_AURA_MOD_POSSESS_PET || aura === SPELL_AURA_MOD_CHARM) return true;
    if (aura === SPELL_AURA_CONTROL_VEHICLE && driving) return true;
  }
  return false;
}

/** Whether a spell row puts a vehicle's control on its target: `IsPossessBarVisible` is false for it. */
export function controlsVehicle(row: PossessSpellRow | undefined): boolean {
  return row?.effectAura?.some((aura) => aura === SPELL_AURA_CONTROL_VEHICLE) === true;
}

/**
 * 0x005d62a0 over the character's own auras: the possess spell, 0 when none matches. `pending` is
 * set when a candidate's row is not cached yet — Wow.exe reads its DBC on the spot; this client may
 * have to look again once the row has arrived. (The puppet-summon branch needs SummonProperties.Control,
 * which no route serves; see the file's head.)
 */
export function possessSpellOf(
  auras: readonly ActiveAura[],
  row: (spellId: number) => PossessSpellRow | undefined,
  driving: boolean,
): { readonly spellId: number; readonly pending: boolean } {
  let pending = false;
  for (const aura of auras) {
    if (aura.spellId <= 0 || (aura.flags & AURA_FLAG_NEGATIVE) !== 0) continue;
    const spell = row(aura.spellId);
    if (spell === undefined) {
      pending = true;
      continue;
    }
    if (possessAura(spell, driving)) return { spellId: aura.spellId, pending: false };
  }
  return { spellId: 0, pending };
}

/** 0x0071b630: a hunter's pet — a pet number, and a hunter player as its creator. */
export function isHunterPet(unit: WorldObjectState, object: (guid: bigint) => WorldObjectState | undefined): boolean {
  if ((unit.fields.get(PET_NUMBER) ?? 0) === 0) return false;
  const creator = object(guidFieldOf(unit, CREATED_BY));
  if (creator === undefined || creator.typeId !== TYPEID_PLAYER) return false;
  return (((creator.fields.get(BYTES_0) ?? 0) >>> 8) & 0xff) === CLASS_HUNTER;
}

/**
 * 0x005d35b0 for the bar's unit (in view): it may carry a bar. `stale` is «a possess spell was
 * found for this bar and none is held now» (0x00c234d8 set, 0x00c234e0 empty).
 */
export function possessBarUnitUsable(
  unit: WorldObjectState,
  creatureTypeFlags: number | undefined,
  stale: boolean,
  hunterPet: boolean,
): boolean {
  if (((creatureTypeFlags ?? 0) & CREATURE_TYPE_FLAG_NO_PET_BAR) !== 0) return false;
  if ((unit.fields.get(HEALTH) ?? 0) < 1) return false;
  return !(stale && !hunterPet);
}

/** The bar a `SMSG_PET_SPELLS` left, as far as 0x005d4ad0 reads it. */
export interface PossessBarSource {
  readonly guid: bigint;
  readonly closed: boolean;
  readonly bar: readonly PetActionButton[];
}

/**
 * 0x005d4ad0: the pet bar goes on the main bar — the bar names the far sight unit, it is not a
 * vehicle's (slice F2), and its unit may carry it (`unitUsable`: 0x005d35b0, true when not in view).
 */
export function possessBarOnMainBar(
  farSight: bigint | undefined,
  bar: PossessBarSource | undefined,
  unitUsable: boolean,
): boolean {
  if (farSight === undefined || farSight === 0n || bar === undefined || bar.closed || bar.guid !== farSight) return false;
  return !isVehicleActionBar(bar.bar) && unitUsable;
}

/** The pet bar slot (0-based) an action slot mirrors under the possess bar; -1 for 131–132; undefined off it. */
export function possessMirrorIndex(slot: number): number | undefined {
  if (!Number.isInteger(slot) || slot < POSSESS_FIRST_SLOT || slot >= POSSESS_FIRST_SLOT + POSSESS_PAGE_SLOTS) return undefined;
  const index = slot - POSSESS_FIRST_SLOT;
  return index < POSSESS_MIRRORED_SLOTS ? index : -1;
}

/** `UnitIsPossessed` (0x0060d860): `UNIT_FLAG_POSSESSED` on the unit's flags. */
export function unitPossessed(unit: WorldObjectState | undefined): boolean {
  return unit !== undefined && ((unit.fields.get(FLAGS) ?? 0) & UNIT_FLAG_POSSESSED) !== 0;
}

/** `UnitIsCharmed` (0x0060d7d0): a non-zero `UNIT_FIELD_CHARMEDBY`. */
export function unitCharmed(unit: WorldObjectState | undefined): boolean {
  return unit !== undefined && !fieldEmpty(unit, CHARMED_BY);
}

/**
 * The four words 0x006d1970 watches on the character (`UNIT_FIELD_CHARM`, `UNIT_FIELD_SUMMON`), in
 * `out`, so a poll can compare them without building anything.
 */
export function ownerWordsInto(character: WorldObjectState | undefined, out: number[]): void {
  out[0] = (character?.fields.get(CHARM) ?? 0) >>> 0;
  out[1] = (character?.fields.get(CHARM + 1) ?? 0) >>> 0;
  out[2] = (character?.fields.get(SUMMON) ?? 0) >>> 0;
  out[3] = (character?.fields.get(SUMMON + 1) ?? 0) >>> 0;
}
