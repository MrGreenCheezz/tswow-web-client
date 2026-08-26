// Where somebody standing on a boat actually is.
//
// A passenger's position reaches the client twice over: as a world position the server has already
// composed, and as an offset in the transport's own frame. The world one is enough to draw the
// passenger the instant the packet lands — and it is wrong a moment later, because the ship keeps
// moving and nothing else is ever sent. `Transport::UpdatePassengerPositions`
// (`Transport.cpp:693-747`) relocates every passenger with no network output at all, and
// `Transport::UpdatePosition` sends nothing for the ship either. A client that only reacts to
// packets is therefore guaranteed to leave passengers standing in mid-air over the water where the
// ship used to be. Keeping the offset is what lets it carry them.
//
// The transform is the server's own, `TransportBase::CalculatePassengerPosition`,
// `VehicleDefines.h:140-149`. It is a single yaw about the vertical and nothing else: a boat
// pitching in a swell does not tilt the people on it, and z is a pure addition.

import type { WorldPosition } from "./WorldState.js";

export interface TransportSeat {
  guid: bigint;
  /** Where the passenger sits in the transport's frame. */
  x: number;
  y: number;
  z: number;
  /** Its facing relative to the transport's, which adds to the transport's own. */
  orientation: number;
  seat: number;
}

/**
 * Offset in the transport's frame to a position in the world.
 *
 * Rotate, then translate — the other order throws the passenger across the map. The two easy
 * errors here are both silent: the server's own coordinate sanity check adds the two positions
 * componentwise (`MovementHandler.cpp:317`), which is a range guard rather than the transform and
 * is right only while the ship happens to face zero; and the ship's heading is
 * `atan2(dir.y, dir.x) + π` (`Transport.cpp:215`), because transport models face backwards along
 * their path — omitting that π reflects every passenger through the ship's centre, bow for stern.
 */
export function composePassengerPosition(transport: WorldPosition, offset: TransportSeat): WorldPosition {
  const cos = Math.cos(transport.orientation);
  const sin = Math.sin(transport.orientation);
  return {
    x: transport.x + offset.x * cos - offset.y * sin,
    y: transport.y + offset.x * sin + offset.y * cos,
    z: transport.z + offset.z,
    orientation: normalizeOrientation(transport.orientation + offset.orientation),
  };
}

/**
 * World position back to an offset in the transport's frame.
 *
 * The core writes this one with tangents (`VehicleDefines.h:151-162`), which is undefined at a
 * heading of due north or due south — a zeppelin flying either way. It is algebraically the
 * transpose of the rotation above, so that is what it is written as.
 */
export function passengerOffset(transport: WorldPosition, world: WorldPosition): Omit<TransportSeat, "guid" | "seat"> {
  const cos = Math.cos(transport.orientation);
  const sin = Math.sin(transport.orientation);
  const dx = world.x - transport.x;
  const dy = world.y - transport.y;
  return {
    x: dx * cos + dy * sin,
    y: dy * cos - dx * sin,
    z: world.z - transport.z,
    orientation: normalizeOrientation(world.orientation - transport.orientation),
  };
}

/** `Position::NormalizeOrientation`: back into [0, 2π), which is the range the server keeps. */
export function normalizeOrientation(radians: number): number {
  const turn = Math.PI * 2;
  const wrapped = radians % turn;
  return wrapped < 0 ? wrapped + turn : wrapped;
}
