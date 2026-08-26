// What another *player* is doing, as the server retells it to everyone standing near them.
//
// This is the third corner of a triangle the other two sides of which are already built.
// `MovementAckProtocol` handles the `SMSG_FORCE_*` and `SMSG_MOVE_*` packets addressed to the
// character this client controls — a change to agree to, withheld until the agreement comes back.
// `SplineStateProtocol` handles the `SMSG_SPLINE_*` twins for units with no client behind them,
// which apply on receipt. These are the same changes for a unit that *somebody else's* client is
// driving, and the core says so in one line at `MovementPacketSender.cpp:26`: "MSG_MOVE_SET_*_SPEED
// is used to broadcast changes to observers of units controlled by a player."
//
// Three things follow from that, and all three are why these were invisible for so long:
//
// * **Every one is `STATUS_NEVER`.** A client may not send them, and the coverage report read that
//   refusal as absence — which is what hid the whole family until the report was corrected.
// * **They are `MSG_`, so the name never appears at the send site.** The server mirrors a movement
//   opcode back through the variable it arrived in; only this speed and knock-back family, which
//   the core builds by name, can be found by a text scan at all.
// * **Nothing is acknowledged and nothing is withheld.** There is no counter in any of them: the
//   packet describes a change that has already happened to somebody else.
//
// Without them a neighbour who mounts up still runs at walking pace on this screen, a blinking mage
// slides across the ground instead of vanishing, and a knocked-back player drifts.

import { OPCODES } from "../generated/opcodes.js";
import { PacketReader } from "../protocol/PacketReader.js";
import { readMovementInfo, type MovementInfo } from "./MovementProtocol.js";
import type { SplineSpeedName } from "./SplineStateProtocol.js";

/**
 * `MovementPacketSender::moveTypeToOpcode` column 2, in `UnitMoveType` order.
 *
 * The names are the ones `SplineStateProtocol` already uses, because the two families set the same
 * nine speeds on the same store — one for units a player drives, one for units the server drives.
 * Two of the nine are radians a second rather than yards.
 */
export const RELAY_SPEEDS = [
  { opcode: OPCODES.MSG_MOVE_SET_WALK_SPEED, name: "walk" },
  { opcode: OPCODES.MSG_MOVE_SET_RUN_SPEED, name: "run" },
  { opcode: OPCODES.MSG_MOVE_SET_RUN_BACK_SPEED, name: "runBack" },
  { opcode: OPCODES.MSG_MOVE_SET_SWIM_SPEED, name: "swim" },
  { opcode: OPCODES.MSG_MOVE_SET_SWIM_BACK_SPEED, name: "swimBack" },
  { opcode: OPCODES.MSG_MOVE_SET_TURN_RATE, name: "turnRate" },
  { opcode: OPCODES.MSG_MOVE_SET_FLIGHT_SPEED, name: "flight" },
  { opcode: OPCODES.MSG_MOVE_SET_FLIGHT_BACK_SPEED, name: "flightBack" },
  { opcode: OPCODES.MSG_MOVE_SET_PITCH_RATE, name: "pitchRate" },
] as const satisfies readonly { opcode: number; name: SplineSpeedName }[];

const RELAY_SPEED_BY_OPCODE = new Map<number, SplineSpeedName>(
  RELAY_SPEEDS.map((entry) => [entry.opcode as number, entry.name]),
);

/**
 * The state relays that carry nothing but a movement info — the same shape the ordinary movement
 * opcodes have, and the same meaning: the flags word inside is the answer.
 *
 * `Player::SetFeatherFall`, `SetWaterWalking` and `SetCanFly` each send the owner an `SMSG_` toggle
 * to acknowledge and then broadcast one of these to everybody else with `BuildMovementPacket`.
 * `MSG_MOVE_HOVER` and `MSG_MOVE_GRAVITY_CHNG`, already handled, are the same three lines of code.
 */
export const RELAY_STATE_OPCODES: readonly number[] = [
  OPCODES.MSG_MOVE_FEATHER_FALL,
  OPCODES.MSG_MOVE_WATER_WALK,
  OPCODES.MSG_MOVE_UPDATE_CAN_FLY,
];

export function isMovementRelaySpeed(opcode: number): boolean {
  return RELAY_SPEED_BY_OPCODE.has(opcode);
}

export interface MovementRelaySpeed {
  guid: bigint;
  name: SplineSpeedName;
  /** Absolute yards a second, or radians a second for the two rates. Never a multiplier. */
  value: number;
  /** Where the unit was when the change happened; the packet carries a full movement info. */
  movement: MovementInfo;
}

/**
 * `MovementInfo, f32` — `MovementPacketSender::SendSpeedChangeToObservers`.
 *
 * The trap is what is *not* here. The `SMSG_FORCE_*_SPEED_CHANGE` this mirrors carries a packed
 * guid, a counter and — for run alone — a spare byte before the float; the `SMSG_SPLINE_SET_*`
 * twin carries a packed guid and the float and nothing else. This one carries a whole movement
 * info between the guid and the float, thirty bytes or more of it. All three end in a float, so a
 * reader that used the wrong layout still finds a plausible speed at the end of a short packet and
 * a wildly wrong one at the end of a long one.
 */
export function parseMovementRelaySpeed(opcode: number, payload: Uint8Array): MovementRelaySpeed {
  const name = RELAY_SPEED_BY_OPCODE.get(opcode);
  if (!name) throw new Error(`Opcode 0x${opcode.toString(16)} is not a movement speed relay`);
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const movement = readMovementInfo(reader);
  const value = reader.f32();
  reader.assertFinished();
  return { guid, name, value, movement };
}

export interface MovementRelayKnockBack {
  guid: bigint;
  movement: MovementInfo;
  /** Sine **first** here, which is the reverse of the `SMSG_MOVE_KNOCK_BACK` sent to the victim. */
  directionSin: number;
  directionCos: number;
  speedXY: number;
  /** Not negated on this side: it is echoed from what the victim's own client acknowledged. */
  speedZ: number;
}

/**
 * `MovementInfo, f32 sin, f32 cos, f32 xySpeed, f32 zSpeed` — `HandleMoveKnockBackAck`.
 *
 * Sent only once the victim's client has acknowledged the knock back, which is why it carries their
 * post-knock movement info rather than the parameters the server chose: this is the relay of a fact,
 * not of an instruction, and nobody acknowledges it.
 *
 * The direction pair is sine-first. `SMSG_MOVE_KNOCK_BACK`, the packet the victim gets, writes the
 * same two floats cosine-first — `Unit.cpp` streams a `TaggedPosition<XY>` of `(cos, sin)` — so the
 * two halves of one knock back disagree about the order, and swapping them turns the arc ninety
 * degrees without any error anywhere.
 */
export function parseMovementRelayKnockBack(payload: Uint8Array): MovementRelayKnockBack {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const movement = readMovementInfo(reader);
  const directionSin = reader.f32();
  const directionCos = reader.f32();
  const speedXY = reader.f32();
  const speedZ = reader.f32();
  reader.assertFinished();
  return { guid, movement, directionSin, directionCos, speedXY, speedZ };
}

export interface MovementTimeSkipped {
  guid: bigint;
  /** Milliseconds the mover's own clock jumped. */
  skipped: number;
}

/**
 * `packedGuid, u32` — `HandleMoveTimeSkippedOpcode`.
 *
 * A client whose clock stalled — alt-tabbed, or hitched — tells the server how much time it lost,
 * and the server adds it to that unit's movement time and passes it on unchanged. It moves nobody:
 * it exists so that everyone's idea of *when* the next movement packet happened stays comparable.
 * Applying it as a position change would move a player who did not move.
 */
export function parseMovementTimeSkipped(payload: Uint8Array): MovementTimeSkipped {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const skipped = reader.u32();
  reader.assertFinished();
  return { guid, skipped };
}
