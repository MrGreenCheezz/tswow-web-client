/**
 * 6.20 (line A7a, slice G, 05.10): the jump key on a standing ground mount.
 *
 * Wow.exe's jump key (JumpOrAscendStart 0x005fbf80) leaves swimming and flying to their own rise,
 * and an active mover that may fly (CAN_FLY) rises with 0x00718860; everything else goes to
 * 0x0072eb80, which decides between a jump (0x006ecc20) and the mount's trick:
 *  - a jump when the unit has no mount (UNIT_FIELD_MOUNTDISPLAYID < 1), when the mount's
 *    CreatureModelData (CreatureDisplayInfo → ModelID) carries Flags 0x400 — on this dataset and the
 *    visual overlay that is one model, `Creature\MotorcycleVehicle` — when CAN_FLY 0x01000000 is
 *    set, or when it moves (MovementFlags & 0xF) and 0x006e9ad0 says no; 0x006e9ad0 says yes for
 *    DISABLE_GRAVITY 0x400 (and for flags2 0x4 and a transport case this client never sends);
 *  - nothing when it turns on the spot (MovementFlags & 0x30) or stands higher above the ground
 *    than half its collision height (0x00718a20);
 *  - otherwise its own animation first (vtable +0x98, only for the active mover — here always) and
 *    an empty CMSG_MOUNTSPECIAL_ANIM 0x171. The core relays SMSG_MOUNTSPECIAL_ANIM to everyone but
 *    the sender (MovementHandler.cpp:603-609) and checks nothing, so the gate is the client's.
 *
 * Not modelled: the unit word +0xa30 bit 0x10000000 (also "jump"; its meaning is not established)
 * and the half-height test — in the air this client's physics refuses the jump as before, so an
 * airborne rider gets "default", which jumps no more than it did.
 *
 * `/mountspecial` is not this: it is a text emote (EmotesText 366 → Emotes 377, animation 94) and
 * goes out as CMSG_TEXT_EMOTE (Wow.exe DoEmote 0x00500980), as it already did.
 */
import { MOVEMENT_FLAGS } from "../../world/MovementProtocol.js";

export type JumpKeyOutcome = "default" | "mountSpecial" | "none";

const MOVING = MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.backward
  | MOVEMENT_FLAGS.strafeLeft | MOVEMENT_FLAGS.strafeRight;
const TURNING = MOVEMENT_FLAGS.turnLeft | MOVEMENT_FLAGS.turnRight;
const OWN_RISE = MOVEMENT_FLAGS.swimming | MOVEMENT_FLAGS.flying | MOVEMENT_FLAGS.canFly;
const AIRBORNE = MOVEMENT_FLAGS.falling | MOVEMENT_FLAGS.fallingFar;

/**
 * What the jump key does for a mover with this MovementFlags word and mount: "default" leaves it to
 * the jump and rise the client already has.
 */
export function jumpKeyOutcome(flags: number, mountDisplayId: number, mountRefuses: boolean): JumpKeyOutcome {
  if ((flags & OWN_RISE) !== 0 || !(mountDisplayId > 0) || mountRefuses) return "default";
  if ((flags & MOVING) !== 0 && (flags & MOVEMENT_FLAGS.disableGravity) === 0) return "default";
  if ((flags & TURNING) !== 0) return "none";
  if ((flags & AIRBORNE) !== 0) return "default";
  return "mountSpecial";
}

export interface MountSpecialHost {
  /** The mover's MovementFlags word as it would go on the wire now. */
  readonly flags: number;
  readonly mountDisplayId: number;
  /** The mount's CreatureModelData Flags 0x400 (`noMountSpecial` of `/dbc/creature-models`). */
  readonly mountRefuses: boolean;
  /** CMSG_MOUNTSPECIAL_ANIM. */
  send(): void;
  /** The trick on the rider's own mount (the relay never comes back to the sender). */
  play(): void;
}

/** A press the trick (or the turn) took: the held key does not jump until it is released. */
let spent = false;

/** The jump key went down. True when it is spent here and the physics must not jump on it. */
export function mountSpecialJumpPress(host: MountSpecialHost): boolean {
  const outcome = jumpKeyOutcome(host.flags, host.mountDisplayId, host.mountRefuses);
  if (outcome === "default") return false;
  if (outcome === "mountSpecial") {
    host.play();
    host.send();
  }
  spent = true;
  return true;
}

/** The jump key went up (or every key did). */
export function mountSpecialJumpRelease(): void {
  spent = false;
}

export function jumpSpentByMountSpecial(): boolean {
  return spent;
}
