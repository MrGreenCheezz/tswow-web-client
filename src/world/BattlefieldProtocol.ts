import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: BattlefieldHandler.cpp — `SendBfInvitePlayerToWar`,
// `SendBfInvitePlayerToQueue`, `SendBfQueueInviteResponse`, `SendBfEntered`, `SendBfLeaveMessage`,
// and the three responses a client sends back.
//
// This is the outdoor battlefield manager, not the battleground queue: Wintergrasp is the only
// battle it runs in this build. The two share nothing but the word "battlefield" — a battleground
// is queued for and teleported into, a battlefield happens in a zone the player is already
// standing in, which is why every packet here is a battle id and a handful of bytes.

/** `BattlefieldBattleId` in SharedDefines.h. Only Wintergrasp exists in this build. */
export const BATTLEFIELD_BATTLEID_WINTERGRASP = 1;

/** `BFLeaveReason` in WorldSession.h. A bit mask by declaration, one value at a time in practice. */
export const BF_LEAVE_REASON_CLOSE = 0x01;
export const BF_LEAVE_REASON_EXITED = 0x08;
export const BF_LEAVE_REASON_LOW_LEVEL = 0x10;

export interface BattlefieldWarInvite {
  battleId: number;
  /** Where the battle is: 4197 for Wintergrasp. */
  zoneId: number;
  /**
   * When the offer runs out, in server unix seconds — an absolute moment, not a countdown. The
   * server computes it as `GameTime::GetGameTime() + acceptTime`, so counting it against the local
   * clock is wrong by whatever the two clocks differ by; `SMSG_WORLD_STATE_UI_TIMER_UPDATE` is the
   * packet that says what the server thinks the time is.
   */
  expiresAt: number;
}

/** "The battle has started, do you want in." Answered by `CMSG_BATTLEFIELD_MGR_ENTRY_INVITE_RESPONSE`. */
export function parseBattlefieldEntryInvite(payload: Uint8Array): BattlefieldWarInvite {
  const reader = new PacketReader(payload);
  const invite: BattlefieldWarInvite = { battleId: reader.u32(), zoneId: reader.u32(), expiresAt: reader.u32() };
  reader.assertFinished();
  return invite;
}

export interface BattlefieldQueueInvite {
  battleId: number;
  /** The core writes a literal 1 and its own comment doubts it. Kept because the byte is there. */
  warmup: boolean;
}

/** "You may queue for the battle." One step earlier than the war invite above. */
export function parseBattlefieldQueueInvite(payload: Uint8Array): BattlefieldQueueInvite {
  const reader = new PacketReader(payload);
  const invite: BattlefieldQueueInvite = { battleId: reader.u32(), warmup: reader.u8() !== 0 };
  reader.assertFinished();
  return invite;
}

export interface BattlefieldQueueResponse {
  battleId: number;
  zoneId: number;
  /** Whether the queue took the player. */
  queued: boolean;
  /**
   * Inverted on the wire: the core writes `full ? 0 : 1`, so the byte means "there was room", not
   * "it is full". Reading it as the name in the core's parameter list says gives the opposite
   * answer to the one the server sent.
   */
  hasRoom: boolean;
  warmup: boolean;
}

/** The answer to asking for a place in the queue. */
export function parseBattlefieldQueueResponse(payload: Uint8Array): BattlefieldQueueResponse {
  const reader = new PacketReader(payload);
  const response: BattlefieldQueueResponse = {
    battleId: reader.u32(),
    zoneId: reader.u32(),
    queued: reader.u8() !== 0,
    hasRoom: reader.u8() !== 0,
    warmup: reader.u8() !== 0,
  };
  reader.assertFinished();
  return response;
}

export interface BattlefieldEntered {
  battleId: number;
  /** Whether the server cleared the player's away flag on the way in. */
  clearedAfk: boolean;
}

/**
 * The player is in the battle now.
 *
 * Two of the four bytes are unnamed constants the core writes as 1 and never varies, so they are
 * read and dropped rather than guessed at.
 */
export function parseBattlefieldEntered(payload: Uint8Array): BattlefieldEntered {
  const reader = new PacketReader(payload);
  const battleId = reader.u32();
  reader.u8();
  reader.u8();
  const clearedAfk = reader.u8() !== 0;
  reader.assertFinished();
  return { battleId, clearedAfk };
}

export interface BattlefieldEjected {
  battleId: number;
  /** A `BF_LEAVE_REASON_*` value. */
  reason: number;
  /** The core writes a literal 2 here; its meaning is the battle's state, not the player's. */
  battleStatus: number;
  /** Whether the server moved the player out of the zone as well as out of the battle. */
  relocated: boolean;
}

/** The player is out: the battle ended, they walked out, or they were never eligible. */
export function parseBattlefieldEjected(payload: Uint8Array): BattlefieldEjected {
  const reader = new PacketReader(payload);
  const ejected: BattlefieldEjected = {
    battleId: reader.u32(),
    reason: reader.u8(),
    battleStatus: reader.u8(),
    relocated: reader.u8() !== 0,
  };
  reader.assertFinished();
  return ejected;
}

const LEAVE_REASONS: Record<number, string> = {
  [BF_LEAVE_REASON_CLOSE]: "Битва закончилась",
  [BF_LEAVE_REASON_EXITED]: "Вы покинули зону битвы",
  [BF_LEAVE_REASON_LOW_LEVEL]: "Ваш уровень слишком низок для этой битвы",
};

export function battlefieldLeaveReasonText(reason: number): string {
  return LEAVE_REASONS[reason] ?? `Битва: код выхода ${reason}`;
}

/**
 * Answering the invitation to join the war.
 *
 * A refusal is not a no-op: refusing while standing in the battle's own zone gets the player
 * kicked out of the zone, which is the server's choice and not something the client can soften.
 */
export function buildBattlefieldEntryInviteResponse(battleId: number, accepted: boolean): Uint8Array {
  return new PacketWriter().u32(battleId).u8(accepted ? 1 : 0).toUint8Array();
}

/**
 * Answering the invitation to queue. Declining is silent — the server reads the byte and, finding
 * it zero, does nothing at all — so nothing comes back either way until the battle moves on.
 */
export function buildBattlefieldQueueInviteResponse(battleId: number, accepted: boolean): Uint8Array {
  return new PacketWriter().u32(battleId).u8(accepted ? 1 : 0).toUint8Array();
}

/** Leaving the queue. This is the only battlefield request a client may start on its own. */
export function buildBattlefieldExitRequest(battleId: number): Uint8Array {
  return new PacketWriter().u32(battleId).toUint8Array();
}
