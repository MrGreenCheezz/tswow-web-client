import { PacketReader } from "../protocol/PacketReader.js";

/**
 * One-shot announcements about a unit: it lost its target, it noticed you, it killed something,
 * its combo points moved. Small packets that each mean one thing, kept together because none of
 * them is large enough to be worth its own file and all of them are read the same way.
 *
 * Note which guids are packed and which are not — the core is not consistent about it, and the
 * difference is silent: a full guid read as packed consumes one byte and leaves the rest of the
 * packet shifted.
 */

/** `SMSG_CLEAR_TARGET`, from `SpellEffects.cpp`: a full guid, not a packed one. */
export function parseClearTarget(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}

/** `SMSG_BREAK_TARGET`, from `Unit::SendClearTarget`: this one is packed. */
export function parseBreakTarget(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  reader.assertFinished();
  return guid;
}

/** `AiReaction`. Hostile is the one that means "it has noticed you and is coming". */
export const AI_REACTION_HOSTILE = 2;

export interface AiReaction {
  guid: bigint;
  reaction: number;
}

/** Mirrors `Creature::SendAIReaction`. */
export function parseAiReaction(payload: Uint8Array): AiReaction {
  const reader = new PacketReader(payload);
  const reaction = { guid: reader.u64(), reaction: reader.u32() };
  reader.assertFinished();
  return reaction;
}

export interface PartyKill {
  killerGuid: bigint;
  victimGuid: bigint;
}

/** Mirrors the `SMSG_PARTYKILLLOG` in `Unit::Kill`: who struck the killing blow, and on whom. */
export function parsePartyKill(payload: Uint8Array): PartyKill {
  const reader = new PacketReader(payload);
  const kill = { killerGuid: reader.u64(), victimGuid: reader.u64() };
  reader.assertFinished();
  return kill;
}

export interface ComboPoints {
  guid: bigint;
  points: number;
}

/** Mirrors `Unit::SendComboPoints`: whose combo points, and how many are on the target now. */
export function parseComboPoints(payload: Uint8Array): ComboPoints {
  const reader = new PacketReader(payload);
  return { guid: reader.packedGuid(), points: reader.u8() };
}

/** `SMSG_FEIGN_DEATH_RESISTED`: the feign did not take. */
export function parseFeignDeathResisted(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  return reader.u64();
}

/** `SMSG_DISMOUNT`, from `Unit::Dismount`: packed guid of whoever got off. */
export function parseDismount(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  reader.assertFinished();
  return guid;
}

/** `SMSG_MOUNTSPECIAL_ANIM`: the trick a mount does when its rider presses the key. */
export function parseMountSpecial(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.u64();
  reader.assertFinished();
  return guid;
}

export interface PowerUpdate {
  guid: bigint;
  powerType: number;
  value: number;
}

/**
 * `SMSG_POWER_UPDATE`, from `Unit::SetPower`: the same number the update fields carry, sent on its
 * own so a bar can move without waiting for the next object update.
 */
export function parsePowerUpdate(payload: Uint8Array): PowerUpdate {
  const reader = new PacketReader(payload);
  const update = { guid: reader.packedGuid(), powerType: reader.u8(), value: reader.u32() };
  reader.assertFinished();
  return update;
}

/**
 * `SMSG_CANCEL_AUTO_REPEAT`: the wand or auto shot stopped.
 *
 * TrinityCore stores this field as `PackedGuid` (`CombatPackets.h`) and writes it directly
 * (`CombatPackets.cpp`). The initial allocation size of eight bytes is only capacity; it does not
 * make this a full guid. For example, the live payload `01 03` names guid 3.
 */
export function parseCancelAutoRepeat(payload: Uint8Array): bigint {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  reader.assertFinished();
  return guid;
}
