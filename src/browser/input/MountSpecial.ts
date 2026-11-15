/**
 * 6.20 (line A7a, slice G, 05.10): the jump key on a standing ground mount.
 *
 * Wow.exe's jump key (JumpOrAscendStart 0x005fbf80) leaves swimming and flying to their own rise,
 * and an active mover that may fly (CAN_FLY) rises with 0x00718860; everything else goes to
 * 0x0072eb80, which decides between a jump (0x006ecc20) and the mount's trick:
 *  - a jump when the unit has no mount (UNIT_FIELD_MOUNTDISPLAYID < 1), when the mount's
 *    CreatureModelData (CreatureDisplayInfo → ModelID) carries Flags 0x400 — on this dataset and the
 *    visual overlay that is one model, `Creature\MotorcycleVehicle` — when CAN_FLY 0x01000000 is
 *    set, or when it moves (MovementFlags & 0xF) and 0x006e9ad0 says no (`moverAloft`);
 *  - nothing when it turns on the spot (MovementFlags & 0x30) or (0x00718a20) stands in a liquid whose
 *    surface (0x0077f1e0: the unit's liquid state, flag 0x20 and level +0x80) is more than half its height
 *    (unit+0x854 × [0x009e2ec4] = 0.5, read 15.11) over its feet (`underLiquidSurface`);
 *  - otherwise its own animation first (vtable +0x98, only for the active mover — here always) and
 *    an empty CMSG_MOUNTSPECIAL_ANIM 0x171. The core relays SMSG_MOUNTSPECIAL_ANIM to everyone but
 *    the sender (MovementHandler.cpp:603-609) and checks nothing, so the gate is the client's.
 *
 * 11.11: before any of it, the loot is let go (`jumpKeyReleasesLoot`), and FALLING is read nowhere on
 * the way, so a rider in the air holding no direction gets the trick.
 *
 * 15.11 (.runtime/re-2026-11-15/vehicle5/b1.c, b2.c): the unit word +0xa30 bit 0x10000000 (also "jump") is set by the
 * UNIT_FIELD_MOUNTDISPLAYID handlers (0x00740450, 0x007412e0, 0x00741a40) when the field drops to 0 while the unit's
 * vehicle still carries passengers: the dismount waits for them and the old mount id stays at +0x9c0 (0x0073d940 clears
 * it when the mount goes). The field this client reads is already 0 then, so `mountDisplayId < 1` gives the same jump.
 *
 * 0x006e9ad0 (`moverAloft`): with a move spline (+0xbc) not flagged 0x400, its flags 0x200 say no and 0x2000 say yes;
 * otherwise flags2 0x4 or DISABLE_GRAVITY 0x400 say yes. No transport case.
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

/** MoveSplineFlag (MoveSplineFlag.h:35-39): Falling, No_Spline, Flying — the bits 0x006e9ad0 reads. */
export const SPLINE_FLAG_FALLING = 0x200;
export const SPLINE_FLAG_NO_SPLINE = 0x400;
export const SPLINE_FLAG_FLYING = 0x2000;
/** MOVEMENTFLAG2_UNK3 (UnitDefines.h:328), which 0x006e9ad0 reads as aloft. */
export const MOVEMENT_FLAG2_ALOFT = 0x4;

/**
 * 15.11: 0x006e9ad0 — whether a moving mover counts as aloft, which lets the trick through on the move. `splineFlags`:
 * the flags of the move spline it runs (undefined: none).
 */
export function moverAloft(flags: number, flags2: number, splineFlags: number | undefined): boolean {
  if (splineFlags !== undefined && (splineFlags & SPLINE_FLAG_NO_SPLINE) === 0) {
    if ((splineFlags & SPLINE_FLAG_FALLING) !== 0) return false;
    if ((splineFlags & SPLINE_FLAG_FLYING) !== 0) return true;
  }
  return (flags2 & MOVEMENT_FLAG2_ALOFT) !== 0 || (flags & MOVEMENT_FLAGS.disableGravity) !== 0;
}

/** [0x009e2ec4], read 15.11: the share of its height a unit may stand in a liquid and still do the trick. */
export const MOUNT_SPECIAL_LIQUID_SHARE = 0.5;

/**
 * 15.11: 0x00718a20 — a liquid surface (`surface`, undefined when the unit is in none) more than half the unit's height
 * (`height`, unit+0x854) over its feet (`feetZ`). The depth is 0 out of liquid, and the test is strict.
 */
export function underLiquidSurface(surface: number | undefined, feetZ: number, height: number): boolean {
  const depth = surface === undefined ? 0 : surface - feetZ;
  return depth > height * MOUNT_SPECIAL_LIQUID_SHARE;
}

/** What 0x0072eb80 reads besides the movement word and the mount. */
export interface JumpKeyContext {
  /** MovementFlags2 of the mover. */
  readonly flags2?: number;
  /** Its move spline's flags, when it runs one. */
  readonly splineFlags?: number | undefined;
  /** Whether it stands in a liquid deeper than half its height (`underLiquidSurface`). */
  readonly underLiquid?: boolean;
}

/**
 * What the jump key does for a mover with this MovementFlags word and mount: "default" leaves it to
 * the jump and rise the client already has.
 */
export function jumpKeyOutcome(flags: number, mountDisplayId: number, mountRefuses: boolean, context: JumpKeyContext = {}): JumpKeyOutcome {
  if ((flags & OWN_RISE) !== 0 || !(mountDisplayId > 0) || mountRefuses) return "default";
  if ((flags & MOVING) !== 0 && !moverAloft(flags, context.flags2 ?? 0, context.splineFlags)) return "default";
  if ((flags & TURNING) !== 0) return "none";
  if (context.underLiquid === true) return "none"; // 15.11: 0x00718a20
  // 11.11 (6.20): no airborne test — neither JumpOrAscendStart's gates (0x005f9810, 0x0074ba40, 0x005fa9e0,
  // 0x0071b000) nor 0x0072eb80 read FALLING: a rider in the air who holds no direction gets the trick.
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
  /** 11.11 (6.20): a loot window is open (the active player's loot guid, +0x18e0). */
  readonly looting?: boolean;
  /** 11.11 (6.20): CMSG_LOOT_RELEASE and the window closed (0x00523640). */
  releaseLoot?(): void;
  /** 15.11 (6.20): flags2, the move spline, the liquid (0x006e9ad0, 0x00718a20). */
  readonly context?: JumpKeyContext;
}

/**
 * 11.11 (6.20): whether the jump key reaches 0x0072eb80, whose first act — before it decides between the jump and
 * the trick, on foot as well as mounted — is to let go of the loot: for the active player with a loot guid
 * (0x0071b6b0: +0x18e0; another unit's UNIT_FLAG_LOOTING 0x400) it calls 0x00523640(1, 1, 0), the CMSG_LOOT_RELEASE
 * sender. Swimming and flight rise on their own (JumpOrAscendStart 0x005fbf80) and never come here.
 */
export function jumpKeyReleasesLoot(flags: number): boolean {
  return (flags & OWN_RISE) === 0;
}

/** A press the trick (or the turn) took: the held key does not jump until it is released. */
let spent = false;

/** The jump key went down. True when it is spent here and the physics must not jump on it. */
export function mountSpecialJumpPress(host: MountSpecialHost): boolean {
  if (host.looting === true && jumpKeyReleasesLoot(host.flags)) host.releaseLoot?.(); // 11.11 (6.20)
  const outcome = jumpKeyOutcome(host.flags, host.mountDisplayId, host.mountRefuses, host.context);
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
