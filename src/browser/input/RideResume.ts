import type { TransportSeat } from "../../world/TransportMath.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import { isRideCarrier } from "../game/TransportRide.js";

/**
 * 11.01 slice C: a ride picked up again before the frame that picks it up.
 *
 * The ride's own state (`MovementRide`) is dropped by every reset of the character's motion — the
 * curtain of a worldport (`clearHeldKeys`), a teleport (`TeleportEffects.resetCharacterMotion`) —
 * and is rebuilt from the server's seat at the next physics frame. Packets can go out in between:
 * the keys re-issued after a near teleport (`reissueHeldMovement`), a key pressed under the curtain
 * and sent when it lifts (`hideLoadingScreen` → `syncMovement`), the first frame with control
 * (`advancePhysics` syncs before it steps). The core takes a packet without `ONTRANSPORT` as leaving
 * the ship (MovementHandler.cpp:347-351), and both kinds of voyage end in exactly this gap: the far
 * one with `SMSG_NEW_WORLD` (Player.cpp:1877-1907, the seat kept through `TELE_TO_NOT_LEAVE_TRANSPORT`
 * and the self create of `Map::SendInitSelf`), the near one with `MSG_MOVE_TELEPORT_ACK` to every
 * passenger at a path's teleport frame (Transport.cpp:628-643, `Unit::SendTeleportPacket` with the
 * old offset). So a seat the next frame would ride — on a ship in view — counts as the ride's already.
 */

/** The state's objects as the last ride frame saw them: the same map for the whole world session. */
let objects: ReadonlyMap<bigint, WorldObjectState> | undefined;

export function noteRideObjects(map: ReadonlyMap<bigint, WorldObjectState>): void {
  objects = map;
}

/** A new or retired world session: nothing seen before is evidence any more. */
export function forgetRideObjects(): void {
  objects = undefined;
}

/** The seat when the next ride frame would take it up: a ship in view with a pose. */
export function resumableSeat(seat: TransportSeat | undefined): TransportSeat | undefined {
  if (seat === undefined || objects === undefined) return undefined;
  const carrier = objects.get(seat.guid);
  return isRideCarrier(carrier) && carrier!.position !== undefined ? seat : undefined;
}
