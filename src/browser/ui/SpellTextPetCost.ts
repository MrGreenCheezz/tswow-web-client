import { POWER, readField, readSlot } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { game } from "../game/Context.js";
import { npcManaCostScalerClient } from "../NpcManaCostScalerClient.js";
import type { SpellDescriptionContext } from "./SpellText.js";
import type { SpellTextCaster, SpellTextCasterRecord } from "./SpellTextCaster.js";
import type { SpellCostUnit } from "./SpellTextCost.js";
import { sessionSpellDescriptionContext } from "./SpellTextLiveContext.js";

/**
 * 3.43 (15.11): the pet as the unit of Wow.exe's cost function (0x008012f0, SpellTextCost.ts) and cast time
 * (0x007ff180, SpellCastTimeRange.ts) — what the tooltip of a pet-bar spell hands them: GameTooltip:SetPetAction
 * (0x00625470) calls the spell tooltip 0x006238a0 with its pet argument set, and 0x006238a0 then takes the unit of
 * 0x005d3390(0), the pet the bar belongs to (Ghidra 2026-11-15, .runtime/re-2026-11-15/spell7/s5.c). A mind-controlled
 * creature is such a pet, and its spells are the ones step 6 (gtNPCManaCostScaler) scales.
 *
 * * The level for the spell (vtable +0x13c over 5) of a unit that is not the active player is 0x0071aa70:
 *   UNIT_FIELD_LEVEL × 5, capped at MaxLevel × 5 when MaxLevel is above 0, not below 0 (spell7/s1.c).
 * * The spell modifiers stay the active player's: 0x007fd970 reads the player's own lists and family, whoever the unit.
 * * 0x0071b770's base power is the unit's UNIT_FIELD_BASE_MANA for mana, as for the player.
 */

/** 0x0071aa70 over 5: a non-player unit's level for a spell. */
export function spellTextUnitSpellLevel(unit: WorldObjectState, record: SpellTextCasterRecord): number {
  let level = (readField(unit, "UNIT_FIELD_LEVEL") ?? 0) * 5;
  const maxLevel = record.maxLevel ?? 0;
  if (maxLevel > 0 && maxLevel * 5 <= level) level = maxLevel * 5;
  return Math.trunc(Math.max(0, level) / 5);
}

/** `pet` as the cost function's unit; the player's context supplies the rows and the spell modifiers. */
export function spellTextPetCostUnit(pet: WorldObjectState, context: SpellDescriptionContext,
  scaler: readonly number[] | undefined): SpellCostUnit {
  const caster: SpellTextCaster = {
    level: (record) => spellTextUnitSpellLevel(pet, record),
    family: context.caster?.family,
    ...(context.caster?.modifiers ? { modifiers: context.caster.modifiers } : {}),
  };
  return {
    player: {
      slot: (index) => readSlot(pet, index),
      basePower: (powerType) => powerType === POWER.mana ? readField(pet, "UNIT_FIELD_BASE_MANA") : undefined,
    },
    caster,
    isPlayer: pet.typeId === 4,
    isActivePlayer: false,
    row: (id) => context.spells?.get(id) ?? (context.answered && !context.answered(id) ? "pending" : undefined),
    npcCostScaler: scaler ? (row) => row >= 0 && row < scaler.length ? scaler[row] : undefined : undefined,
  };
}

/** This session's pet-bar unit (SMSG_PET_SPELLS' guid) as the cost function's unit, or undefined without one. */
export function sessionPetCostUnit(): SpellCostUnit | undefined {
  const world = game.world;
  const guid = world?.petSpells?.guid;
  const pet = guid !== undefined && guid !== 0n ? world?.state.objects.get(guid) : undefined;
  return pet ? sessionCostUnitOf(pet) : undefined;
}

/** 3.43 (15.11, follow-up): a given pet-list unit as the cost function's unit, with this session's rows and table. */
export function sessionCostUnitOf(pet: WorldObjectState): SpellCostUnit {
  return spellTextPetCostUnit(pet, sessionSpellDescriptionContext(), npcManaCostScalerClient(game.gatewayOrigin)?.table());
}
