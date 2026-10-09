import type { KnockBack } from "./MovementAckProtocol.js";

/**
 * The contract between the network half of a knock back (5.01 A, line A4) and the character's
 * physics (5.01 B, line A9: `src/browser/game/Physics.ts`, `src/browser/input/Movement.ts`).
 *
 * `WorldClient` answers `SMSG_MOVE_KNOCK_BACK` on its own — the acknowledgement already says the
 * character is falling, with the server's jump block, because that acknowledgement is what the core
 * relays to everybody else (`HandleMoveKnockBackAck`, MovementHandler.cpp:651-663) — and then calls
 * `onKnockBack(knockBack)`. The browser converts the packet with `knockbackImpulse` and hands the
 * result to the physics, which must:
 *
 * - put the character in the air with `velocityZ = upSpeed` (up positive) and a fall clock of 0;
 * - give it a fixed ground velocity `(cos, sin) · speedXY` in the world frame, which the movement
 *   keys do not steer until it lands, enters water or starts to fly;
 * - keep reporting the fall in its heartbeats with the jump block `knockbackJump` returns — the
 *   wire's sign, `velocity = −upSpeed` — so that the relayed arc does not flip at the first
 *   heartbeat (`Unit.cpp:13237` writes `float(−speedZ)`: on the wire negative is up);
 * - send no packet for the knock back itself: the acknowledgement has gone already.
 */
export interface KnockbackImpulse {
  /** Direction across the ground, world frame: away from the source (`Unit::KnockbackFrom`). */
  cos: number;
  sin: number;
  /** Yards a second across the ground. */
  speedXY: number;
  /** Yards a second upwards at the moment of the knock: positive is up. */
  upSpeed: number;
}

/** The physical reading of `SMSG_MOVE_KNOCK_BACK`, whose vertical speed arrives negated. */
export function knockbackImpulse(knockBack: KnockBack): KnockbackImpulse {
  return {
    cos: knockBack.directionCos,
    sin: knockBack.directionSin,
    speedXY: knockBack.speedXY,
    upSpeed: -knockBack.speedZ,
  };
}

/** The MovementInfo jump block for a fall that began with this impulse, in the wire's sign. */
export function knockbackJump(impulse: KnockbackImpulse): { velocity: number; sinAngle: number; cosAngle: number; speed: number } {
  return { velocity: -impulse.upSpeed, sinAngle: impulse.sin, cosAngle: impulse.cos, speed: impulse.speedXY };
}
