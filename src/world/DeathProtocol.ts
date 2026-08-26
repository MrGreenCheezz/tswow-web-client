import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: QueryHandler.cpp `HandleCorpseQueryOpcode`,
// MiscPackets.cpp (`CorpseReclaimDelay`, `DeathReleaseLoc`, `PreRessurect`, `ReclaimCorpse`,
// `RepopRequest`, `ResurrectResponse`) and Spell.cpp `SendResurrectRequest`.

export interface CorpseLocation {
  found: boolean;
  /** Map the corpse is on, or the entrance map when it lies inside an instance. */
  mapId: number;
  x: number;
  y: number;
  z: number;
  /** The instance map itself when it differs from `mapId`. */
  corpseMapId: number;
}

export function parseCorpseQuery(payload: Uint8Array): CorpseLocation {
  const reader = new PacketReader(payload);
  const found = reader.u8() !== 0;
  if (!found) {
    reader.assertFinished();
    return { found, mapId: -1, x: 0, y: 0, z: 0, corpseMapId: -1 };
  }
  const mapId = reader.i32();
  const x = reader.f32();
  const y = reader.f32();
  const z = reader.f32();
  const corpseMapId = reader.i32();
  reader.u32();
  reader.assertFinished();
  return { found, mapId, x, y, z, corpseMapId };
}

export interface ResurrectRequest {
  casterGuid: bigint;
  casterName: string;
  /** A spirit healer revive applies resurrection sickness. */
  sickness: boolean;
  /** False for spells that ignore the corpse reclaim timer. */
  useTimer: boolean;
}

export function parseResurrectRequest(payload: Uint8Array): ResurrectRequest {
  const reader = new PacketReader(payload);
  const casterGuid = reader.u64();
  // The length counts the terminator, and the string that follows carries it.
  reader.u32();
  const casterName = reader.cString();
  const sickness = reader.u8() !== 0;
  const useTimer = reader.u8() !== 0;
  reader.assertFinished();
  return { casterGuid, casterName, sickness, useTimer };
}

/** Milliseconds left before the corpse can be reclaimed without resurrection sickness. */
export function parseCorpseReclaimDelay(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const remaining = reader.u32();
  reader.assertFinished();
  return remaining;
}

export interface DeathReleaseLocation {
  mapId: number;
  x: number;
  y: number;
  z: number;
}

export function parseDeathReleaseLoc(payload: Uint8Array): DeathReleaseLocation {
  const reader = new PacketReader(payload);
  const mapId = reader.i32();
  const x = reader.f32();
  const y = reader.f32();
  const z = reader.f32();
  reader.assertFinished();
  return { mapId, x, y, z };
}

/** `SMSG_PRE_RESURRECT` carries a packed GUID, unlike the other resurrection packets. */
export function parsePreResurrect(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  reader.assertFinished();
  return guid;
}

/** Releases the spirit. `checkInstance` is the client's own "am I in an instance" hint. */
export function buildRepopRequest(checkInstance = false): Uint8Array {
  return new PacketWriter().u8(checkInstance ? 1 : 0).toUint8Array();
}

/** `MSG_CORPSE_QUERY` is sent with an empty body; the server answers on the same opcode. */
export function buildCorpseQuery(): Uint8Array {
  return new Uint8Array(0);
}

export function buildReclaimCorpse(corpseGuid: bigint): Uint8Array {
  return new PacketWriter().u64(corpseGuid).toUint8Array();
}

export function buildResurrectResponse(resurrecterGuid: bigint, accept: boolean): Uint8Array {
  return new PacketWriter().u64(resurrecterGuid).u8(accept ? 1 : 0).toUint8Array();
}

export function buildSpiritHealerActivate(healerGuid: bigint): Uint8Array {
  return new PacketWriter().u64(healerGuid).toUint8Array();
}

// The rest of the death cycle, from slice P4: the spirit healers that stand in battlegrounds and
// graveyards, and the two packets a corpse answers with.

/**
 * `SMSG_AREA_SPIRIT_HEALER_TIME`: `u64 healer, u32 milliseconds`.
 *
 * A battleground spirit healer resurrects everyone waiting on a thirty-second cycle rather than
 * on request, and this is the countdown to the next one. Sent again every time it comes round, so
 * the client runs it down itself between packets rather than asking.
 */
export function parseAreaSpiritHealerTime(payload: Uint8Array): { guid: bigint; milliseconds: number } {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  const milliseconds = reader.u32();
  reader.assertFinished();
  return { guid, milliseconds };
}

/**
 * `SMSG_SPIRIT_HEALER_CONFIRM`: the healer asking whether the player really wants to come back
 * here and now, with the sickness that follows.
 *
 * The guid has to round-trip byte for byte: `HandleSpiritHealerActivateOpcode`
 * (`NPCHandler.cpp:238`) re-validates it against the healers the player can interact with and
 * silently drops anything else.
 */
export function parseSpiritHealerConfirm(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}

/** `CMSG_AREA_SPIRIT_HEALER_QUERY` and `CMSG_AREA_SPIRIT_HEALER_QUEUE`: which healer, by full guid. */
export function buildAreaSpiritHealerRequest(healerGuid: bigint): Uint8Array {
  return new PacketWriter().u64(healerGuid).toUint8Array();
}

/**
 * `SMSG_CORPSE_MAP_POSITION_QUERY_RESPONSE`: `f32 x, y, z, unk`, and no guid at all.
 *
 * Where the corpse is on the *world* map, for a corpse left inside an instance: the entrance,
 * rather than the position inside. `MSG_CORPSE_QUERY` answers the other question — where it is on
 * the map it actually lies on.
 */
export function parseCorpseMapPosition(payload: Uint8Array): { x: number; y: number; z: number } {
  const reader = new PacketReader(payload);
  return { x: reader.f32(), y: reader.f32(), z: reader.f32() };
}

/** `CMSG_CORPSE_MAP_POSITION_QUERY`: the corpse's own guid, as a full eight bytes. */
export function buildCorpseMapPositionQuery(corpseGuid: bigint): Uint8Array {
  return new PacketWriter().u64(corpseGuid).toUint8Array();
}
