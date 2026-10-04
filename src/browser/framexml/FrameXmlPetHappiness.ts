import { readField, unit as unitField } from "../../world/Fields.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * 3.36 (L14): `GetPetHappiness()` and its event, as the 3.3.5a client answers them.
 *
 * Wow.exe's Lua function (0x005d3b00, registered beside its name at .data 0x00ad0cf8) takes the unit
 * the pet bar names, asks 0x0071f390 for row 1 of PetPersonality.dbc and 0x0071f400 for the level,
 * and pushes two numbers: `level + 1` and the row's damage multiplier for that level times 100.
 * 0x0071f390 hands out the row only when the pet has a pet number (UNIT_FIELD_PETNUMBER) and its
 * creator (UNIT_FIELD_CREATEDBY, looked up as a player object) is a hunter; otherwise the function
 * pushes nil and 100 — the second value is still there.
 *
 * The level reads the pet's UNIT_FIELD_POWER5, power type 4 HAPPINESS, as a signed word against the
 * row's thresholds 2 and 3: below the second unhappy, below the third content, else happy. The
 * server agrees: `Pet::GetHappinessState` (Pet.cpp:724-732) with HAPPINESS_LEVEL_SIZE 333000
 * (Pet.h:24), and the 75/100/125 % melee damage of `Guardian::UpdateDamagePhysical`
 * (StatSystem.cpp:2040-2058).
 */

/**
 * PetPersonality.dbc row 1 of the dataset (`HappinessThreshold[3]`, `HappinessDamage[3]`). The
 * gateway serves no copy of this table, and the core does not read it either: it keeps the same
 * numbers as HAPPINESS_LEVEL_SIZE. A module that edits the row would need a route here.
 */
const PET_PERSONALITY_THRESHOLDS: readonly number[] = Object.freeze([0, 333_000, 666_000]);
const PET_PERSONALITY_DAMAGE: readonly number[] = Object.freeze([0.75, 1, 1.25]);

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;
const CLASS_HUNTER = 3;
/** `UNIT_FIELD_POWER1 + POWER_HAPPINESS` (power index 4). */
const HAPPINESS_SLOT = UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 4;

/** `GetPetHappiness()`'s two values: level 1-3 (or nil) and the damage percentage. */
export type FrameXmlPetHappinessAnswer = readonly [happiness: number | undefined, damagePercentage: number];

/** No hunter's pet: nil and the 100.0 Wow.exe pushes from 0x009e9a10. */
export const FRAMEXML_PET_HAPPINESS_NONE: FrameXmlPetHappinessAnswer = Object.freeze([undefined, 100] as const);

/** One frozen answer per level, so the event path allocates nothing (float * 100.0f, as 0x005d3b00). */
const HAPPINESS_ANSWERS: readonly FrameXmlPetHappinessAnswer[] = Object.freeze(PET_PERSONALITY_DAMAGE.map(
  (damage, index) => Object.freeze([index + 1, Math.fround(Math.fround(damage) * 100)] as const),
));

/**
 * The stock event for a change of power slot 4: Wow.exe signals `0x13 + powerIndex` for a unit's
 * power slot (0x00722c50, called by the POWER1..7 field handler 0x007234d0 that 0x00741d00
 * registers), and event 0x17 of the table at 0x00c24eb0 is UNIT_HAPPINESS. PetFrame.lua:23 registers it.
 */
export const FRAMEXML_PET_HAPPINESS_EVENT = "UNIT_HAPPINESS";

/** The happiness level 1-3 of a POWER5 word (0x0071f400 compares it signed). */
export function frameXmlPetHappinessLevel(power: number): number {
  const signed = power | 0;
  let level = 1;
  while (level < PET_PERSONALITY_THRESHOLDS.length && signed >= PET_PERSONALITY_THRESHOLDS[level]!) level += 1;
  return level;
}

/** `GetPetHappiness()` for the pet-bar unit; `objectFor` resolves the creator's guid. */
export function frameXmlPetHappiness(
  pet: WorldObjectState | undefined,
  objectFor: (guid: bigint) => WorldObjectState | undefined,
): FrameXmlPetHappinessAnswer {
  if (!pet || (pet.typeId !== TYPEID_UNIT && pet.typeId !== TYPEID_PLAYER)) return FRAMEXML_PET_HAPPINESS_NONE;
  if ((readField(pet, "UNIT_FIELD_PETNUMBER") ?? 0) === 0) return FRAMEXML_PET_HAPPINESS_NONE;
  const creatorGuid = readField(pet, "UNIT_FIELD_CREATEDBY");
  if (creatorGuid === undefined || creatorGuid === 0n) return FRAMEXML_PET_HAPPINESS_NONE;
  const creator = objectFor(creatorGuid);
  if (creator?.typeId !== TYPEID_PLAYER || unitField.classId(creator) !== CLASS_HUNTER) {
    return FRAMEXML_PET_HAPPINESS_NONE;
  }
  // An unsent word reads as the zeroed descriptor Wow.exe would read.
  return HAPPINESS_ANSWERS[frameXmlPetHappinessLevel(pet.fields.get(HAPPINESS_SLOT) ?? 0) - 1]!;
}

/**
 * Whether the pet's POWER5 word moved since the last look. The seam hears one UNIT_POWER for any
 * of the seven slots, so the word is compared rather than the event trusted; a focus tick of the
 * same pet stays silent. Two scalars, no allocation.
 */
export class FrameXmlPetHappinessWatch {
  #guid: bigint | undefined;
  #word: number | undefined;

  changed(pet: WorldObjectState): boolean {
    const word = pet.fields.get(HAPPINESS_SLOT);
    if (pet.guid === this.#guid && word === this.#word) return false;
    this.#guid = pet.guid;
    this.#word = word;
    return true;
  }

  reset(): void {
    this.#guid = undefined;
    this.#word = undefined;
  }
}
