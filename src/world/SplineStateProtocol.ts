// What everyone else is doing: the movement state and the speeds of units the server drives.
//
// This is the other half of MovementAckProtocol. That file handles the packets addressed to the
// character a player controls, which arrive as a change to agree to and are withheld until the
// agreement comes back. These are the same changes for a unit nobody controls — a creature, a pet,
// a vehicle nobody is sitting in — and the core makes the split explicit in the comment at
// `MovementPacketSender.cpp:24-26`: `SMSG_SPLINE_*` for server-controlled units, `SMSG_FORCE_*`
// for a unit a player is moving. The consequences for a client are the opposite in every respect:
//
// * **Nothing is acknowledged.** All twenty-five are `STATUS_NEVER` in `Opcodes.cpp`, meaning the
//   server refuses the opcode number from a client outright. There is no counter in the packet to
//   echo and nothing is being withheld — the value applies on receipt.
// * **They never name the player's own mover.** `Unit::SetRooted` and its neighbours branch on
//   `GetTypeId() == TYPEID_PLAYER` and send the `FORCE` variant instead, so a spline packet is
//   always about somebody else.
// * **Copying the layout from the `FORCE` family costs four bytes.** `SMSG_FORCE_MOVE_ROOT` writes
//   `m_rootTimes` after the guid; `SMSG_SPLINE_MOVE_ROOT` (`Unit.cpp:12254`) writes the guid and
//   stops. The same trap in reverse for the speeds: `SMSG_FORCE_RUN_SPEED_CHANGE` carries a
//   counter and, for run alone, a spare byte.
//
// One more thing a client has to know: these are only sent when the unit already has a spline
// running (`if (!movespline->Initialized()) return true;` guards nearly every sender in
// `Creature.cpp`). A creature that has never moved changes state silently and says so only in its
// next object update, so absence of a packet is not absence of a change.

import { OPCODES } from "../generated/opcodes.js";
import { PacketReader } from "../protocol/PacketReader.js";
import { MOVEMENT_FLAGS } from "./MovementProtocol.js";

/**
 * The sixteen state changes, and the movement flag each one is.
 *
 * The packet carries no flags word at all — the opcode identity *is* the change, so the mapping
 * has to live somewhere, and this is it. Flag values are `enum MovementFlags`,
 * `UnitDefines.h:279-301`; which flag each opcode corresponds to comes from the `Unit::Set*`
 * function that raises it just before the packet goes out.
 */
export const SPLINE_MOVE_STATES = [
  { opcode: OPCODES.SMSG_SPLINE_MOVE_SET_WALK_MODE, flag: MOVEMENT_FLAGS.walking, set: true },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_SET_RUN_MODE, flag: MOVEMENT_FLAGS.walking, set: false },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_GRAVITY_DISABLE, flag: MOVEMENT_FLAGS.disableGravity, set: true },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_GRAVITY_ENABLE, flag: MOVEMENT_FLAGS.disableGravity, set: false },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_START_SWIM, flag: MOVEMENT_FLAGS.swimming, set: true },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_STOP_SWIM, flag: MOVEMENT_FLAGS.swimming, set: false },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_SET_FLYING, flag: MOVEMENT_FLAGS.canFly, set: true },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_UNSET_FLYING, flag: MOVEMENT_FLAGS.canFly, set: false },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_WATER_WALK, flag: MOVEMENT_FLAGS.waterWalking, set: true },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_LAND_WALK, flag: MOVEMENT_FLAGS.waterWalking, set: false },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_FEATHER_FALL, flag: MOVEMENT_FLAGS.fallingSlow, set: true },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_NORMAL_FALL, flag: MOVEMENT_FLAGS.fallingSlow, set: false },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_SET_HOVER, flag: MOVEMENT_FLAGS.hover, set: true },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_UNSET_HOVER, flag: MOVEMENT_FLAGS.hover, set: false },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_ROOT, flag: MOVEMENT_FLAGS.root, set: true },
  { opcode: OPCODES.SMSG_SPLINE_MOVE_UNROOT, flag: MOVEMENT_FLAGS.root, set: false },
] as const;

/**
 * The nine rates, and what the float means.
 *
 * `MovementPacketSender.cpp:29-37` maps `UnitMoveType` to the opcode; the values themselves are
 * absolute — `Unit.cpp:9244` multiplies the rate by the base speed before sending — so nothing
 * here has to know a base to use them. Two of the nine are angles a second rather than yards.
 */
export const SPLINE_SPEEDS = [
  { opcode: OPCODES.SMSG_SPLINE_SET_WALK_SPEED, name: "walk" },
  { opcode: OPCODES.SMSG_SPLINE_SET_RUN_SPEED, name: "run" },
  { opcode: OPCODES.SMSG_SPLINE_SET_RUN_BACK_SPEED, name: "runBack" },
  { opcode: OPCODES.SMSG_SPLINE_SET_SWIM_SPEED, name: "swim" },
  { opcode: OPCODES.SMSG_SPLINE_SET_SWIM_BACK_SPEED, name: "swimBack" },
  { opcode: OPCODES.SMSG_SPLINE_SET_TURN_RATE, name: "turnRate" },
  { opcode: OPCODES.SMSG_SPLINE_SET_FLIGHT_SPEED, name: "flight" },
  { opcode: OPCODES.SMSG_SPLINE_SET_FLIGHT_BACK_SPEED, name: "flightBack" },
  { opcode: OPCODES.SMSG_SPLINE_SET_PITCH_RATE, name: "pitchRate" },
] as const;

export type SplineSpeedName = (typeof SPLINE_SPEEDS)[number]["name"];

const STATE_BY_OPCODE = new Map(SPLINE_MOVE_STATES.map((entry) => [entry.opcode as number, entry]));
const SPEED_BY_OPCODE = new Map(SPLINE_SPEEDS.map((entry) => [entry.opcode as number, entry]));

export interface SplineMoveState {
  guid: bigint;
  /** The `MovementFlags` bit this opcode is about. */
  flag: number;
  /** Whether the bit goes up or down. */
  set: boolean;
}

export interface SplineSpeed {
  guid: bigint;
  name: SplineSpeedName;
  /** Yards a second, or radians a second for the two rates. Absolute, not a multiplier. */
  value: number;
}

export function isSplineMoveState(opcode: number): boolean {
  return STATE_BY_OPCODE.has(opcode);
}

export function isSplineSpeed(opcode: number): boolean {
  return SPEED_BY_OPCODE.has(opcode);
}

/**
 * `packedGuid` — the whole packet.
 *
 * The `WorldPacket data(opcode, 9)` in the sender is a buffer reserve and not the size on the
 * wire: a packed guid is one mask byte plus only the non-zero bytes of the identifier, so a
 * creature with a low guid sends five bytes and nothing is missing.
 */
export function parseSplineMoveState(opcode: number, payload: Uint8Array): SplineMoveState {
  const entry = STATE_BY_OPCODE.get(opcode);
  if (!entry) throw new Error(`Opcode 0x${opcode.toString(16)} is not a spline movement state`);
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  return { guid, flag: entry.flag, set: entry.set };
}

/** `packedGuid, f32` — `MovementPacketSender::SendSpeedChangeToAll`, `MovementPacketSender.cpp:100-104`. */
export function parseSplineSpeed(opcode: number, payload: Uint8Array): SplineSpeed {
  const entry = SPEED_BY_OPCODE.get(opcode);
  if (!entry) throw new Error(`Opcode 0x${opcode.toString(16)} is not a spline speed change`);
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  return { guid, name: entry.name, value: reader.f32() };
}

/**
 * `f32 progress, packedGuid` — `SMSG_FLIGHT_SPLINE_SYNC`, `Unit.cpp:557-560`.
 *
 * The float comes **first**, which is the reverse of every other packet in this file: the core
 * builds it by calling `PacketBuilder::WriteSplineSync` and only then appending the guid. Reading
 * a packed guid first eats the float's exponent bytes as a mask and everything after is noise.
 *
 * The value is how far through its looping path the unit is, from 0 to 1. It is sent at most once
 * every five seconds and only for a cyclic spline, so it is a correction for drift on a long
 * flight rather than a position in its own right.
 */
export function parseFlightSplineSync(payload: Uint8Array): { guid: bigint; progress: number } {
  const reader = new PacketReader(payload);
  const progress = reader.f32();
  const guid = reader.packedGuid();
  // A zero-length spline would divide by zero on the server side; refuse the result rather than
  // seek a unit to NaN along its path.
  return { guid, progress: Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0 };
}
