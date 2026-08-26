import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: CharacterHandler.cpp (`SendCharRename`,
// `SendCharCustomize`, `SendCharFactionChange`, `HandleAlterAppearance`) and WorldSession.cpp
// `SendBarberShopResult`.

/** `BarberShopResult` in WorldSession.h. Codes 1 and 3 are both "not enough money". */
export const BARBER_SHOP_RESULT_SUCCESS = 0;
export const BARBER_SHOP_RESULT_NO_MONEY = 1;
export const BARBER_SHOP_RESULT_NOT_ON_CHAIR = 2;
export const BARBER_SHOP_RESULT_NO_MONEY_2 = 3;

/** `ResponseCodes::RESPONSE_SUCCESS`. Anything else leaves the rest of the packet unwritten. */
export const RESPONSE_SUCCESS = 0;

/** The result of paying for a haircut. */
export function parseBarberShopResult(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const result = reader.u32();
  reader.assertFinished();
  return result;
}

const BARBER_RESULTS: Record<number, string> = {
  0: "Готово",
  1: "Не хватает денег",
  2: "Нужно сесть в кресло",
  3: "Не хватает денег",
};

export function barberShopResultText(result: number): string {
  return BARBER_RESULTS[result] ?? `Парикмахер: код ${result}`;
}

export interface CharacterAppearance {
  /** 0 female, 1 male — as the wire numbers them, which is not how the update fields do. */
  gender: number;
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialHair: number;
  /** Only a faction change carries this; a customise leaves it undefined. */
  race?: number;
}

export interface CharacterServiceResult {
  /** `RESPONSE_SUCCESS` is 0; every other code means the packet stops right after it. */
  result: number;
  guid: bigint;
  name: string;
  appearance: CharacterAppearance | undefined;
}

/**
 * The answer to a rename, a customise or a faction change.
 *
 * Three opcodes, one shape, and each carries a little more than the last: a rename stops at the
 * name, a customise adds six appearance bytes, a faction change adds a seventh for the new race.
 * A failure is a single byte — the guid and the name are written only on success — so a reader
 * that always expects a guid reads the packet after this one on every rejected name.
 */
export function parseCharacterServiceResult(payload: Uint8Array, kind: "rename" | "customize" | "factionChange"): CharacterServiceResult {
  const reader = new PacketReader(payload);
  const result = reader.u8();
  if (result !== RESPONSE_SUCCESS) {
    reader.assertFinished();
    return { result, guid: 0n, name: "", appearance: undefined };
  }

  const guid = reader.u64();
  const name = reader.cString();
  if (kind === "rename") {
    reader.assertFinished();
    return { result, guid, name, appearance: undefined };
  }

  const appearance: CharacterAppearance = {
    gender: reader.u8(),
    skin: reader.u8(),
    face: reader.u8(),
    hairStyle: reader.u8(),
    hairColor: reader.u8(),
    facialHair: reader.u8(),
  };
  if (kind === "factionChange") appearance.race = reader.u8();
  reader.assertFinished();
  return { result, guid, name, appearance };
}

/**
 * Sitting down for a haircut.
 *
 * The three style numbers are **`BarberShopStyle.dbc` row ids**, not the hair, facial-hair and skin
 * values themselves — the server looks each row up, checks its type, race and sex, and only then
 * takes the `Data` column out of it. The colour, alone among the four, is the raw value.
 *
 * A skin-colour row of zero is legal and means "leave the skin alone": the server treats a lookup
 * miss there as no change, where a miss on either of the other two aborts the whole thing in
 * silence, with no result packet at all.
 */
export function buildAlterAppearance(hairStyleId: number, hairColor: number, facialHairId: number, skinColorId = 0): Uint8Array {
  return new PacketWriter().u32(hairStyleId).u32(hairColor).u32(facialHairId).u32(skinColorId).toUint8Array();
}
