import { readField, unit as unitField } from "../../world/Fields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * L15 5.05: `HasPetUI()` as the 3.3.5a client answers it — Wow.exe 12340, Ghidra read-only
 * (.runtime/re-2026-10-04/l14-small/g1.c 0x005d3960, g2.c 0x0071b630; the Lua name sits beside the
 * function at .data 0x00ad0ce8).
 *
 * 0x005d3960 looks the pet of the pet bar up (the guid SMSG_PET_SPELLS named, `petSpells.guid`) as a
 * unit. When it is in view, is not a player, and carries a pet number (UNIT_FIELD_PETNUMBER ≠ 0), the
 * first value is 1; otherwise both values are nil — a charmed creature, a vehicle and a possessed
 * unit have no pet number, so they get no pet page. The second value is 0x0071b630: the pet number
 * again, and the creator (UNIT_FIELD_CREATEDBY, looked up as a player object) is a hunter (class 3).
 * Not the UNIT_PET_FLAG_CAN_BE_ABANDONED byte the stable reads: a warlock's demon has a pet number
 * and no hunter behind it.
 */

/** `[hasPetUI, isHunterPet]`, frozen, so asking allocates nothing. */
export type FrameXmlHasPetUIAnswer = readonly [hasPetUI: boolean, isHunterPet: boolean];

const NO_PET_UI: FrameXmlHasPetUIAnswer = Object.freeze([false, false] as const);
const PET_UI: FrameXmlHasPetUIAnswer = Object.freeze([true, false] as const);
const HUNTER_PET_UI: FrameXmlHasPetUIAnswer = Object.freeze([true, true] as const);

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;
const CLASS_HUNTER = 3;

/** 0x0071b630: a pet number, and a hunter as its creator (`objectFor` resolves the creator's guid). */
export function frameXmlIsHunterPet(
  pet: WorldObjectState | undefined,
  objectFor: (guid: bigint) => WorldObjectState | undefined,
): boolean {
  if (!pet || (readField(pet, "UNIT_FIELD_PETNUMBER") ?? 0) === 0) return false;
  const creatorGuid = readField(pet, "UNIT_FIELD_CREATEDBY");
  if (creatorGuid === undefined || creatorGuid === 0n) return false;
  const creator = objectFor(creatorGuid);
  return creator?.typeId === TYPEID_PLAYER && unitField.classId(creator) === CLASS_HUNTER;
}

/** 0x005d3960 for the pet-bar unit (undefined when SMSG_PET_SPELLS named none or it is not in view). */
export function frameXmlHasPetUI(
  pet: WorldObjectState | undefined,
  objectFor: (guid: bigint) => WorldObjectState | undefined,
): FrameXmlHasPetUIAnswer {
  if (!pet || pet.typeId !== TYPEID_UNIT || (readField(pet, "UNIT_FIELD_PETNUMBER") ?? 0) === 0) return NO_PET_UI;
  return frameXmlIsHunterPet(pet, objectFor) ? HUNTER_PET_UI : PET_UI;
}
