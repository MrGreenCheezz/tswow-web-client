import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: PetitionsHandler.cpp — `SendPetitionQueryOpcode`,
// `SendPetitionShowList`, `SendPetitionSigns`, `HandleSignPetition`, `HandleTurnInPetitionOpcode`,
// `HandleDeclinePetition` and `HandlePetitionRenameGuild`.
//
// Every guid in this family is a bare eight bytes.

/**
 * `CharterTypes` in SharedDefines.h. The arena values are the team size, and the signature count
 * the server demands is that value minus one — so a 5v5 charter needs four signatures, not five.
 */
export const GUILD_CHARTER_TYPE = 9;
export const ARENA_CHARTER_2V2 = 2;
export const ARENA_CHARTER_3V3 = 3;
export const ARENA_CHARTER_5V5 = 5;

/** `PetitionSigns` in PetitionMgr.h. Only the first two ever reach the wire. */
export const PETITION_SIGN_OK = 0;
export const PETITION_SIGN_ALREADY_SIGNED = 1;

/** `PetitionTurns` in PetitionMgr.h. There is no 1 and no 3. */
export const PETITION_TURN_OK = 0;
export const PETITION_TURN_ALREADY_IN_GUILD = 2;
export const PETITION_TURN_NEED_MORE_SIGNATURES = 4;

export interface PetitionInfo {
  /** The low half of the charter item's guid, which the core reuses as the guild or team id. */
  petitionId: number;
  ownerGuid: bigint;
  name: string;
  /** Signatures needed. For an arena charter this is the type minus one: 1, 2 or 4. */
  minSignatures: number;
  /** The core writes the same number here as above, in both branches. */
  maxSignatures: number;
  /** Zero for a guild charter, the charter type for an arena one. */
  index: number;
  arena: boolean;
}

/**
 * Twenty-seven fields, of which twenty are written as zeros the client still expects: an empty
 * string right after the name, four spare words, a two-byte word among the four-byte ones, three
 * more words, ten more empty strings and a final spare. The narrow field in the middle is the
 * trap — read as four bytes it drags everything after it out of place, and every value involved is
 * a plausible number either way.
 *
 * The arena charter changes no field's position or size, only four values.
 */
export function parsePetitionQueryResponse(payload: Uint8Array): PetitionInfo {
  const reader = new PacketReader(payload);
  const petitionId = reader.u32();
  const ownerGuid = reader.u64();
  const name = reader.cString();
  // An empty string written as a bare terminator, before the counters.
  reader.cString();
  const minSignatures = reader.u32();
  const maxSignatures = reader.u32();
  const index = reader.u32();
  for (let spare = 0; spare < 4; spare++) reader.u32();
  reader.u16();
  for (let spare = 0; spare < 3; spare++) reader.u32();
  for (let unused = 0; unused < 10; unused++) reader.cString();
  reader.u32();
  const arena = reader.u32() !== 0;
  reader.assertFinished();
  return { petitionId, ownerGuid, name, minSignatures, maxSignatures, index, arena };
}

export interface PetitionOffer {
  /** The index the client echoes back when buying: 1 is a guild charter or 2v2, 2 is 3v3, 3 is 5v5. */
  index: number;
  itemId: number;
  displayId: number;
  /** Copper. */
  cost: number;
  /** The arena rows put the team size here; the guild row writes zero. */
  teamSize: number;
  requiredSignatures: number;
}

export interface PetitionVendor {
  vendorGuid: bigint;
  offers: PetitionOffer[];
}

/**
 * One offer from a tabard designer, three from an arena charter vendor. The count is written up
 * front and is honest, so the rows can be read straight off it.
 */
export function parsePetitionShowList(payload: Uint8Array): PetitionVendor {
  const reader = new PacketReader(payload);
  const vendorGuid = reader.u64();
  const count = reader.u8();
  if (count > 8) throw new RangeError(`Charter vendor declares ${count} offers`);
  const offers: PetitionOffer[] = [];
  for (let index = 0; index < count; index++) {
    offers.push({
      index: reader.u32(),
      itemId: reader.u32(),
      displayId: reader.u32(),
      cost: reader.u32(),
      teamSize: reader.u32(),
      requiredSignatures: reader.u32(),
    });
  }
  reader.assertFinished();
  return { vendorGuid, offers };
}

export interface PetitionSignatures {
  petitionGuid: bigint;
  ownerGuid: bigint;
  /** The same low half already carried whole by the guid above; the client wants both. */
  petitionId: number;
  signers: bigint[];
}

/**
 * The account behind each signature is deliberately left out — the server enforces one signature
 * per account itself, and the wire carries only characters.
 */
export function parsePetitionSignatures(payload: Uint8Array): PetitionSignatures {
  const reader = new PacketReader(payload);
  const petitionGuid = reader.u64();
  const ownerGuid = reader.u64();
  const petitionId = reader.u32();
  const count = reader.u8();
  const signers: bigint[] = [];
  for (let index = 0; index < count; index++) {
    signers.push(reader.u64());
    reader.u32();
  }
  reader.assertFinished();
  return { petitionGuid, ownerGuid, petitionId, signers };
}

export interface PetitionSignResult {
  petitionGuid: bigint;
  /** Whoever signed. The charter's owner gets this packet too, naming somebody else. */
  signerGuid: bigint;
  result: number;
}

export function parsePetitionSignResult(payload: Uint8Array): PetitionSignResult {
  const reader = new PacketReader(payload);
  const petitionGuid = reader.u64();
  const signerGuid = reader.u64();
  const result = reader.u32();
  reader.assertFinished();
  return { petitionGuid, signerGuid, result };
}

export function parseTurnInPetitionResult(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const result = reader.u32();
  reader.assertFinished();
  return result;
}

/**
 * The refusal names the player who refused, not the charter they refused. The client sent a
 * petition guid; what comes back is somebody's player guid, and only the owner receives it.
 */
export function parsePetitionDecline(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}

export interface PetitionRenamed {
  petitionGuid: bigint;
  /**
   * The core escapes the name for SQL before building this packet, so a name with a quote or a
   * backslash comes back with the escape characters still in it.
   */
  name: string;
}

export function parsePetitionRenamed(payload: Uint8Array): PetitionRenamed {
  const reader = new PacketReader(payload);
  const petitionGuid = reader.u64();
  const name = reader.cString();
  reader.assertFinished();
  return { petitionGuid, name };
}

/** The low half of the charter guid is sent first, then the whole guid. */
export function buildPetitionQuery(petitionGuid: bigint): Uint8Array {
  return new PacketWriter()
    .u32(Number(petitionGuid & 0xffffffffn))
    .u64(petitionGuid)
    .toUint8Array();
}

export function buildPetitionShowList(vendorGuid: bigint): Uint8Array {
  return new PacketWriter().u64(vendorGuid).toUint8Array();
}

export function buildPetitionShowSignatures(petitionGuid: bigint): Uint8Array {
  return new PacketWriter().u64(petitionGuid).toUint8Array();
}

/** The trailing byte is read and never used. */
export function buildPetitionSign(petitionGuid: bigint): Uint8Array {
  return new PacketWriter().u64(petitionGuid).u8(0).toUint8Array();
}

export function buildPetitionDecline(petitionGuid: bigint): Uint8Array {
  return new PacketWriter().u64(petitionGuid).toUint8Array();
}

export function buildPetitionRename(petitionGuid: bigint, name: string): Uint8Array {
  return new PacketWriter().u64(petitionGuid).cString(name).toUint8Array();
}

/**
 * An arena charter turn-in carries the emblem after the guid, and the server reads it *after* it
 * has already destroyed the charter item. Leaving the block off does not cancel the turn-in — it
 * loses the charter and then throws on the server, so it is always written for an arena charter.
 */
export function buildTurnInPetition(petitionGuid: bigint, emblem?: {
  background: number; icon: number; iconColor: number; border: number; borderColor: number;
}): Uint8Array {
  const writer = new PacketWriter().u64(petitionGuid);
  if (!emblem) return writer.toUint8Array();
  return writer
    .u32(emblem.background)
    .u32(emblem.icon)
    .u32(emblem.iconColor)
    .u32(emblem.border)
    .u32(emblem.borderColor)
    .toUint8Array();
}

export function petitionSignText(result: number): string {
  if (result === PETITION_SIGN_OK) return "Подпись принята";
  if (result === PETITION_SIGN_ALREADY_SIGNED) return "Вы уже подписали эту хартию";
  return `Хартия: код ${result}`;
}

export function petitionTurnInText(result: number): string {
  switch (result) {
    case PETITION_TURN_OK: return "Хартия принята";
    case PETITION_TURN_ALREADY_IN_GUILD: return "Вы уже состоите в гильдии";
    case PETITION_TURN_NEED_MORE_SIGNATURES: return "Не хватает подписей";
    default: return `Хартия: код ${result}`;
  }
}
