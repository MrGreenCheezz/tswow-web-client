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

/**
 * How far from the planted flag a duelist may walk, in yards.
 *
 * `Player::CheckDuelDistance` (`Player.cpp:7366-7398`): past 50 the server starts the 10-second
 * out-of-bounds clock (`SMSG_DUEL_OUTOFBOUNDS`), and stepping back inside 40 cancels it
 * (`SMSG_DUEL_INBOUNDS`). The ring is drawn at the outer number — the one that starts the clock.
 */
export const DUEL_OUT_OF_BOUNDS_YARDS = 50;
/** The hysteresis the server grants on the way back in; the ring never uses this number. */
export const DUEL_BACK_IN_BOUNDS_YARDS = 40;

/**
 * `CMSG_DUEL_REQUESTED` is not a thing: a challenge is `CMSG_CAST_SPELL` of 7266
 * (`Duel` spell) or the `CMSG_DUEL_PROPOSED`-less `CMSG_DUEL_REQUEST`? In 3.3.5 the client
 * challenges via `CMSG_DUEL_PROPOSED`? No — TrinityCore `DuelHandler.cpp` handles
 * `CMSG_DUEL_ACCEPTED/CANCELLED` only; the challenge itself is the `DUEL` spell cast
 * (spell 7266) targeted at the unit. Keep an explicit helper so UI does not hardcode the id.
 */
export const DUEL_SPELL_ID = 7266;
