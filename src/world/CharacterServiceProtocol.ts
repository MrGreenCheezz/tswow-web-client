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
  /** `Gender` on the wire: 0 male, 1 female (SharedDefines.h `GENDER_MALE`/`GENDER_FEMALE`). */
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
 *
 * The six look bytes are read in the order TrinityCore writes them (gender, skin, face, hairStyle,
 * hairColor, facialHair — CharacterHandler.cpp:2218-2253). Wow.exe 12340 reads them in the request's
 * order instead (0x4d9190/0x4d92d0 → 0x4e29e0: gender, skin, hairColor, hairStyle, facialHair, face),
 * so against this core the original stores a swapped look until the next SMSG_CHAR_ENUM — which
 * `CharacterSelect_OnShow` asks for at once. This client keeps the core's meaning.
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

/**
 * `CharacterCustomizeFlags` (Player.cpp:181-187): the one value SMSG_CHAR_ENUM carries per character
 * for the paid services — the core sends exactly one of them, customise first, then faction, then race
 * (Player.cpp:1560-1567), from the `AT_LOGIN_CUSTOMIZE` (0x8), `AT_LOGIN_CHANGE_FACTION` (0x40) and
 * `AT_LOGIN_CHANGE_RACE` (0x80) bits of the database row (Player.h:486-490).
 */
export const CHAR_CUSTOMIZE_FLAG_CUSTOMIZE = 0x00000001;
export const CHAR_CUSTOMIZE_FLAG_FACTION = 0x00010000;
export const CHAR_CUSTOMIZE_FLAG_RACE = 0x00100000;

/** Which paid service a character's list entry offers. */
export type PaidServiceKind = "customize" | "faction" | "race";

/**
 * The packet the client's CreateCharacter sends for a character loaded into the creation screen by
 * CustomizeExistingCharacter (Wow.exe 0x4e0380): the race bit wins, then the faction bit, and anything
 * else — the customise bit, or no bit at all — is a customisation. Since the core sends only one bit
 * the order matters only to a list that carries two.
 */
export function paidServiceKind(customizeFlags: number): PaidServiceKind {
  if ((customizeFlags & CHAR_CUSTOMIZE_FLAG_RACE) !== 0) return "race";
  if ((customizeFlags & CHAR_CUSTOMIZE_FLAG_FACTION) !== 0) return "faction";
  return "customize";
}

/** What a paid service sends: the character, the name it is to have and the look it is to wear. */
export interface CharacterServiceRequest {
  guid: bigint;
  name: string;
  /** 0 male, 1 female. */
  gender: number;
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialHair: number;
}

function writeServiceBody(request: CharacterServiceRequest): PacketWriter {
  // HandleCharCustomize (CharacterHandler.cpp:1393-1409) and HandleCharFactionOrRaceChange
  // (:1645-1663) read guid, name, gender, skin, hairColor, hairStyle, facialHair, face — not
  // CMSG_CHAR_CREATE's skin, face, hairStyle, hairColor, facialHair. Wow.exe's senders (0x4d8e10,
  // 0x4d8f20, 0x4d9040) write the same order.
  return new PacketWriter()
    .u64(request.guid)
    .cString(request.name)
    .u8(request.gender)
    .u8(request.skin)
    .u8(request.hairColor)
    .u8(request.hairStyle)
    .u8(request.facialHair)
    .u8(request.face);
}

/** CMSG_CHAR_CUSTOMIZE (0x473). */
export function buildCustomizeCharacter(request: CharacterServiceRequest): Uint8Array {
  return writeServiceBody(request).toUint8Array();
}

/**
 * CMSG_CHAR_FACTION_CHANGE (0x4D9) and CMSG_CHAR_RACE_CHANGE (0x4F8): one body, the customisation's
 * plus the new race's **id** (`ChrRaces`), not a button number. The opcode alone tells the core which
 * of the two it is (CharacterHandler.cpp:1665).
 */
export function buildFactionOrRaceChange(request: CharacterServiceRequest & { race: number }): Uint8Array {
  return writeServiceBody(request).u8(request.race).toUint8Array();
}
