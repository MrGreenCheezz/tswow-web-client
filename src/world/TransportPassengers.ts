// Passengers that are not the character (plan item 11.01, slices D and E).
//
// D — a game object spawned aboard. Its create block has no movement info; `UPDATEFLAG_POSITION`
// carries the transport instead (Object.cpp:347-380): the transport's packed guid (or a zero byte),
// the world position, the offset on the transport, the WORLD orientation and a float that is a
// corpse's orientation and 0 for everything else. The offset's own orientation is not on the wire:
// the core keeps it as the spawn's (`Transport::CreateGOPassenger`, Transport.cpp:363-370) and keeps
// world = carrier + offset (`UpdatePassengerPositions`, Transport.cpp:693-747), so it is the world
// orientation minus the carrier's. Transports are sent map-wide at entry (`Map::SendInitTransports`)
// and on arrival (`Map::AddToMap<Transport>`), before the passengers their grid loads, so the
// carrier is normally known when the passenger's block is read; when it is not, the object stays
// where its block put it, as it did before this slice.
//
// E — somebody else's packet with a transport block. The world position in it was composed when
// it was written and is stale the moment the ship moves on; the offset is what lasts. The short
// glide between two packets therefore runs in the carrier's frame, composed on its pose of each
// frame — a glide between two world points on a moving deck drags the passenger across it.

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { gameObjectTilt, type Quat } from "./GameObjectRotation.js";
import { normalizeOrientation, passengerOffset, type TransportSeat } from "./TransportMath.js";
import type { WorldObjectState, WorldPosition } from "./WorldState.js";

/** `MovementInfo::TransportInfo::seat` of anything that is not in a vehicle seat: `int8 −1`, 0xFF as a byte. */
export const NO_SEAT = 0xff;

const BYTES_1 = UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset;

/**
 * Review C/D/E: whether a carrier is a ship (`GAMEOBJECT_TYPE_MO_TRANSPORT`, byte 1 of BYTES_1),
 * the only carrier the glide of slice E is for. A lift (type 11) also comes with `ONTRANSPORT` from
 * a stock client — the core keeps the flag for it (MovementHandler.cpp:340-345) — but its state
 * position is the spawn, not the car the offset is measured on; a vehicle seat (a unit) is 11.02's.
 */
export function isShipCarrier(object: Pick<WorldObjectState, "typeId" | "fields"> | undefined): boolean {
  return object !== undefined && object.typeId === 5 && ((object.fields.get(BYTES_1) ?? 0) >>> 8 & 0xff) === 15;
}

/** `UPDATEFLAG_POSITION`'s transport part as `readMovement` keeps it. */
export interface PositionTransport {
  guid: bigint;
  x: number;
  y: number;
  z: number;
}

/**
 * The seat of a non-living object created aboard: the block's offset, its facing relative to the
 * carrier's. Undefined without a world position or a carrier in view (nothing to measure against).
 */
export function positionPassengerSeat(transport: PositionTransport, world: WorldPosition | undefined,
  carrier: WorldPosition | undefined): TransportSeat | undefined {
  if (!world || !carrier || !Number.isFinite(world.orientation) || !Number.isFinite(carrier.orientation)) return undefined;
  return {
    guid: transport.guid,
    x: transport.x,
    y: transport.y,
    z: transport.z,
    orientation: normalizeOrientation(world.orientation - carrier.orientation),
    seat: NO_SEAT,
  };
}

/**
 * `gameObjectTilt` for a game object that may be aboard. The local rotation of a passenger is the
 * spawn's in the carrier's frame (`CreateGOPassenger` → `LoadFromDB` → `Create(…, data->rotation)`),
 * whose yaw is the seat's facing, not the world's: measured against the world facing it reads as
 * a turn by minus the carrier's heading, and the object would be drawn facing its spawn yaw on a
 * ship pointing anywhere. Measured against the seat's facing it is the lean alone, which turns with
 * the carrier (its axis rotated by the carrier's heading). Off a transport this is `gameObjectTilt`.
 */
export function passengerGameObjectTilt(object: Pick<WorldObjectState, "rotation" | "fields" | "transport">,
  orientation: number, out: Quat): boolean {
  const seat = object.transport;
  if (seat === undefined) return gameObjectTilt(object, orientation, out);
  if (!gameObjectTilt(object, seat.orientation, out)) return false;
  // Conjugating by the carrier's yaw turns the vector part about z; w is unchanged.
  const heading = orientation - seat.orientation;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const x = out.x;
  out.x = x * cos - out.y * sin;
  out.y = x * sin + out.y * cos;
  return true;
}

/**
 * The glide of a passenger between where it was drawn and where its packet put it, in the
 * carrier's frame: `from` is the drawn position at the packet's arrival, measured on the carrier's
 * pose of that moment; `to` the packet's offset.
 */
export interface CarrierGlide {
  carrier: bigint;
  fromX: number;
  fromY: number;
  fromZ: number;
  fromOrientation: number;
  toX: number;
  toY: number;
  toZ: number;
  toOrientation: number;
  startedAt: number;
  duration: number;
}

/**
 * Starts the glide to `seat` from `drawn`, or undefined when there is nothing to glide: no drawn
 * position, no carrier pose, or a step longer than `snapDistance` in the carrier's frame (a
 * teleport onto the deck, a first sight).
 */
export function startCarrierGlide(drawn: WorldPosition | undefined, carrier: WorldPosition | undefined,
  seat: TransportSeat, now: number, duration: number, snapDistance: number): CarrierGlide | undefined {
  if (!drawn || !carrier) return undefined;
  const from = passengerOffset(carrier, drawn);
  if (Math.hypot(seat.x - from.x, seat.y - from.y, seat.z - from.z) > snapDistance) return undefined;
  return {
    carrier: seat.guid,
    fromX: from.x, fromY: from.y, fromZ: from.z, fromOrientation: from.orientation,
    toX: seat.x, toY: seat.y, toZ: seat.z, toOrientation: seat.orientation,
    startedAt: now, duration,
  };
}

/**
 * One frame of the glide on the carrier's pose of this frame, written into `out`. Returns false
 * once it has arrived (the carry alone holds the passenger from then on). Allocates nothing.
 */
export function sampleCarrierGlide(glide: CarrierGlide, carrier: WorldPosition, now: number, out: WorldPosition): boolean {
  const progress = Math.min(1, Math.max(0, (now - glide.startedAt) / glide.duration));
  const x = glide.fromX + (glide.toX - glide.fromX) * progress;
  const y = glide.fromY + (glide.toY - glide.fromY) * progress;
  const turn = Math.PI * 2;
  let delta = (glide.toOrientation - glide.fromOrientation) % turn;
  if (delta > Math.PI) delta -= turn;
  else if (delta < -Math.PI) delta += turn;
  const cos = Math.cos(carrier.orientation);
  const sin = Math.sin(carrier.orientation);
  out.x = carrier.x + x * cos - y * sin;
  out.y = carrier.y + x * sin + y * cos;
  out.z = carrier.z + glide.fromZ + (glide.toZ - glide.fromZ) * progress;
  out.orientation = normalizeOrientation(carrier.orientation + glide.fromOrientation + delta * progress);
  return progress < 1;
}
