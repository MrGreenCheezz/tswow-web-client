/**
 * 03.11 (6.36): the direction bits of a character in a fall, as Wow.exe puts them on the wire. Measured on the stand
 * (F:\WowOracle\runs\air-control.txt, air-control2.txt): the flight's own bits stay for as long as it lasts, and a key pressed or
 * let go in the air is said by a PENDING bit that the landing turns into the real thing.
 *
 *   W held, jump, W let go       0x1001 → 0x5001 (PENDING_STOP), lands 0x0
 *   W held, jump, S pressed      0x1001 → 0x21001 (PENDING_BACKWARD), lands 0x2
 *   W held, jump, strafe         0x1001 → 0x81001 (PENDING_STRAFE_RIGHT), lands 0x9
 *   standing jump, W             0x1000 → 0x1001, the one key that counts (Physics.latchAirKey)
 */
import { MOVEMENT_FLAGS as F } from "../../world/MovementProtocol.js";
import { AIR_KEY_BACKWARD, AIR_KEY_FORWARD, AIR_KEY_LEFT, AIR_KEY_RIGHT } from "../game/Physics.js";

const DIRECTION_BITS = F.forward | F.backward | F.strafeLeft | F.strafeRight;

/**
 * `flags` with its direction bits replaced by the flight's, `airKeys` being those it took at the takeoff; `forward` and `strafe`
 * are the axes as the keys hold them now.
 */
export function airMovementFlags(flags: number, airKeys: number, forward: number, strafe: number): number {
  let out = flags & ~DIRECTION_BITS;
  if (airKeys & AIR_KEY_FORWARD) out |= F.forward;
  if (airKeys & AIR_KEY_BACKWARD) out |= F.backward;
  if (airKeys & AIR_KEY_LEFT) out |= F.strafeLeft;
  if (airKeys & AIR_KEY_RIGHT) out |= F.strafeRight;
  const flownForward = airKeys & AIR_KEY_FORWARD ? 1 : airKeys & AIR_KEY_BACKWARD ? -1 : 0;
  if (forward !== flownForward) {
    out |= forward > 0 ? F.pendingForward : forward < 0 ? F.pendingBackward : F.pendingStop;
  }
  const flownStrafe = airKeys & AIR_KEY_LEFT ? 1 : airKeys & AIR_KEY_RIGHT ? -1 : 0;
  if (strafe !== flownStrafe) {
    out |= strafe > 0 ? F.pendingStrafeLeft : strafe < 0 ? F.pendingStrafeRight : F.pendingStrafeStop;
  }
  return out;
}
