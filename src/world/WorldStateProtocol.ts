import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: WorldStatePackets.cpp (`InitWorldStates::Write`,
// `UpdateWorldState::Write`), MiscPackets.cpp `UITime::Write` and MiscHandler.cpp
// `HandleWorldStateUITimerUpdate`.

/**
 * One numbered variable the world publishes to whoever is standing in it — a battleground's flag
 * count, a capture bar's fill, whether Wintergrasp is running, a boss's remaining pylons.
 *
 * Both halves are signed at the source, and that matters: a capture bar reports a percentage that
 * runs through zero, and reading it unsigned turns the alliance half of the bar into four billion.
 */
export interface WorldStateEntry {
  variableId: number;
  value: number;
}

export interface InitWorldStates {
  mapId: number;
  zoneId: number;
  areaId: number;
  states: WorldStateEntry[];
}

/**
 * The whole set for the place the character just arrived in, sent on every zone change.
 *
 * The count is a `uint16` sitting behind three `int32`s, which is the one thing to get right here:
 * read it as a fourth `int32` and the first pair of entries becomes the count, the rest of the
 * packet slides by two bytes, and the numbers that come out are large but plausible.
 */
export function parseInitWorldStates(payload: Uint8Array): InitWorldStates {
  const reader = new PacketReader(payload);
  const mapId = reader.i32();
  const zoneId = reader.i32();
  const areaId = reader.i32();
  const count = reader.u16();
  const states: WorldStateEntry[] = [];
  for (let index = 0; index < count; index++) states.push({ variableId: reader.i32(), value: reader.i32() });
  reader.assertFinished();
  return { mapId, zoneId, areaId, states };
}

/** One variable moved. There is no zone in it: it applies to whatever set arrived last. */
export function parseUpdateWorldState(payload: Uint8Array): WorldStateEntry {
  const reader = new PacketReader(payload);
  const variableId = reader.i32();
  const value = reader.i32();
  reader.assertFinished();
  return { variableId, value };
}

/**
 * The server's own clock, in unix seconds, answering the client's request for it.
 *
 * This is what a world-state timer counts against — a battleground's "battle begins in", a
 * Wintergrasp countdown — and it is why those timers need it: the states themselves carry an
 * absolute end time, not a duration, so without the server's clock the client would count down
 * against its own, which is not the same clock.
 */
export function parseWorldStateUiTimer(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const time = reader.u32();
  reader.assertFinished();
  return time;
}

/** Empty request: the answer is `SMSG_WORLD_STATE_UI_TIMER_UPDATE`. */
export function buildWorldStateUiTimerQuery(): Uint8Array {
  return new PacketWriter().toUint8Array();
}
