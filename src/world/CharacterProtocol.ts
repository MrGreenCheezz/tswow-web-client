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
