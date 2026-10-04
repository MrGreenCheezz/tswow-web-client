import { MOVEMENT_FLAGS, MOVEMENT_MASK_MOVING, type MovementInfo } from "./MovementProtocol.js";
import type { TransportSeat } from "./TransportMath.js";
import type { WorldObjectState } from "./WorldState.js";

/**
 * 11.02-A: a seat in a vehicle — a transport block that names a unit (a creature vehicle or a
 * player with a vehicle kit), not a ship or a lift.
 *
 * TrinityCore keeps a passenger's seat in its own `m_movementInfo.transport`: `VehicleJoinEvent::
 * Execute` writes the seat's `AttachmentOffset`, the index 0…7 and the vehicle's guid there
 * (Vehicle.cpp:936-945), and `Vehicle::RelocatePassengers` places the passenger from that offset
 * every time the vehicle moves (Vehicle.cpp:621-644). A `MSG_MOVE_*` the passenger sends is taken
 * whenever the passenger is still the active mover (a seat without `CAN_CONTROL`) and overwrites
 * that record wholesale (`mover->m_movementInfo = movementInfo`, MovementHandler.cpp:378); a speed
 * ACK does the same (:549-550). So a seated character sends no movement of its own, and any ACK it
 * owes carries the seat back as the server holds it.
 */

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;

/** The seat `object` holds in a unit in view, or undefined (no seat, a ship, a lift, a carrier out of view). */
export function unitSeat(objects: ReadonlyMap<bigint, WorldObjectState>,
  object: WorldObjectState | undefined): TransportSeat | undefined {
  const seat = object?.transport;
  if (seat === undefined) return undefined;
  const carrier = objects.get(seat.guid);
  return carrier !== undefined && (carrier.typeId === TYPEID_UNIT || carrier.typeId === TYPEID_PLAYER) ? seat : undefined;
}

/**
 * What a seated passenger is doing, as the server set it: `SetRooted(true)` clears
 * `MOVEMENTFLAG_MASK_MOVING` and raises ROOT (Unit.cpp:12302-12303) right after
 * `AddUnitMovementFlag(MOVEMENTFLAG_ONTRANSPORT)` (Vehicle.cpp:944, 969). Turning and pitching keys
 * and swimming/flying go too — a passenger does neither — and ROOT stays only while the server's
 * root holds (`SMSG_FORCE_MOVE_ROOT`/`UNROOT`).
 */
const SEATED_DROPPED = MOVEMENT_MASK_MOVING | MOVEMENT_FLAGS.turnLeft | MOVEMENT_FLAGS.turnRight
  | MOVEMENT_FLAGS.pitchUp | MOVEMENT_FLAGS.pitchDown | MOVEMENT_FLAGS.swimming | MOVEMENT_FLAGS.flying
  | MOVEMENT_FLAGS.root | MOVEMENT_FLAGS.splineEnabled;

/** The MovementInfo of a seated passenger, for the acknowledgements it still owes the server. */
export function seatedMovementInfo(object: WorldObjectState, seat: TransportSeat, rooted: boolean,
  time: number): MovementInfo {
  const position = object.position ?? { x: 0, y: 0, z: 0, orientation: 0 };
  let flags = (object.movementFlags & ~SEATED_DROPPED) | MOVEMENT_FLAGS.onTransport;
  if (rooted) flags |= MOVEMENT_FLAGS.root;
  return {
    flags,
    flags2: 0,
    time,
    position,
    transport: { guid: seat.guid, x: seat.x, y: seat.y, z: seat.z, orientation: seat.orientation, time, seat: seat.seat },
    fallTime: 0,
  };
}
