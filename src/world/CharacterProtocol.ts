import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

export interface CharacterEquipment {
  displayId: number;
  inventoryType: number;
  enchantVisual: number;
}

export interface CharacterSummary {
  guid: bigint;
  name: string;
  race: number;
  classId: number;
  gender: number;
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialHair: number;
  level: number;
  zone: number;
  map: number;
  x: number;
  y: number;
  z: number;
  guildId: number;
  flags: number;
  customizeFlags: number;
  firstLogin: boolean;
  petDisplayId: number;
  petLevel: number;
  petFamily: number;
  equipment: CharacterEquipment[];
}

export interface CreateCharacterRequest {
  name: string;
  race: number;
  classId: number;
  gender: number;
  skin?: number;
  face?: number;
  hairStyle?: number;
  hairColor?: number;
  facialHair?: number;
  outfitId?: number;
}

export interface LoginLocation {
  map: number;
  x: number;
  y: number;
  z: number;
  orientation: number;
}

export function parseCharacterList(payload: Uint8Array): CharacterSummary[] {
  const reader = new PacketReader(payload);
  const count = reader.u8();
  if (count > 10) throw new RangeError(`Invalid character count ${count}`);
  const characters: CharacterSummary[] = [];

  for (let characterIndex = 0; characterIndex < count; characterIndex++) {
    const character: CharacterSummary = {
      guid: reader.u64(),
      name: reader.cString(),
      race: reader.u8(),
      classId: reader.u8(),
      gender: reader.u8(),
      skin: reader.u8(),
      face: reader.u8(),
      hairStyle: reader.u8(),
      hairColor: reader.u8(),
      facialHair: reader.u8(),
      level: reader.u8(),
      zone: reader.u32(),
      map: reader.u32(),
      x: reader.f32(),
      y: reader.f32(),
      z: reader.f32(),
      guildId: reader.u32(),
      flags: reader.u32(),
      customizeFlags: reader.u32(),
      firstLogin: reader.u8() !== 0,
      petDisplayId: reader.u32(),
      petLevel: reader.u32(),
      petFamily: reader.u32(),
      equipment: [],
    };
    for (let slot = 0; slot < 23; slot++) {
      character.equipment.push({
        displayId: reader.u32(),
        inventoryType: reader.u8(),
        enchantVisual: reader.u32(),
      });
    }
    characters.push(character);
  }
  reader.assertFinished();
  return characters;
}

export function buildCreateCharacter(request: CreateCharacterRequest): Uint8Array {
  return new PacketWriter()
    .cString(request.name)
    .u8(request.race)
    .u8(request.classId)
    .u8(request.gender)
    .u8(request.skin ?? 0)
    .u8(request.face ?? 0)
    .u8(request.hairStyle ?? 0)
    .u8(request.hairColor ?? 0)
    .u8(request.facialHair ?? 0)
    .u8(request.outfitId ?? 0)
    .toUint8Array();
}

export function buildCharacterGuid(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

export function parseCharacterResult(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const result = reader.u8();
  reader.assertFinished();
  return result;
}

/**
 * The realm refused the session: the `ResponseCodes` value its SMSG_AUTH_RESPONSE carried in place of
 * AUTH_OK or AUTH_WAIT_QUEUE (AUTH_REJECT, AUTH_BANNED, AUTH_UNKNOWN_ACCOUNT… — WorldSocket.cpp),
 * `undefined` when the packet was empty.
 */
export class WorldAuthError extends Error {
  readonly code: number | undefined;

  constructor(code: number | undefined) {
    super(`World authentication failed with code ${code ?? "missing"}`);
    this.name = "WorldAuthError";
    this.code = code;
  }
}

/**
 * `CHARACTER_FLAG_RENAME` (Player.cpp:161): the core lists a character with `AT_LOGIN_RENAME` with
 * this bit (Player.cpp:1545-1546) and refuses to load it into the world until it has a new name
 * (Player.cpp:18123-18127), so the login would only end in a kick.
 */
export const CHARACTER_FLAG_RENAME = 0x00004000;

/** `RESPONSE_SUCCESS`: what SMSG_CHAR_RENAME (and the other paid services) answer when they worked. */
export const RESPONSE_SUCCESS = 0;

export function characterNeedsRename(character: Pick<CharacterSummary, "flags">): boolean {
  return (character.flags & CHARACTER_FLAG_RENAME) !== 0;
}

/** SMSG_CHAR_RENAME: the result, and on success the character and the name the core normalised. */
export interface RenameResult {
  result: number;
  guid?: bigint;
  name?: string;
}

/** CMSG_CHAR_RENAME: `ObjectGuid >> Name` (CharacterHandler.cpp:1137-1142) — a full u64, not packed. */
export function buildRenameCharacter(guid: bigint, name: string): Uint8Array {
  return new PacketWriter().u64(guid).cString(name).toUint8Array();
}

/** `SendCharRename` (CharacterHandler.cpp:2206-2216): `u8 result`, then guid and name on success only. */
export function parseRenameResult(payload: Uint8Array): RenameResult {
  const reader = new PacketReader(payload);
  const result = reader.u8();
  if (result !== RESPONSE_SUCCESS) {
    reader.assertFinished();
    return { result };
  }
  const renamed = { result, guid: reader.u64(), name: reader.cString() };
  reader.assertFinished();
  return renamed;
}

/** `DeclinedNameResult::DECLINED_NAMES_RESULT_SUCCESS`. */
export const DECLINED_NAMES_RESULT_SUCCESS = 0;

/**
 * CMSG_SET_PLAYER_DECLINED_NAMES (0x419): `u64 guid`, the character's name, then the five cases
 * (`HandleSetPlayerDeclinedNames`, CharacterHandler.cpp:1224-1276; the client's own sender,
 * Wow.exe 0x4d9a40, writes the same guid, name and five strings).
 */
export function buildDeclinedNames(guid: bigint, name: string, cases: readonly string[]): Uint8Array {
  if (cases.length !== 5) throw new Error(`declined names need five cases, got ${cases.length}`);
  const writer = new PacketWriter().u64(guid).cString(name);
  for (const form of cases) writer.cString(form);
  return writer.toUint8Array();
}

/* The answer, SMSG_SET_PLAYER_DECLINED_NAMES_RESULT, is `SessionProtocol.parseDeclinedNamesResult`. */

export function parseLoginVerifyWorld(payload: Uint8Array): LoginLocation {
  const reader = new PacketReader(payload);
  const location = {
    map: reader.u32(),
    x: reader.f32(),
    y: reader.f32(),
    z: reader.f32(),
    orientation: reader.f32(),
  };
  reader.assertFinished();
  return location;
}
