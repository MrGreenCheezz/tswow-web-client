import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: SpellEffects.cpp (the duel flag effect writes
// SMSG_DUEL_REQUESTED), Player.cpp `DuelComplete` and `SendDuelCountdown`, DuelHandler.cpp.

export interface DuelRequest {
  /** The duel flag gameobject that was planted between the two players. */
  flagGuid: bigint;
  /** Who challenged you. */
  challengerGuid: bigint;
}

export function parseDuelRequested(payload: Uint8Array): DuelRequest {
  const reader = new PacketReader(payload);
  const flagGuid = reader.u64();
  const challengerGuid = reader.u64();
  reader.assertFinished();
  return { flagGuid, challengerGuid };
}

/** Seconds remaining before the duel starts. */
export function parseDuelCountdown(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const seconds = reader.u32();
  reader.assertFinished();
  return seconds;
}

/** False when the duel was interrupted rather than finished. */
export function parseDuelComplete(payload: Uint8Array): boolean {
  const reader = new PacketReader(payload);
  const completed = reader.u8() !== 0;
  reader.assertFinished();
  return completed;
}

export interface DuelWinner {
  /** True when the loser fled rather than being beaten. */
  fled: boolean;
  winner: string;
  loser: string;
}

export function parseDuelWinner(payload: Uint8Array): DuelWinner {
  const reader = new PacketReader(payload);
  const fled = reader.u8() !== 0;
  const winner = reader.cString();
  const loser = reader.cString();
  return { fled, winner, loser };
}

/** Both the accept and the cancel opcode carry the duel flag's GUID. */
export function buildDuelResponse(flagGuid: bigint): Uint8Array {
  return new PacketWriter().u64(flagGuid).toUint8Array();
}
