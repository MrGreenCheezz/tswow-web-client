import { OPCODES } from "../../generated/opcodes.js";
import { MOVEMENT_FLAGS, type MovementInfo } from "../../world/MovementProtocol.js";
import { normalizeOrientation, type TransportSeat } from "../../world/TransportMath.js";
import { seatedMovementInfo, unitSeat } from "../../world/UnitSeat.js";
import type { VehicleCatalog } from "../../world/VehicleDbc.js";
import { VEHICLE_SEAT_FLAGS, isVehicleCarrierGuid } from "../../world/VehicleSeatModel.js";
import { serverControlsMovement, type WorldObjectState } from "../../world/WorldState.js";
import { vehicleCatalog } from "../VehicleClient.js";
import { moverObject, moverState, type MoverWorld } from "./Mover.js";
import { MOVEMENT_FLAGS2, clampVehicleFacing, moverVehicleRules } from "./VehicleMovementFlags.js";

/**
 * 11.02-input: turning (and pitching) the unit the keys move while it sits in a vehicle seat — a character in
 * a passenger seat with ALLOW_TURNING, or a controlled turret accessory seated on its base (turret 116 in
 * slot 7 of siege engine 117, seat 1652 = 0x03006408). Mover.ts holds every seated mover (no physics, no
 * `MSG_MOVE_*`, 11.02-A); this lets the one whose seat allows it turn on the seat, and sends what Wow.exe
 * sends, always with the transport block the core places it from.
 *
 * Wow.exe 3.3.5a 12340 (Ghidra, read-only; .runtime/re-2026-10-03/l1102input/r1-r3.c, l1102gf3/r2.c, r4.c,
 * l1102bcd/r1.c):
 *
 * - The gate. The input dispatcher 0x005fbbc0 runs the turn keys (0x005fb0b0) — and, for a mover swimming,
 *   flying or with MovementFlags2 ALWAYS_ALLOW_PITCHING, the pitch keys (0x005fb1a0) — only when 0x005fa0d0
 *   says the mover may turn: it may act (0x005fa060), is not UNIT_FLAG_STUNNED, and 0x0074b900 is 0.
 *   0x0074b900 is 1 exactly when the mover's transport guid names a vehicle (HighGuid::Vehicle or a player),
 *   that unit is in view with a vehicle kit (+0xf5c) and the kit's seat in the mover's slot (0x00756ec0 over
 *   the seat byte +0x7d2) lacks VehicleSeat Flags 0x400 ALLOW_TURNING. The camera steer (0x005fa110) asks the
 *   same. Forward, strafe and jump are refused to a mover seated on a vehicle (0x005fac90 → 0x0074b8b0).
 * - What goes out. The movement events queue (0x006ef860) keeps, for a unit on a transport and rooted, the
 *   turn events 0xb/0xc → MSG_MOVE_START_TURN_LEFT/RIGHT, 0xd → STOP_TURN, the pitch events 0xe/0xf/0x10 →
 *   START_PITCH_UP/DOWN, STOP_PITCH, 0x13 → SET_FACING, 0x14 → SET_PITCH (0x006e9380); it drops forward,
 *   strafe and jump. The sender 0x007413f0 sends no pitch opcode (START/STOP_PITCH, SET_PITCH) for a mover
 *   neither swimming, flying nor ALWAYS_ALLOW_PITCHING; for a mover with FULL_SPEED_TURNING (MovementFlags2
 *   0x8) a START_TURN is kept back and its STOP becomes SET_FACING (0x007219f0), with FULL_SPEED_PITCHING
 *   (0x10) a START_PITCH is kept back and its STOP becomes SET_PITCH (0x00721ac0); SET_FACING and SET_PITCH
 *   are skipped while neither the facing nor (for a pitching mover) the pitch moved 0.1 (float 0x00a349f0)
 *   since the last packet (0x0071ae80). No heartbeat is scheduled for turning alone (0x006ef860 schedules
 *   one for MovementFlags 0xc0100f). The packet is the unit's MovementInfo (0x004f4ed0): the transport block
 *   — packed guid, offset x/y/z/o, time, seat — whenever the unit rides one.
 * - The core (MovementHandler.cpp:378-394) takes that MovementInfo whole (`m_movementInfo = movementInfo`),
 *   turns a passenger of an ALLOW_TURNING seat at once (`SetOrientation`), and `Vehicle::RelocatePassengers`
 *   (Vehicle.cpp:621-644) places every passenger from `transport.pos`, its orientation included — so the
 *   block carries the seat offset as the core holds it and the facing relative to the vehicle.
 *
 * Here: the turn keys turn the seat's facing at the mover's turn rate; the mouse turns it (Movement's
 * `turnCharacterBy`) and SET_FACING follows by 0x0071ae80's rule, with one more at the end of the drag;
 * the turret's pitch keys, aim and steer move its pitch (Movement's `updateCharacterPitch`) and SET_PITCH
 * follows by the same rule. A FIXED_POSITION mover keeps its facing limits around the create block's
 * orientation, which for a unit on a transport is the transport offset's (Object.cpp:463-467). Wow.exe turns
 * a FULL_SPEED mover toward a mouse facing at its turn rate (0x006ef6a0: START plus a timed STOP); here the
 * mouse facing is taken at once, as it is for every mover on foot.
 *
 * Not turned (held as before): a seat whose row lacks ALLOW_TURNING; a seat on a carrier that is not a
 * vehicle, or out of view; a seat with no row, or no tables at all — where Wow.exe would let it turn (0x0074b900
 * answers 0 without a row), this client knows nothing of the seat and keeps 11.02-A's silence; a mover on a
 * server spline (the boarding glide), stunned, or under far sight's held body.
 */

/** The parts of `WorldClient` the module reads and sends through. */
export interface SeatedTurnWorld extends MoverWorld {
  readonly movementReady?: boolean;
  sendSeatedMovement?(guid: bigint, opcode: number, info: MovementInfo): boolean;
}

/** 0x00a349f0: what the facing or the pitch must have moved by for SET_FACING / SET_PITCH (0x0071ae80). */
export const SEATED_FACING_EPSILON = Math.fround(0.1);

/** The seat decision, kept while the transport block, the carrier's kit and the tables stay the same. */
const CACHE = {
  seat: undefined as TransportSeat | undefined,
  guid: 0n,
  slot: -1,
  kit: undefined as number | undefined,
  catalog: undefined as VehicleCatalog | undefined,
  allowed: false,
};

/** 0x005fa0d0's seat half: the seat row of the mover's slot has ALLOW_TURNING (see the head for what is held). */
export function seatAllowsTurning(catalog: VehicleCatalog, objects: ReadonlyMap<bigint, WorldObjectState>,
  seat: TransportSeat): boolean {
  const carrier = objects.get(seat.guid);
  if (carrier === undefined) return false;
  if (CACHE.seat === seat && CACHE.guid === seat.guid && CACHE.slot === seat.seat && CACHE.kit === carrier.vehicleId
    && CACHE.catalog === catalog) return CACHE.allowed;
  const row = isVehicleCarrierGuid(seat.guid) ? catalog.seatInSlot(carrier.vehicleId, seat.seat) : undefined;
  CACHE.seat = seat;
  CACHE.guid = seat.guid;
  CACHE.slot = seat.seat;
  CACHE.kit = carrier.vehicleId;
  CACHE.catalog = catalog;
  CACHE.allowed = row !== undefined && (row.flags & VEHICLE_SEAT_FLAGS.ALLOW_TURNING) !== 0;
  return CACHE.allowed;
}

/** The mover, when it sits in a seat that lets it turn and the server is not moving it; else undefined. */
export function seatedTurner(world: MoverWorld | undefined,
  catalog: VehicleCatalog | undefined = vehicleCatalog()): WorldObjectState | undefined {
  if (world === undefined || catalog === undefined) return undefined;
  const mover = moverObject(world);
  if (mover === undefined || serverControlsMovement(mover)) return undefined;
  const seat = unitSeat(world.state.objects, mover);
  return seat !== undefined && seatAllowsTurning(catalog, world.state.objects, seat) ? mover : undefined;
}

/** What was last sent for the seated mover; reset when the mover changes or leaves its seat. */
const SENT = {
  guid: undefined as bigint | undefined,
  turn: 0,
  pitchKey: 0,
  /** FULL_SPEED: a START kept back (0x007219f0 / 0x00721ac0). */
  pendingTurn: false,
  pendingPitch: false,
  /** The local facing and the pitch of the last packet (0x0071ae80's unit+0xa50/+0xa54). */
  facing: 0,
  pitch: 0,
};

/** Forgets the seated mover's packets (a new world, the seat left, tests). */
export function forgetSeatedTurn(): void {
  SENT.guid = undefined;
  SENT.turn = 0;
  SENT.pitchKey = 0;
  SENT.pendingTurn = false;
  SENT.pendingPitch = false;
  SENT.facing = 0;
  SENT.pitch = 0;
  CACHE.seat = undefined;
  CACHE.catalog = undefined;
}

/** The seated mover now: its seat, rules and the bookkeeping bound to it; undefined when there is none. */
function seated(world: SeatedTurnWorld | undefined, catalog: VehicleCatalog | undefined, pitch: number):
  { mover: WorldObjectState; seat: TransportSeat; flags2: number } | undefined {
  const mover = seatedTurner(world, catalog);
  if (mover === undefined || world === undefined) {
    if (SENT.guid !== undefined) forgetSeatedTurn();
    return undefined;
  }
  const seat = mover.transport!;
  if (SENT.guid !== mover.guid) {
    SENT.guid = mover.guid;
    SENT.turn = 0;
    SENT.pitchKey = 0;
    SENT.pendingTurn = false;
    SENT.pendingPitch = false;
    SENT.facing = seat.orientation;
    SENT.pitch = pitch;
  }
  RESULT.mover = mover;
  RESULT.seat = seat;
  RESULT.flags2 = moverVehicleRules(world, catalog)?.flags2 ?? 0;
  return RESULT;
}
const RESULT = { mover: undefined as unknown as WorldObjectState, seat: undefined as unknown as TransportSeat, flags2: 0 };

/** ALWAYS_ALLOW_PITCHING: the only way a seated mover's pitch opcodes go out (0x007413f0). */
function pitches(flags2: number): boolean {
  return (flags2 & MOVEMENT_FLAGS2.ALWAYS_ALLOW_PITCHING) !== 0;
}

/** 0x0071ae80: the facing, or a pitching mover's pitch, moved 0.1 since the last packet. */
function movedSinceSent(seat: TransportSeat, pitch: number, flags2: number): boolean {
  if (Math.abs(Math.fround(seat.orientation) - Math.fround(SENT.facing)) >= SEATED_FACING_EPSILON) return true;
  return pitches(flags2) && Math.abs(Math.fround(pitch) - Math.fround(SENT.pitch)) >= SEATED_FACING_EPSILON;
}

/** The seated mover's MovementInfo now: the seat as the core holds it, the facing on it, the keys held. */
function seatedInfo(world: SeatedTurnWorld, mover: WorldObjectState, seat: TransportSeat, flags2: number,
  turn: number, pitchKey: number, pitch: number): MovementInfo {
  const info = seatedMovementInfo(mover, seat, moverState(world).rooted, Math.trunc(performance.now()) >>> 0);
  if (turn > 0) info.flags |= MOVEMENT_FLAGS.turnLeft;
  else if (turn < 0) info.flags |= MOVEMENT_FLAGS.turnRight;
  if (pitches(flags2)) {
    if (pitchKey > 0) info.flags |= MOVEMENT_FLAGS.pitchUp;
    else if (pitchKey < 0) info.flags |= MOVEMENT_FLAGS.pitchDown;
    info.pitch = pitch;
  }
  info.flags2 = flags2;
  return info;
}

function send(world: SeatedTurnWorld, opcode: number, mover: WorldObjectState, seat: TransportSeat, flags2: number,
  turn: number, pitchKey: number, pitch: number): void {
  const info = seatedInfo(world, mover, seat, flags2, turn, pitchKey, pitch);
  if (world.sendSeatedMovement?.(mover.guid, opcode, info) !== true) return;
  SENT.facing = seat.orientation;
  SENT.pitch = pitch;
}

/**
 * The seat's facing turned by `radians`: the transport offset's orientation the core relocates the mover
 * from, and the drawn facing over the carrier's (`WorldState` carries the passenger the same way).
 */
function turnSeat(world: SeatedTurnWorld, catalog: VehicleCatalog | undefined, mover: WorldObjectState,
  seat: TransportSeat, radians: number): void {
  let local = normalizeOrientation(seat.orientation + radians);
  const rules = moverVehicleRules(world, catalog);
  if (rules?.fixedPosition && mover.vehicleOrientation !== undefined) {
    local = normalizeOrientation(clampVehicleFacing(rules, mover.vehicleOrientation, local));
  }
  seat.orientation = local;
  const carrier = world.state.objects.get(seat.guid)?.position;
  if (carrier !== undefined && mover.position !== undefined) {
    mover.position.orientation = normalizeOrientation(carrier.orientation + local);
  }
}

/**
 * The key axes' edges (Movement's `syncMovement` for a seated mover): START/STOP_TURN, START/STOP_PITCH, or
 * for a FULL_SPEED mover nothing at the start and SET_FACING / SET_PITCH at the stop. False — nothing done —
 * when the mover is not a seated turner.
 */
export function seatedTurnSync(world: SeatedTurnWorld | undefined, turn: number, pitchKey: number, pitch: number,
  catalog: VehicleCatalog | undefined = vehicleCatalog()): boolean {
  const now = seated(world, catalog, pitch);
  if (now === undefined || world === undefined) return false;
  const { mover, seat, flags2 } = now;
  if (turn !== SENT.turn) {
    const fullSpeed = (flags2 & MOVEMENT_FLAGS2.FULL_SPEED_TURNING) !== 0;
    SENT.turn = turn;
    if (turn !== 0) {
      if (fullSpeed) SENT.pendingTurn = true;
      else send(world, turn > 0 ? OPCODES.MSG_MOVE_START_TURN_LEFT : OPCODES.MSG_MOVE_START_TURN_RIGHT, mover, seat, flags2, turn, pitchKey, pitch);
    } else if (fullSpeed && SENT.pendingTurn) {
      SENT.pendingTurn = false;
      if (movedSinceSent(seat, pitch, flags2)) send(world, OPCODES.MSG_MOVE_SET_FACING, mover, seat, flags2, 0, pitchKey, pitch);
    } else send(world, OPCODES.MSG_MOVE_STOP_TURN, mover, seat, flags2, 0, pitchKey, pitch);
  }
  if (pitchKey !== SENT.pitchKey) {
    const fullSpeed = (flags2 & MOVEMENT_FLAGS2.FULL_SPEED_PITCHING) !== 0;
    SENT.pitchKey = pitchKey;
    if (!pitches(flags2)) return true;
    if (pitchKey !== 0) {
      if (fullSpeed) SENT.pendingPitch = true;
      else send(world, pitchKey > 0 ? OPCODES.MSG_MOVE_START_PITCH_UP : OPCODES.MSG_MOVE_START_PITCH_DOWN, mover, seat, flags2, turn, pitchKey, pitch);
    } else if (fullSpeed && SENT.pendingPitch) {
      SENT.pendingPitch = false;
      if (movedSinceSent(seat, pitch, flags2)) send(world, OPCODES.MSG_MOVE_SET_PITCH, mover, seat, flags2, turn, 0, pitch);
    } else send(world, OPCODES.MSG_MOVE_STOP_PITCH, mover, seat, flags2, turn, 0, pitch);
  }
  return true;
}

/**
 * One frame of a seated mover: the turn keys turn the seat's facing at `turnRate`, the edges go out, and a
 * pitch moved by something other than the keys (VehicleAim*, the steer) goes out as SET_PITCH once it moved
 * 0.1. False when the mover is not a seated turner (nothing touched).
 */
export function seatedTurnFrame(world: SeatedTurnWorld | undefined, turn: number, pitchKey: number, pitch: number,
  turnRate: number, dt: number, catalog: VehicleCatalog | undefined = vehicleCatalog()): boolean {
  const now = seated(world, catalog, pitch);
  if (now === undefined || world === undefined) return false;
  const { mover, seat } = now;
  if (turn !== 0 && dt > 0 && Number.isFinite(turnRate)) turnSeat(world, catalog, mover, seat, turn * turnRate * dt);
  seatedTurnSync(world, turn, pitchKey, pitch, catalog);
  const after = seated(world, catalog, pitch);
  if (after !== undefined && pitchKey === 0 && pitches(after.flags2)
    && Math.abs(Math.fround(pitch) - Math.fround(SENT.pitch)) >= SEATED_FACING_EPSILON) {
    send(world, OPCODES.MSG_MOVE_SET_PITCH, after.mover, after.seat, after.flags2, turn, 0, pitch);
  }
  return true;
}

/** The mouse (Movement's `turnCharacterBy`): the seat's facing turned, SET_FACING by 0x0071ae80. False when not seated so. */
export function seatedTurnBy(world: SeatedTurnWorld | undefined, radians: number, pitch: number,
  catalog: VehicleCatalog | undefined = vehicleCatalog()): boolean {
  const now = seated(world, catalog, pitch);
  if (now === undefined || world === undefined) return false;
  const { mover, seat, flags2 } = now;
  if (radians !== 0 && Number.isFinite(radians)) turnSeat(world, catalog, mover, seat, radians);
  if (movedSinceSent(seat, pitch, flags2)) send(world, OPCODES.MSG_MOVE_SET_FACING, mover, seat, flags2, SENT.turn, SENT.pitchKey, pitch);
  return true;
}

/** The end of a mouse turn (Movement's `flushFacing`): SET_FACING when the facing moved at all since the last packet. */
export function seatedFlushFacing(world: SeatedTurnWorld | undefined, pitch: number,
  catalog: VehicleCatalog | undefined = vehicleCatalog()): boolean {
  const now = seated(world, catalog, pitch);
  if (now === undefined || world === undefined) return false;
  const { mover, seat, flags2 } = now;
  if (Math.fround(seat.orientation) !== Math.fround(SENT.facing)) {
    send(world, OPCODES.MSG_MOVE_SET_FACING, mover, seat, flags2, SENT.turn, SENT.pitchKey, pitch);
  }
  return true;
}

/** An acknowledgement's MovementInfo for the seated mover (Movement's `moverSnapshot`); undefined when not seated so. */
export function seatedTurnSnapshot(world: SeatedTurnWorld | undefined, guid: bigint, pitch: number,
  catalog: VehicleCatalog | undefined = vehicleCatalog()): MovementInfo | undefined {
  const mover = seatedTurner(world, catalog);
  if (mover === undefined || world === undefined || mover.guid !== guid || mover.transport === undefined) return undefined;
  const flags2 = moverVehicleRules(world, catalog)?.flags2 ?? 0;
  return seatedInfo(world, mover, mover.transport, flags2, SENT.guid === guid ? SENT.turn : 0,
    SENT.guid === guid ? SENT.pitchKey : 0, pitch);
}
