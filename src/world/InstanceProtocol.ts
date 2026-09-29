// Instances: which difficulty is running, what the player is locked to, and what a reset means.
//
// Fourteen opcodes, none of which has a packet class in the core — every one is built inline with
// `WorldPacket data(OPCODE, size); data << ...`, and that size is a buffer reserve that is wrong
// in two places: `SMSG_INSTANCE_RESET_FAILED` declares four bytes and writes eight
// (`Player.cpp:20982`), `SMSG_RAID_INSTANCE_MESSAGE` declares sixteen and writes eighteen in the
// case it is usually sent in. Nothing here sizes anything from a constructor argument.
//
// Only one packet in the family carries a guid at all, and the reason to say so is that this core
// streams a bare `ObjectGuid` as a **full** eight bytes (`ObjectGuid.cpp:146`) and only
// `GetPackGUID()` packs. The rule is the opposite of what the packed-guid habit suggests, and it
// is worth stating once per family rather than discovering it per packet.

import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

/** `Difficulty`, `DBCEnums.h`: the four a 3.3.5 instance can run at. */
export const DIFFICULTY_NORMAL = 0;
export const DIFFICULTY_HEROIC = 1;
export const DIFFICULTY_10_MAN_HEROIC = 2;
export const DIFFICULTY_25_MAN_HEROIC = 3;

/**
 * `InstanceResetWarningType`, `Player.h:656-663`.
 *
 * There is no type named `RaidInstanceMessage` in the core, which is worth writing down because
 * the obvious guess for the enum's name is wrong and it is the value 4 that changes the layout.
 */
export const RAID_INSTANCE_WARNING_HOURS = 1;
export const RAID_INSTANCE_WARNING_MIN = 2;
export const RAID_INSTANCE_WARNING_MIN_SOON = 3;
export const RAID_INSTANCE_WELCOME = 4;
export const RAID_INSTANCE_EXPIRED = 5;

/** `EncounterFrameType`, `InstanceScript.h:66-76`. The tail of the packet depends on it. */
export const ENCOUNTER_FRAME_ENGAGE = 0;
export const ENCOUNTER_FRAME_DISENGAGE = 1;
export const ENCOUNTER_FRAME_UPDATE_PRIORITY = 2;
export const ENCOUNTER_FRAME_ADD_TIMER = 3;
export const ENCOUNTER_FRAME_ENABLE_OBJECTIVE = 4;
export const ENCOUNTER_FRAME_UPDATE_OBJECTIVE = 5;
export const ENCOUNTER_FRAME_DISABLE_OBJECTIVE = 6;
export const ENCOUNTER_FRAME_PHASE_SHIFT_CHANGED = 7;

export interface DungeonDifficulty {
  difficulty: number;
  /** Whether the server is reporting the group's difficulty rather than the player's own. */
  inGroup: boolean;
}

export interface InstanceLockout {
  mapId: number;
  difficulty: number;
  instanceId: bigint;
  /** False once the lockout has run out but is still listed. */
  active: boolean;
  /** The player has asked to keep this lockout past its reset. */
  extended: boolean;
  secondsUntilReset: number;
}

export interface RaidInstanceMessage {
  type: number;
  mapId: number;
  difficulty: number;
  secondsLeft: number;
}

export interface EncounterFrame {
  type: number;
  /** Present for engage, disengage and priority changes; those three carry the unit. */
  guid: bigint | undefined;
  param1: number;
  param2: number;
}

/**
 * `MSG_SET_DUNGEON_DIFFICULTY` and `MSG_SET_RAID_DIFFICULTY`: `u32 difficulty, u32 one, u32 inGroup`.
 *
 * Two-way, like the rest of the `MSG_` family: the client sends a bare `u32` to ask for a change
 * and the server answers with all three. The middle word is written as a literal 1 at every
 * sender (`Player.cpp:20895`) and nothing in the core reads it back.
 */
export function parseDungeonDifficulty(payload: Uint8Array): DungeonDifficulty {
  const reader = new PacketReader(payload);
  const difficulty = reader.u32();
  reader.u32();
  return { difficulty, inGroup: reader.u32() !== 0 };
}

/** `CMSG_SET_DUNGEON_DIFFICULTY` / `CMSG_SET_RAID_DIFFICULTY`: one word and nothing else. */
export function buildSetDifficulty(difficulty: number): Uint8Array {
  return new PacketWriter().u32(difficulty).toUint8Array();
}

/** `SMSG_INSTANCE_DIFFICULTY`: `u32 difficulty, u32 dynamicHeroic`. Sent on entering a map. */
export function parseInstanceDifficulty(payload: Uint8Array): { difficulty: number; dynamic: boolean } {
  const reader = new PacketReader(payload);
  const difficulty = reader.u32();
  return { difficulty, dynamic: reader.u32() !== 0 };
}

/**
 * `SMSG_RAID_INSTANCE_INFO`: `u32 count`, then that many 22-byte lockouts.
 *
 * The instance id is written as a `uint64` (`Player.cpp:19491`) although it is a `uint32`
 * everywhere else in the core. Reading it as a word shifts every following lockout by four bytes,
 * and the list is exactly where that would not be noticed.
 */
export function parseRaidInstanceInfo(payload: Uint8Array): InstanceLockout[] {
  const reader = new PacketReader(payload);
  const count = reader.u32();
  if (count > 200) throw new RangeError(`SMSG_RAID_INSTANCE_INFO claims ${count} lockouts`);
  const lockouts: InstanceLockout[] = [];
  for (let index = 0; index < count; index++) {
    lockouts.push({
      mapId: reader.u32(),
      difficulty: reader.u32(),
      instanceId: reader.u64(),
      active: reader.u8() !== 0,
      extended: reader.u8() !== 0,
      secondsUntilReset: reader.u32(),
    });
  }
  return lockouts;
}

/**
 * `SMSG_RAID_INSTANCE_MESSAGE`: `u32 type, u32 map, u32 difficulty, u32 seconds`, and two more
 * bytes when the type is `RAID_INSTANCE_WELCOME` — which is the type it is usually sent with,
 * since entering an instance passes `welcome = true` (`MovementHandler.cpp:176`).
 */
export function parseRaidInstanceMessage(payload: Uint8Array): RaidInstanceMessage {
  const reader = new PacketReader(payload);
  return {
    type: reader.u32(),
    mapId: reader.u32(),
    difficulty: reader.u32(),
    secondsLeft: reader.u32(),
    // The two trailing bytes are literal zeroes at the only sender and nothing reads them back.
  };
}

/** `SMSG_INSTANCE_RESET`, `SMSG_UPDATE_LAST_INSTANCE`, `SMSG_RESET_FAILED_NOTIFY`: one map id. */
export function parseInstanceMapId(payload: Uint8Array): number {
  return new PacketReader(payload).u32();
}

/** `SMSG_INSTANCE_RESET_FAILED`: `u32 reason, u32 map`. The size hint of four bytes is a lie. */
export function parseInstanceResetFailed(payload: Uint8Array): { reason: number; mapId: number } {
  const reader = new PacketReader(payload);
  const reason = reader.u32();
  return { reason, mapId: reader.u32() };
}

/** `SMSG_RAID_GROUP_ONLY`: `u32 homebindMilliseconds, u32 reason`. */
export function parseRaidGroupOnly(payload: Uint8Array): { homebindMilliseconds: number; reason: number } {
  const reader = new PacketReader(payload);
  const homebindMilliseconds = reader.u32();
  return { homebindMilliseconds, reason: reader.u32() };
}

export interface InstanceLockWarning {
  milliseconds: number;
  /** `InstanceScript::GetCompletedEncounterMask`: `1 << DungeonEncounter.Bit` per boss killed. */
  encounterMask: number;
  /** The byte after the mask, stock's `INSTANCE_LOCK_TIMER_PREVIOUSLY_SAVED` case; this core writes 0. */
  previouslySaved: boolean;
}

/**
 * `SMSG_INSTANCE_LOCK_WARNING_QUERY`: `u32 milliseconds, u32 completedEncounterMask, u8`
 * (`InstanceMap::AddPlayerToMap`, Map.cpp:4155-4160: 60000, the mask, 0). Sent to a player entering
 * an instance its group is permanently bound to; the core then waits 60 s for the answer
 * (`SetPendingBind`) and binds by itself if none comes (`Player::Update`, Player.cpp:1313-1320).
 */
export function parseInstanceLockWarning(payload: Uint8Array): InstanceLockWarning {
  const reader = new PacketReader(payload);
  const milliseconds = reader.u32();
  const encounterMask = reader.u32();
  return { milliseconds, encounterMask, previouslySaved: reader.u8() !== 0 };
}

/**
 * `CMSG_INSTANCE_LOCK_RESPONSE`: one byte (`HandleInstanceLockResponse`, MiscHandler.cpp:1545) — 1
 * binds now, 0 is «Покинуть подземелье» (`RepopAtGraveyard`). Without a pending bind the core only
 * logs the packet, so it is sent once.
 */
export function buildInstanceLockResponse(accept: boolean): Uint8Array {
  return new PacketWriter().u8(accept ? 1 : 0).toUint8Array();
}

/**
 * `CMSG_AREATRIGGER`: the AreaTrigger.dbc id just entered, one word (`HandleAreaTriggerOpcode`,
 * MiscHandler.cpp:725). The core checks it against the position it last heard (in flight, unknown,
 * out of range: silently ignored), so the sender reports the position first (browser/game/AreaTriggers.ts).
 */
export function buildAreaTrigger(id: number): Uint8Array {
  return new PacketWriter().u32(id).toUint8Array();
}

/**
 * `SMSG_UPDATE_INSTANCE_ENCOUNTER_UNIT`: a word, then a tail that depends on it.
 *
 * Four shapes over eight types (`InstanceScript.cpp:898-925`), and the first three carry a
 * **packed** guid where the rest of this family carries none — `GetPackGUID()` rather than the
 * full form the neighbouring packets use.
 */
export function parseEncounterFrame(payload: Uint8Array): EncounterFrame {
  const reader = new PacketReader(payload);
  const type = reader.u32();
  if (type === ENCOUNTER_FRAME_ENGAGE || type === ENCOUNTER_FRAME_DISENGAGE || type === ENCOUNTER_FRAME_UPDATE_PRIORITY) {
    const guid = reader.packedGuid();
    return { type, guid, param1: reader.remaining > 0 ? reader.u8() : 0, param2: 0 };
  }
  if (type === ENCOUNTER_FRAME_UPDATE_OBJECTIVE) {
    const param1 = reader.u8();
    return { type, guid: undefined, param1, param2: reader.u8() };
  }
  if (type === ENCOUNTER_FRAME_ADD_TIMER || type === ENCOUNTER_FRAME_ENABLE_OBJECTIVE || type === ENCOUNTER_FRAME_DISABLE_OBJECTIVE) {
    return { type, guid: undefined, param1: reader.u8(), param2: 0 };
  }
  // Phase shift, and anything this build does not name: the type is the whole packet.
  return { type, guid: undefined, param1: 0, param2: 0 };
}
