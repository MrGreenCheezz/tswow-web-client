import type { ForcedSpeedName } from "../../world/MovementAckProtocol.js";
import { MOVEMENT_FLAGS } from "../../world/MovementProtocol.js";
import { newMoverMovementState, type MoverMovementState } from "../../world/MoverStates.js";
import { composePassengerPosition } from "../../world/TransportMath.js";
import { unitSeat } from "../../world/UnitSeat.js";
import { serverControlsMovement, type WorldObjectState } from "../../world/WorldState.js";

/**
 * 11.02-A (M7-1): which unit the movement keys move — the character, or the unit the server handed
 * over with `SMSG_CLIENT_CONTROL_UPDATE(guid, 1)` (a vehicle's driving seat, a possessed creature).
 *
 * The core takes `MSG_MOVE_*` only from the active mover (`WorldSession::IsRightUnitBeingMoved`,
 * WorldSession.cpp:1784-1806) and moves that unit by it (`mover->UpdatePosition`,
 * MovementHandler.cpp:397); the character in the driving seat is carried by `Vehicle::
 * RelocatePassengers` (Vehicle.cpp:621-644). So the physics steps the controlled unit with its own
 * speeds, toggles, radius and collision height, packets carry its guid, and the character follows
 * it through its seat. A character seated without control (a passenger seat) moves nothing.
 *
 * Without a controlled unit other than the character, every function here answers with exactly the
 * character's own objects (`movementState`, `speeds`) — the path the client always took.
 */

/** The parts of `WorldClient` read here; the tests' stand-ins carry only the character's half. */
export interface MoverWorld {
  readonly state: { readonly selfGuid: bigint | undefined; readonly objects: ReadonlyMap<bigint, WorldObjectState> };
  readonly controlledGuid?: bigint | undefined;
  readonly movementState: MoverMovementState;
  readonly speeds: Map<ForcedSpeedName, number>;
  movementStateOf?(guid: bigint): MoverMovementState;
  speedsOf?(guid: bigint): Map<ForcedSpeedName, number>;
}

/** The guid of the controlled unit when it is not the character, else undefined. */
export function otherMoverGuid(world: MoverWorld | undefined): bigint | undefined {
  const controlled = world?.controlledGuid;
  return controlled === undefined || controlled === world!.state.selfGuid ? undefined : controlled;
}

/** The guid packets are sent for: the controlled unit, else the character. */
export function moverGuid(world: MoverWorld): bigint | undefined {
  return otherMoverGuid(world) ?? world.state.selfGuid;
}

/** The unit the keys move; undefined while the controlled unit is out of view. */
export function moverObject(world: MoverWorld | undefined): WorldObjectState | undefined {
  if (!world) return undefined;
  const guid = moverGuid(world);
  return guid === undefined ? undefined : world.state.objects.get(guid);
}

/**
 * Whether the keys move nothing right now: the server is moving the mover (a spline, a taxi), the
 * controlled unit is out of view, or the mover sits in a vehicle seat — the character in a seat it
 * does not drive, or a controlled unit that is itself a passenger (a turret accessory on its base,
 * e.g. a siege engine's gun). A seated unit's `MSG_MOVE_*` overwrites the seat the core places it
 * from (`m_movementInfo = movementInfo`, MovementHandler.cpp:378; `Vehicle::RelocatePassengers`
 * reads `m_movementInfo.transport.pos`, Vehicle.cpp:633-636); turning in a seat is slice F.
 */
export function moverHeld(world: MoverWorld, self: WorldObjectState | undefined): boolean {
  const other = otherMoverGuid(world);
  if (other === undefined) return serverControlsMovement(self) || unitSeat(world.state.objects, self) !== undefined;
  const mover = world.state.objects.get(other);
  return mover === undefined || serverControlsMovement(mover) || unitSeat(world.state.objects, mover) !== undefined;
}

/** Filled in place for a controlled unit: its toggles and the server's spline root on it. */
const OTHER_STATE: MoverMovementState = newMoverMovementState();

/**
 * The mover's toggles. A creature gets its root, flight, gravity, hover, water walking and feather
 * fall as `SMSG_SPLINE_MOVE_*` even while a client moves it — `Unit::SetRooted` (Unit.cpp:12306-12318)
 * and `Creature::SetDisableGravity/SetCanFly/SetWaterWalking/SetFeatherFall/SetHover`
 * (Creature.cpp:3272-3373) never send the FORCE/ACK packets a player gets — and its CREATE block
 * carries the state it already has (a cannon's ROOT, a drake's CAN_FLY). Those bits sit in its
 * movement flags (`WorldState.applyMovementFlag`), and the packets sent for it write them back
 * (`movementFlags()` raises each one this reports), so they count with its FORCE toggles.
 */
export function moverState(world: MoverWorld): MoverMovementState {
  const other = otherMoverGuid(world);
  if (other === undefined || world.movementStateOf === undefined) return world.movementState;
  const own = world.movementStateOf(other);
  const flags = world.state.objects.get(other)?.movementFlags ?? 0;
  OTHER_STATE.rooted = own.rooted || (flags & MOVEMENT_FLAGS.root) !== 0;
  OTHER_STATE.waterWalking = own.waterWalking || (flags & MOVEMENT_FLAGS.waterWalking) !== 0;
  OTHER_STATE.featherFall = own.featherFall || (flags & MOVEMENT_FLAGS.fallingSlow) !== 0;
  OTHER_STATE.hovering = own.hovering || (flags & MOVEMENT_FLAGS.hover) !== 0;
  OTHER_STATE.canFly = own.canFly || (flags & MOVEMENT_FLAGS.canFly) !== 0;
  OTHER_STATE.gravityDisabled = own.gravityDisabled || (flags & MOVEMENT_FLAGS.disableGravity) !== 0;
  OTHER_STATE.collisionHeight = own.collisionHeight;
  return OTHER_STATE;
}

/** The rates the server forced on the mover (the character's are `speeds` itself). */
export function moverSpeeds(world: MoverWorld): Map<ForcedSpeedName, number> {
  const other = otherMoverGuid(world);
  return other === undefined || world.speedsOf === undefined ? world.speeds : world.speedsOf(other);
}

/**
 * The character carried to its seat on the mover's position of this very frame. `WorldState`
 * carries passengers before the physics runs (`updateMotions` → `#carryPassenger`); without this the
 * driver would trail the vehicle by one frame wherever it is drawn and wherever the camera looks.
 */
export function carrySeatedCharacter(objects: ReadonlyMap<bigint, WorldObjectState>, self: WorldObjectState,
  mover: WorldObjectState): void {
  const seat = self.transport;
  const position = self.position;
  const carrier = mover.position;
  if (seat === undefined || position === undefined || carrier === undefined || seat.guid !== mover.guid) return;
  if (unitSeat(objects, self) === undefined) return;
  const world = composePassengerPosition(carrier, seat);
  position.x = world.x;
  position.y = world.y;
  position.z = world.z;
  position.orientation = world.orientation;
}
