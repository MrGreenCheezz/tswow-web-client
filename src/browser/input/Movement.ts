import { MOVEMENT_FLAGS, type MovementInfo } from "../../world/MovementProtocol.js";
import type { ForcedSpeedName } from "../../world/MovementAckProtocol.js";
import type { KnockbackImpulse } from "../../world/KnockbackImpulse.js";
import { OPCODES } from "../../generated/opcodes.js";
import { game } from "../game/Context.js";
import { unit } from "../../world/Fields.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";
import type { CollisionFloorHit, CollisionWorld } from "../game/Collision.js";
import { collisionModelLiquidAt, positionLiquid, type WmoLiquidFooting } from "../game/CollisionLiquid.js";
import type { CollisionSource } from "../game/CollisionSource.js";
import type { TerrainClient } from "../Terrain.js";
import {
  CHARACTER_PITCH_LIMIT, DEFAULT_COLLISION_HEIGHT, applyImpulse, FLOOR_SEARCH_DEPTH, LIQUID_UNKNOWN, STEP_HEIGHT, newCharacterMotion,
  stepCharacter,
  type CharacterInput, type CharacterMotion, type LiquidAnswer, type PhysicsEvent, type TerrainProbe,
} from "../game/Physics.js";
import type { InputAction } from "./Bindings.js";
import { heldMovementAction } from "./Bindings.js"; // 11.02-input
import { advanceFollow, cancelFollow, followRunning, forgetFollow } from "./Follow.js";
import { gameObjectColliderFrame, liftCarrying, takeLiftSettled } from "../game/GameObjectColliders.js";
import { farSightHoldsBody, viewIsOut } from "../game/ViewSubject.js"; // 11.02-I
import {
  beginRideFrame, endRideFrame, forgetRide, rideActive, rideCarrierMoving, rideImpulse, rideTransportBlock, rideTurned, stepRideSubstep,
  takeRideFlip, type RideFrameInput,
} from "./MovementRide.js";
import {
  carrySeatedCharacter, moverGuid, moverHeld, moverObject, moverSpeeds, moverState, otherMoverGuid,
} from "./Mover.js";
import { // 11.02-GF3
  clampVehicleFacing, clampVehiclePitch, moverVehicleRules, vehicleAimsWithMouse, vehicleSteerPitchesFromCamera,
} from "./VehicleMovementFlags.js";
import { registerVehicleAimInput } from "../game/VehicleAim.js"; // 11.02-E
import { // 11.02-input
  forgetSeatedTurn, seatedFlushFacing, seatedTurnBy, seatedTurnFrame, seatedTurnSnapshot, seatedTurnSync, seatedTurner,
} from "./SeatedTurn.js";
import "../game/MissileShot.js"; // 11.02-E: registers the trajectory solver WorldClient's casts ask (world/MissileCast.ts)

/**
 * What the character is being asked to do, and the packets that say so.
 *
 * Three axes, not six keys. Forward can be asked for by the key, by autorun or by holding both
 * mouse buttons, and turning becomes strafing while the modifier is down; deriving the axis and
 * then sending the transition is the only shape in which those combine without every source
 * having to know about the others. It is also what the server expects: one start opcode per axis
 * and one stop, not one per key.
 *
 * No DOM and no panels here, so the render loop can import it without dragging the interface in.
 */

/**
 * Speeds the server has not told us yet. `playerBaseMoveSpeed`, `Unit.cpp:112`: every character is
 * created with these and the server only sends a rate when something changes it.
 */
const DEFAULT_WALK_SPEED = 2.5;
const DEFAULT_RUN_SPEED = 7;
const DEFAULT_SWIM_SPEED = 4.722222;
const DEFAULT_FLIGHT_SPEED = 7;
const DEFAULT_TURN_RATE = 3.141594;
/** 5.08/5.09: the rest of `playerBaseMoveSpeed` (`Unit.cpp:112-118`). */
const DEFAULT_RUN_BACK_SPEED = 4.5;
const DEFAULT_SWIM_BACK_SPEED = 2.5;
const DEFAULT_FLIGHT_BACK_SPEED = 4.5;
const DEFAULT_PITCH_RATE = 3.14;
/** `UNIT_FLAG_STUNNED`, `UnitDefines.h:153` (5.11). */
const UNIT_FLAG_STUNNED = 0x00040000;
/**
 * How wide the character is when it has not said.
 *
 * `UNIT_FIELD_BOUNDINGRADIUS` carries the real figure and arrives with the first object update;
 * 0.389 is what a human is created with, and it is only ever used for the frame before that.
 */
const DEFAULT_RADIUS = 0.389;
/**
 * 5.13: a ceiling on the substeps of one frame. With {@link PHYSICS_MAX_FRAME} it bounds the work a
 * long frame costs; `physicsElapsed` shortens the frame instead of letting a substep grow wider
 * than half the body.
 */
export const MAX_SUBSTEPS = 32;
/**
 * 5.13: the longest real time one frame's physics advances. A frame after the tab comes back from
 * the background must not drive the whole way at once; the server catching up is 5.25's business.
 */
export const PHYSICS_MAX_FRAME = 0.5;

/**
 * 5.13: how much of a frame the physics advances: real time, not the 0.1 s the render loop clamps
 * its animations to, but never so much that {@link MAX_SUBSTEPS} substeps would each move the body
 * further than half its radius.
 */
export function physicsElapsed(raw: number, fastestSpeed: number, radius: number): number {
  if (!(raw > 0)) return 0;
  const frame = Math.min(raw, PHYSICS_MAX_FRAME);
  if (!(fastestSpeed > 0) || !(radius > 0)) return frame;
  return Math.min(frame, (MAX_SUBSTEPS * radius * 0.5) / fastestSpeed);
}

/**
 * When the last movement packet went out. A key press starts the clock and the render loop keeps
 * it running, so it is shared rather than owned by either: the server drops a mover that goes
 * quiet, and sending on every frame would be twenty times more traffic than it needs.
 */
export const movementHeartbeat = { sentAt: 0 };
export const MOVEMENT_HEARTBEAT_INTERVAL = 200;

const held = new Set<InputAction>();
/** Autorun and the two-button mouse run are forward asked for by something other than a key. */
let autoRunning = false;
let mouseRunning = false;
let walking = false;

/** The axes as they were last reported to the server, so only changes are sent. */
let sentForward = 0;
let sentStrafe = 0;
let sentTurn = 0;
/** Reconcile held keys when a server root starts or ends between keyboard events. */
let reportedRooted = false;
/** The same for a stun (5.11), which holds the turn as well. */
let reportedStunned = false;
/** Input held through a taxi flight is sent once when the server returns control. */
let wasServerControlled = false;
/** 5.15: whether the last frame already had movement control (held keys are sent on the edge). */
let movementReadyReported = false;
/** 5.09: the pitch axis as last reported (`MSG_MOVE_START_PITCH_UP/DOWN`, `STOP_PITCH`). */
let sentPitchKey = 0;
/**
 * 5.10: the character's own pitch, radians, up positive — what a swimmer or flier goes along. The
 * right-button steer sets it from the camera; the pitch keys turn it at `pitchRate`; otherwise it
 * levels in water and holds in flight. Zero on land.
 */
let characterPitch = 0;
/** 5.10/5.14: the character faces where the camera looks (right button held, or both). */
let steering = false;
/** 11.02-A: the guid the keys moved last frame (the character, or a unit it drives). */
let lastMover: bigint | undefined;

function ownMovementServerControlled(): boolean {
  const state = game.world?.state;
  const guid = state?.selfGuid;
  // 11.02-A: the mover's (Mover.ts) — the character's spline or taxi as before, else a driven
  // vehicle's spline, a controlled unit out of view, or a vehicle seat the character does not drive.
  return guid !== undefined && moverHeld(game.world!, state?.objects.get(guid));
}

export function isAutoRunning(): boolean {
  return autoRunning;
}

export function isWalking(): boolean {
  return walking;
}

/** +1 forward, -1 back, 0 standing. Opposite keys cancel, as they do in the original client. */
export function forwardAxis(): number {
  // 5.18: following runs the character as the forward key would (Follow.ts).
  const forward = held.has("moveForward") || autoRunning || mouseRunning || followRunning();
  const backward = held.has("moveBackward");
  return forward === backward ? 0 : forward ? 1 : -1;
}

/** +1 left, -1 right. */
export function strafeAxis(): number {
  const left = held.has("strafeLeft");
  const right = held.has("strafeRight");
  if (left === right) return 0; // 11.02-GF3: split from the return below.
  // 11.02-GF3: a NO_STRAFE vehicle refuses the strafe (VehicleMovementFlags.ts, Wow.exe 0x00988b00).
  if (moverVehicleRules(game.world)?.noStrafe) return 0;
  return left ? 1 : -1;
}

/** +1 left, -1 right. Turning is a rate, not a displacement: the loop integrates it. */
export function turnAxis(): number {
  const left = held.has("turnLeft");
  const right = held.has("turnRight");
  return left === right ? 0 : left ? 1 : -1;
}

/**
 * 5.09: +1 up, -1 down, while a pitch key is held where pitch means anything — in water or in
 * flight. Both keys at once cancel, which is also what keeps the contradictory flag pair (that
 * `ReadMovementInfo` strips, `WorldSession.cpp:1060`) off the wire.
 */
export function pitchAxis(): number {
  const up = held.has("pitchUp");
  const down = held.has("pitchDown");
  if (up === down || !pitchMatters()) return 0;
  return up ? 1 : -1;
}

/** In water, or in the air with flight or levitation granted: where the character's pitch is on the wire. */
function pitchMatters(): boolean {
  if (pitchAloft()) return true; // 11.02-GF3: the old test, kept whole in `pitchAloft`.
  // 11.02-GF3: and anywhere for a vehicle with ALWAYS_ALLOW_PITCHING (VehicleMovementFlags.ts, Wow.exe 0x005fbbc0).
  return moverVehicleRules(game.world)?.alwaysPitch === true;
}

/** 11.02-GF3: SWIMMING or FLYING — where pitch matters for any mover (the body of `pitchMatters` before). */
function pitchAloft(): boolean {
  if (motion.mode === "swim") return true;
  const state = game.world ? moverState(game.world) : undefined;
  return motion.mode === "air" && (state?.canFly === true || state?.gravityDisabled === true);
}

/** 5.10/5.14: the character looks where the camera looks while the right button (or both) is held. */
export function setSteering(active: boolean): void {
  steering = active;
}

/** 5.10: the character's own pitch, for the renderer and the tests. */
export function characterPitchNow(): number {
  return characterPitch;
}

/** 5.11: `UNIT_FLAG_STUNNED` on the mover. */
function moverStunned(self: WorldObjectState | undefined): boolean {
  const flags = self?.fields.get(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset);
  return flags !== undefined && (flags & UNIT_FLAG_STUNNED) !== 0;
}

/**
 * 5.11: why the character cannot act on its movement keys right now, if it cannot: a stun (no
 * step, turn or jump) or the server moving it (a taxi, fear). Root is not here: a rooted character
 * still turns.
 */
export function movementBlocked(): "stun" | "server" | undefined {
  const state = game.world?.state;
  const self = state?.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
  // 11.02-A: the mover's stun and spline; a vehicle seat without control reads as the server's.
  if (ownMovementServerControlled()) return "server";
  // 11.02-I: far sight proper holds the character's own body as a stun does (ViewSubject.ts,
  // Wow.exe 0x005fa060): no step, turn or jump, and the mouse turns the camera.
  if (farSightHoldsBody(game.world)) return "stun";
  return moverStunned(otherMoverGuid(game.world) === undefined ? self : moverObject(game.world)) ? "stun" : undefined;
}

/**
 * Whether the character is actually going somewhere.
 *
 * Not the same as "the flags word is non-zero": walking is a flag too, and a character standing
 * still in walk mode would otherwise send a heartbeat five times a second forever.
 */
export function isMoving(): boolean {
  if (ownMovementServerControlled()) return false;
  // 11.01-A3: standing on a sailing ship is going somewhere — the core follows a passenger only by
  // the offsets it is sent, and a heartbeat with the block keeps the seat it holds current.
  if (rideCarrierMoving()) return true;
  // 11.01-B: so is standing on a moving lift; its packets carry world coordinates and no block.
  if (liftCarrying()) return true;
  // Being in the air or in the water counts. A character that jumped on the spot presses no key
  // at all, and without a packet on the way down the server never follows the arc — everyone else
  // would see it standing still and then appearing where it landed.
  const rooted = game.world !== undefined && moverState(game.world).rooted;
  return motion.mode !== "ground" || (!rooted && (forwardAxis() !== 0 || strafeAxis() !== 0))
    || turnAxis() !== 0 || pitchAxis() !== 0;
}

/**
 * The `MovementFlags` word every movement packet carries.
 *
 * Half of it is what the player is pressing and half is what the physics has decided; both halves
 * have to be there, because the server reads this word for everything from fall damage to whether
 * a sitting character should be stood up. A jump whose packets never set `falling` is a jump the
 * server never sees.
 */
export function movementFlags(): number {
  let flags = 0;
  const state = game.world ? moverState(game.world) : undefined;
  // Physics already suppresses horizontal input during a server root. Claiming FORWARD or
  // STRAFE in MovementInfo while staying still would make the core relay a moving character.
  // A stun (5.11) holds the turn and the pitch too.
  const stunned = movementBlocked() === "stun";
  const forward = state?.rooted || stunned ? 0 : forwardAxis();
  if (forward > 0) flags |= MOVEMENT_FLAGS.forward;
  else if (forward < 0) flags |= MOVEMENT_FLAGS.backward;
  const strafe = state?.rooted || stunned ? 0 : strafeAxis();
  if (strafe > 0) flags |= MOVEMENT_FLAGS.strafeLeft;
  else if (strafe < 0) flags |= MOVEMENT_FLAGS.strafeRight;
  const turn = stunned ? 0 : turnAxis();
  if (turn > 0) flags |= MOVEMENT_FLAGS.turnLeft;
  else if (turn < 0) flags |= MOVEMENT_FLAGS.turnRight;
  const pitchKey = stunned ? 0 : pitchAxis();
  if (pitchKey > 0) flags |= MOVEMENT_FLAGS.pitchUp;
  else if (pitchKey < 0) flags |= MOVEMENT_FLAGS.pitchDown;
  if (walking) flags |= MOVEMENT_FLAGS.walking;

  if (state?.waterWalking) flags |= MOVEMENT_FLAGS.waterWalking;
  if (state?.featherFall) flags |= MOVEMENT_FLAGS.fallingSlow;
  if (state?.hovering) flags |= MOVEMENT_FLAGS.hover;
  if (state?.canFly) flags |= MOVEMENT_FLAGS.canFly;
  if (state?.gravityDisabled) flags |= MOVEMENT_FLAGS.disableGravity;

  const flying = state?.canFly === true || state?.gravityDisabled === true;
  if (motion.mode === "swim") flags |= MOVEMENT_FLAGS.swimming;
  else if (motion.mode === "air") flags |= flying ? MOVEMENT_FLAGS.flying : MOVEMENT_FLAGS.falling;
  if (motion.vertical > 0) flags |= MOVEMENT_FLAGS.ascending;
  else if (motion.vertical < 0) flags |= MOVEMENT_FLAGS.descending;
  // `MOVEMENTFLAG_ROOT` must not be set alongside anything in `MOVEMENTFLAG_MASK_MOVING`, and
  // falling is in that mask: a rooted character that walks off a ledge still falls, and saying
  // both at once is a contradiction the server is entitled to disbelieve.
  if (state?.rooted && motion.mode === "ground") flags |= MOVEMENT_FLAGS.root;
  // 11.01-A3: on a ship's deck; the block in `movementExtra` comes with it, never one without the other.
  if (rideActive(selfObject())) flags |= MOVEMENT_FLAGS.onTransport;
  return flags;
}

function selfObject(): WorldObjectState | undefined {
  const state = game.world?.state;
  // 11.02-A: the ship ride is the character's own; a driven vehicle carries no ride block.
  if (otherMoverGuid(game.world) !== undefined) return undefined;
  return state?.selfGuid === undefined ? undefined : state.objects.get(state.selfGuid);
}

/** 11.02-GF3: the extra with a vehicle mover's MovementFlags2 (see `movementExtra`). */
type MovementExtraOut = Omit<MovementInfo, "flags" | "flags2" | "time" | "position"> & { flags2?: number };

/** The rest of the MovementInfo: the fall clock, the jump block and the pitch. */
function movementExtra(): MovementExtraOut { // 11.02-GF3: was Omit<MovementInfo, "flags" | "flags2" | "time" | "position">
  const extra: MovementExtraOut = { fallTime: Math.round(motion.fallTime) }; // 11.02-GF3: the type above
  // 5.01: on the wire up is negative. The core launches a knock back with `float(-speedZ)`
  // (Unit.cpp:13237) and relays a client's jump block as it came (MovementHandler.cpp:651-663,
  // WorldSession.cpp:989/1124); Wow.exe's own jump starts its fall with -7.955547 (0x009883f0 →
  // 0x00988370, constant 0x00aa33dc). The physics keeps up positive; the block is turned here.
  const jump = motion.jump;
  if (jump) extra.jump = { velocity: -jump.velocity, sinAngle: jump.sinAngle, cosAngle: jump.cosAngle, speed: jump.speed };
  const pitch = wirePitch(); // 11.02-GF3: was `motion.pitch` alone
  if (pitch !== 0) extra.pitch = pitch;
  // 11.01-A3: the offset in the ship's frame and the facing relative to it; `position` stays the
  // world's (a local one is dropped as off the map, MovementHandler.cpp:299, 310).
  const transport = rideTransportBlock(selfObject(), Math.trunc(performance.now()) >>> 0);
  if (transport) extra.transport = transport;
  // 11.02-GF3: a vehicle mover's MovementFlags2 go with each of its packets and ACKs, as Wow.exe sends
  // CMovement+0x48: without ALWAYS_ALLOW_PITCHING the core would not read the pitch (WorldSession.cpp:982),
  // and its copy of the bits would be wiped by ours (`m_movementInfo = movementInfo`, MovementHandler.cpp:378).
  // `buildMovementPacket` spreads the extra over its `flags2: 0` (MovementProtocol.ts), as `moverSnapshot`
  // does below; tests/vehicle-movement-flags.test.mjs pins the bytes.
  const flags2 = moverVehicleRules(game.world)?.flags2;
  if (flags2) extra.flags2 = flags2;
  return extra;
}

/**
 * 11.02-GF3: the pitch the packets carry — the physics' own, else a vehicle's with ALWAYS_ALLOW_PITCHING,
 * which the physics zeroes on the ground (`stepCharacter` keeps a pitch only swimming or flying).
 */
function wirePitch(): number {
  if (motion.pitch !== 0) return motion.pitch;
  return moverVehicleRules(game.world)?.alwaysPitch ? characterPitch : 0;
}

/**
 * 5.01: the character has been knocked back (`WorldClient.onKnockBack`, after its ACK went out).
 * No packet here: the heartbeats that follow carry the fall with `knockbackJump(impulse)`.
 */
export function applyKnockback(impulse: KnockbackImpulse): void {
  if (ownMovementServerControlled()) return;
  // 5.18: a knock back ends a follow (Wow.exe 0x0072D1B0 → 0x007272C0).
  if (cancelFollow()) syncMovement();
  // 11.01-A3: on a deck the arc runs in the ship's frame.
  const objects = game.world?.state.objects;
  applyImpulse(motion, objects ? rideImpulse(selfObject(), impulse, objects) : impulse);
}

/** How fast the character covers ground right now, in yards a second. */
export function currentSpeed(): number {
  const world = game.world;
  // 11.02-A: the mover's — a driven vehicle runs at its own rate (Mover.ts).
  const self = moverObject(world);
  const speeds = world ? moverSpeeds(world) : undefined;
  // 5.08: the forced rate, else the CREATE block's (all nine are kept on the object), else the base.
  if (walking) return speeds?.get("walk") ?? self?.speeds?.get("walk") ?? DEFAULT_WALK_SPEED;
  return speeds?.get("run") ?? self?.speeds?.get("run") ?? self?.runSpeed ?? DEFAULT_RUN_SPEED;
}

/** The character's own arc between frames: which mode it is in, how fast it falls, since when. */
const motion: CharacterMotion = newCharacterMotion();

export function characterMotion(): Readonly<CharacterMotion> {
  return motion;
}

/** Whether the character has both feet on something. Sitting down in mid-air is not a thing. */
export function isGrounded(): boolean {
  return motion.mode === "ground";
}

/**
 * How far above the feet the server starts looking down for the room they are in: `GroupModel::
 * IsInsideObject` casts from 0.1 over the point (`WorldModel.cpp:423`).
 */
const WMO_LOCATION_RISE = 0.1;

/** The parts of the terrain client the probe reads; `isReady` is optional for the tests' stand-ins. */
type ProbeTerrain = Pick<TerrainClient, "heightAt" | "liquidAt" | "isHole"> & Partial<Pick<TerrainClient, "isReady">>;
/** The parts of the collision source the probe reads. */
type ProbeCollision = Pick<CollisionSource, "world" | "models" | "revision" | "staticWmoFloorState">;

/**
 * What the world answers about a point, wired to the terrain and collision clients.
 *
 * A tile that has not arrived answers `undefined` rather than zero, and the physics reads that as
 * "wait" rather than "no floor" — otherwise walking into freshly streamed ground is a fall.
 *
 * The liquid is the server's answer for a unit standing there, not the map file's alone: the WMO
 * group of the floor under the feet and its own `MLIQ`, the map's water only where no interior
 * room is in the way (`positionLiquid`). Gundrak is all rooms — 25 map tiles, flat and dry, and
 * 3,759 wet `MLIQ` cells — and reading the map file alone there meant falling through every pool
 * to its bed, 1.3 s for a drop from a yard over the water.
 *
 * Exported so a test can run the physics over real collision; the game uses `terrainProbe`.
 */
export function createTerrainProbe(
  terrain: ProbeTerrain | undefined,
  collision: ProbeCollision | undefined,
  mapId: number | undefined,
): TerrainProbe {
  const world = collision?.world;
  // The last column the floor query walked. The liquid query at the same feet reads the room from
  // it rather than walking the column again (`CollisionSource.staticWmoFloorState`'s `known`).
  // Mutated in place, because both run once per physics substep.
  const column = {
    valid: false, x: 0, y: 0, fromZ: 0, minZ: 0, revision: -1, hit: undefined as CollisionFloorHit | undefined,
  };
  const feet = { x: 0, y: 0, z: 0 };
  const liquid = (x: number, y: number, z: number): LiquidAnswer => {
    let footing: WmoLiquidFooting | undefined;
    if (collision) {
      const known = column.valid && column.x === x && column.y === y && column.revision === collision.revision
        ? column : undefined;
      const floor = collision.staticWmoFloorState(mapId, x, y, z + WMO_LOCATION_RISE, z - FLOOR_SEARCH_DEPTH, known);
      if (floor === undefined) return LIQUID_UNKNOWN;
      if (floor !== null) {
        const groups = collision.models.model(floor.placement.modelName)?.groups;
        if (!groups) return LIQUID_UNKNOWN;
        feet.x = x;
        feet.y = y;
        feet.z = z;
        const water = collisionModelLiquidAt(groups, floor.groupIndex, floor.placement, feet);
        // Outside the floor's own group the server would not have picked that room at all.
        if (water !== undefined) {
          footing = {
            floorZ: floor.floorZ,
            groupFlags: floor.groupFlags,
            liquid: water === null ? undefined : { height: water.worldHeight, type: water.type },
          };
        }
      }
    }
    const ground = terrain?.heightAt(mapId, x, y);
    // A map tile still on the wire is not a tile without water. `heightAt` says undefined for both
    // and for a tile that does not exist; only then is the slower readiness question asked.
    if (ground === undefined && mapId !== undefined && terrain?.isReady?.(mapId, x, y) === false) return LIQUID_UNKNOWN;
    return positionLiquid(z, footing, ground, ground === undefined ? undefined : terrain?.liquidAt(mapId, x, y));
  };
  const probe: TerrainProbe = {
    ground: (x, y) => terrain?.heightAt(mapId, x, y),
    liquid,
    hole: (x, y) => terrain?.isHole(mapId, x, y) ?? false,
    // 5.13: the map tile only. `heightAt` answers for a landed tile without allocating; only a
    // miss asks `isReady`, which tells a tile on the wire from a deliberate 404 (loaded, empty).
    // Collision readiness is deliberately not asked here: `CollisionSource.isReady` is the
    // transfer barrier's whole-neighbourhood plan, far too broad (and too costly) per substep.
    loaded: (x, y) => mapId === undefined || terrain === undefined
      || terrain.heightAt(mapId, x, y) !== undefined || terrain.isReady?.(mapId, x, y) !== false,
  };
  // Only when there is something to ask. An empty world would answer every query by walking an
  // empty map, which is cheap but not free, and the physics reads the absence as "no buildings"
  // rather than "no floors" — which is exactly right before any have been downloaded.
  if (collision && world && world.size > 0) {
    probe.floor = (x, y, fromZ, minZ) => {
      const hit = world.floorHitUnder(x, y, fromZ, minZ);
      column.valid = true;
      column.x = x;
      column.y = y;
      column.fromZ = fromZ;
      column.minZ = minZ;
      column.revision = collision.revision;
      column.hit = hit;
      return hit?.z;
    };
    probe.pushOut = (x, y, z, radius, bodyHeight) => world.pushOut(x, y, z, radius, bodyHeight, STEP_HEIGHT);
    // 5.12: asked only while the head is rising.
    probe.ceiling = (x, y, fromZ, toZ) => world.ceilingAbove(x, y, fromZ, toZ);
  }
  return probe;
}

/**
 * The probe for the live world.
 *
 * Rebuilt only when the wiring inputs change (world/map swap, or the first collision mesh
 * landing): the object plus three to five closures per frame was pure garbage for identical
 * wiring, and the closures themselves read everything else live.
 */
let probeTerrain: typeof game.terrain | undefined;
let probeSource: CollisionSource | undefined;
let probeCollision: CollisionWorld | undefined;
let probeCollisionNonEmpty = false;
let probeMapId: number | undefined;
let probeCached: TerrainProbe | undefined;
function terrainProbe(mapId: number | undefined): TerrainProbe {
  const terrain = game.terrain;
  const source = game.collision;
  const collision = source?.world;
  const nonEmpty = (collision?.size ?? 0) > 0;
  if (probeCached !== undefined
    && terrain === probeTerrain
    && source === probeSource
    && collision === probeCollision
    && nonEmpty === probeCollisionNonEmpty
    && mapId === probeMapId) {
    return probeCached;
  }
  const probe = createTerrainProbe(terrain, source, mapId);
  probeTerrain = terrain;
  probeSource = source;
  probeCollision = collision;
  probeCollisionNonEmpty = nonEmpty;
  probeMapId = mapId;
  probeCached = probe;
  return probe;
}

/** Reinterprets an update-field slot as the float it holds. */
const FLOAT_SCRATCH = new DataView(new ArrayBuffer(4));
function fieldFloat(fields: Map<number, number>, index: number, fallback: number): number {
  const raw = fields.get(index);
  if (raw === undefined) return fallback;
  FLOAT_SCRATCH.setUint32(0, raw >>> 0, true);
  const value = FLOAT_SCRATCH.getFloat32(0, true);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The character's own collision height, which is what decides how deep water has to be to swim in.
 *
 * `Unit::GetCollisionHeight` builds it out of the model's `CollisionHeight` times its scales, and
 * the gateway now serves exactly that; `OBJECT_FIELD_SCALE_X` is the last multiplier and it lives
 * on the wire. A spell that changes it overrides everything, which is what
 * `SMSG_MOVE_SET_COLLISION_HGT` is for.
 */
function collisionHeight(self: WorldObjectState): number {
  const world = game.world;
  // 11.02-A: `self` is the mover; a driven vehicle's override is its own (`Unit::GetCollisionHeight`).
  const override = world ? moverState(world).collisionHeight : 0;
  if (override) return override;
  const model = game.creatureModels?.get(unit.displayId(self) ?? 0);
  if (!model?.collisionHeight) return DEFAULT_COLLISION_HEIGHT;
  return model.collisionHeight * fieldFloat(self.fields, UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset, 1);
}

/**
 * Advances the character by one frame and tells the server whatever changed.
 *
 * This is the whole of what used to be six lines in the render loop: turn, walk, and stick to the
 * ground if it happened to be within six yards.
 */
export function advancePhysics(elapsed: number): void {
  const world = game.world;
  // 5.15: the loading screen is a stretch without control as well: a key held through it goes out
  // on the first frame after (the edge below), not never.
  if (game.worldLoading) movementReadyReported = false;
  if (!world || game.worldLoading || world.state.selfGuid === undefined) return;
  const character = world.state.objects.get(world.state.selfGuid);
  if (!character || !character.position) return;

  // 11.02-A: another unit took the keys (a vehicle's driving seat) or gave them back. Its axes start
  // from nothing and the keys still held go out once under its guid (the 5.15 edge below).
  const mover = moverGuid(world);
  if (mover !== lastMover) {
    if (lastMover !== undefined) {
      sentForward = 0;
      sentStrafe = 0;
      sentTurn = 0;
      sentPitchKey = 0;
      resetCharacterMotion();
      movementReadyReported = false;
    }
    lastMover = mover;
  }

  if (moverHeld(world, character)) {
    if (!wasServerControlled) {
      wasServerControlled = true;
      sentForward = 0;
      sentStrafe = 0;
      sentTurn = 0;
      sentPitchKey = 0;
      resetCharacterMotion();
    }
    seatedFrame(world, elapsed); // 11.02-input: a seat with ALLOW_TURNING turns (SeatedTurn.ts)
    return;
  }
  if (wasServerControlled) {
    // The last spline frame precedes the core's flag/control update. Resume only after both
    // arrive; otherwise a held key races the taxi completion acknowledgement.
    if (!world.movementReady) return;
    wasServerControlled = false;
    syncMovement();
    return;
  }
  // The body the physics steps: the character, or the unit it drives (Mover.ts).
  const self = moverObject(world);
  if (!self || !self.position) return;

  if (world.movementSnapshot !== moverSnapshot) world.movementSnapshot = moverSnapshot;

  // 5.15: keys held before the server handed over control (SMSG_CLIENT_CONTROL_UPDATE /
  // CMSG_SET_ACTIVE_MOVER) went out nowhere; the first frame with control sends them once. Until
  // then the held axes do not move the body either — a move the server never heard of.
  const ready = world.movementReady;
  if (!ready) movementReadyReported = false;
  else if (!movementReadyReported) {
    movementReadyReported = true;
    syncMovement();
  }

  // The root packet changes WorldClient.movementState, not keyboard state. Announce STOP on the
  // first frame under root and START on release if the player is still holding a movement key.
  // The same for a stun (5.11), and for a held pitch key whose meaning came or went with the water
  // or the flight (5.09).
  // 11.02-I: far sight proper holds the body as a stun does (`movementBlocked`).
  const stunned = moverStunned(self) || farSightHoldsBody(world);
  const toggles = moverState(world);
  if (toggles.rooted !== reportedRooted || stunned !== reportedStunned
    || (stunned ? 0 : pitchAxis()) !== sentPitchKey) {
    syncMovement();
  }

  // 5.18: following (Follow.ts, Wow.exe 0x007317A0) faces the target and runs before the input is
  // read; a stun, another mover or the character's death ends it (0x00728F70, 0x00729010).
  if (ready) advanceFollowing(world, character, stunned);

  const input = INPUT;
  input.forward = ready ? forwardAxis() : 0;
  input.strafe = ready ? strafeAxis() : 0;
  input.ascend = ready && held.has("jump");
  // The key that sits down on land takes a swimmer down, which is what it does in the original
  // client: there is nothing to sit on in a lake.
  input.descend = ready && held.has("sitOrStand");
  // 11.02-GF3: a NO_STRAFE vehicle refuses rising and sinking in water or the air as well
  // (VehicleMovementFlags.ts, Wow.exe 0x009898e0); a jump from the ground is not that.
  if ((input.ascend || input.descend) && motion.mode !== "ground" && moverVehicleRules(world)?.noStrafe) {
    input.ascend = false;
    input.descend = false;
  }
  input.runSpeed = currentSpeed();
  // 5.08: backwards on land is the run-back rate, or the walk rate in walk mode.
  input.runBackSpeed = walking ? input.runSpeed : speedOf(world, self, "runBack", DEFAULT_RUN_BACK_SPEED);
  input.swimSpeed = speedOf(world, self, "swim", DEFAULT_SWIM_SPEED);
  input.swimBackSpeed = speedOf(world, self, "swimBack", DEFAULT_SWIM_BACK_SPEED);
  input.flightSpeed = speedOf(world, self, "flight", DEFAULT_FLIGHT_SPEED);
  input.flightBackSpeed = speedOf(world, self, "flightBack", DEFAULT_FLIGHT_BACK_SPEED);
  input.collisionHeight = collisionHeight(self);
  input.radius = fieldFloat(self.fields, UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, DEFAULT_RADIUS);
  input.rooted = toggles.rooted;
  input.stunned = stunned;
  input.waterWalking = toggles.waterWalking;
  input.featherFall = toggles.featherFall;
  input.hovering = toggles.hovering;
  input.hoverHeight = fieldFloat(self.fields, UPDATE_FIELDS.UNIT_FIELD_HOVERHEIGHT.offset, 0);
  input.canFly = toggles.canFly;
  input.gravityDisabled = toggles.gravityDisabled;

  // 5.13: real time, in substeps, so a slow frame neither slows the character nor walks it through
  // a wall. The character is pushed out of what it is standing inside rather than swept towards
  // it, which is only equivalent while a substep moves it less than half its own radius.
  const radius = input.radius > 0 ? input.radius : DEFAULT_RADIUS;
  const flying = input.canFly || input.gravityDisabled;
  const horizontal = motion.mode === "swim" ? Math.max(input.swimSpeed, input.swimBackSpeed)
    : motion.mode === "air"
      ? flying ? Math.max(input.flightSpeed, input.flightBackSpeed) : motion.jump?.speed ?? input.runSpeed
      : Math.max(input.runSpeed, input.runBackSpeed);
  const fastest = horizontal + Math.abs(motion.velocityZ);
  const dt = physicsElapsed(elapsed, fastest, radius);
  if (dt <= 0) return;

  // Turning is a rate the server also knows, so the character turns at its speed rather than at
  // whatever the frame rate happens to be. A stun holds it (5.11); a root does not.
  const live = self.position;
  if (!live) return;
  if (!stunned && ready) {
    const turnRate = speedOf(world, self, "turnRate", DEFAULT_TURN_RATE);
    live.orientation = normalizeAngle(live.orientation + turnAxis() * turnRate * dt);
    // 11.02-GF3: a FIXED_POSITION vehicle turns inside its facing limits (VehicleMovementFlags.ts).
    if (turnAxis() !== 0) live.orientation = vehicleFacing(world, self, live.orientation);
  }
  input.pitch = updateCharacterPitch(world, self, stunned, dt);

  // 11.01-B: closed doors and lifts near the character join the world, and a character standing on
  // a lift is carried by its move first (GameObjectColliders.ts); with none near, the world probe.
  const probe = gameObjectColliderFrame(world.state.objects, self, terrainProbe(world.mapId), motion, performance.now());
  // 11.01-A3: on a ship's deck the step runs in the ship's frame against its own collision
  // (MovementRide.ts); boarding and leaving are decided there.
  const ride = RIDE_FRAME;
  ride.objects = world.state.objects;
  ride.self = self;
  ride.world = probe;
  ride.flying = flying;
  ride.elapsed = dt;
  ride.now = performance.now();
  // 11.02-A: a driven vehicle does not board ships here; the ride is the character's own.
  const deck = self === character ? beginRideFrame(ride) : undefined;
  const substeps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(fastest * dt / (radius * 0.5))));
  lastSubsteps = substeps;
  input.frameSubsteps = substeps; // L8-review 5.07: an edge is judged by the frame's whole step (Physics.footHolds)
  for (let step = 0; step < substeps; step++) {
    // Read again each substep: an event's packet may have replaced the object's position
    // (`WorldState.move`), and stepping a detached copy would lose the rest of the frame.
    const position = self.position;
    if (!position) return;
    const events = deck ? stepRideSubstep(ride, motion, input, dt / substeps, EVENTS)
      : stepCharacter(position, motion, input, probe, dt / substeps, EVENTS);
    for (let index = 0; index < events.length; index++) reportPhysicsEvent(events[index]!);
  }
  if (self === character) endRideFrame(ride);
  // 11.02-A: the driver sits where the vehicle is now, not where it was when the frame began.
  else carrySeatedCharacter(world.state.objects, character, self);
  // Boarded or stepped off: the server hears it now, with the block or without it.
  if (takeRideFlip()) sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
  // 11.01-B: a lift ride ended: where the character came to rest, in world coordinates.
  if (takeLiftSettled()) sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
  reportPitch();
}

/** 5.18: one frame of following; the axis change and a turn on the spot go out as packets. */
function advanceFollowing(world: NonNullable<typeof game.world>, self: WorldObjectState, stunned: boolean): void {
  const before = followRunning();
  const otherMover = world.controlledGuid !== undefined && world.controlledGuid !== self.guid;
  if (stunned || otherMover || !isAlive(self)) {
    if (cancelFollow() && before) syncMovement();
    return;
  }
  const turned = advanceFollow(world, self, pitchMatters());
  if (followRunning() !== before) syncMovement();
  else if (turned && !followRunning()) sendFacingThrottled();
}

function isAlive(self: WorldObjectState): boolean {
  return (self.fields.get(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset) ?? 1) > 0;
}

/** The character's input, filled in place each frame (5.13: no allocation per frame). */
const INPUT: CharacterInput = {
  forward: 0, strafe: 0, ascend: false, descend: false, pitch: 0,
  runSpeed: DEFAULT_RUN_SPEED, swimSpeed: DEFAULT_SWIM_SPEED, flightSpeed: DEFAULT_FLIGHT_SPEED,
  runBackSpeed: DEFAULT_RUN_BACK_SPEED, swimBackSpeed: DEFAULT_SWIM_BACK_SPEED, flightBackSpeed: DEFAULT_FLIGHT_BACK_SPEED,
  stunned: false, collisionHeight: DEFAULT_COLLISION_HEIGHT, radius: DEFAULT_RADIUS, rooted: false,
  waterWalking: false, featherFall: false, hovering: false, hoverHeight: 0, canFly: false, gravityDisabled: false,
};
/** The events of one substep, reused. */
const EVENTS: PhysicsEvent[] = [];
/** 11.01-A3: what the ride reads of a frame, filled in place. */
const RIDE_FRAME: RideFrameInput = {
  objects: new Map(), self: undefined as unknown as WorldObjectState, world: { ground: () => undefined, liquid: () => undefined, hole: () => false },
  motion, flying: false, elapsed: 0, now: 0,
};
let lastSubsteps = 0;
/** 5.13: how many substeps the last frame took (diagnostics and tests). */
export function lastPhysicsSubsteps(): number {
  return lastSubsteps;
}

/**
 * A rate the server set: the forced value (ACK), else the one the CREATE block carried, else the
 * base rate every character starts with.
 */
function speedOf(world: NonNullable<typeof game.world>, self: WorldObjectState,
  name: ForcedSpeedName, fallback: number): number {
  return moverSpeeds(world).get(name) ?? self.speeds?.get(name) ?? fallback;
}

/**
 * 11.02-GF3: a facing the mover takes, held inside a FIXED_POSITION vehicle's limits around the
 * orientation its create block carried (VehicleMovementFlags.ts, Wow.exe 0x006eaa50); any other
 * mover's comes back as it was.
 */
function vehicleFacing(world: typeof game.world, mover: WorldObjectState, facing: number): number {
  const rules = moverVehicleRules(world);
  if (!rules?.fixedPosition || mover.vehicleOrientation === undefined) return facing;
  return clampVehicleFacing(rules, mover.vehicleOrientation, facing);
}

/**
 * 11.02-GF3: whether the unit the keys move is a NO_STRAFE vehicle — Controls.ts then leaves its turn
 * keys turning under the steer, as Wow.exe's turn axis does (0x005fb0b0 asks 0x0074b9a0, the unit's
 * MovementFlags2 at +0x7d0 = its embedded CMovement +0x48, set up at +0x788 by 0x0073f67a).
 */
export function moverRefusesStrafe(): boolean {
  return moverVehicleRules(game.world)?.noStrafe === true;
}

/**
 * 11.02-GF3: the steering drag's vertical, for a vehicle that aims with it (VehicleMovementFlags.ts,
 * Wow.exe 0x005fba60 over 0x00756f00): its pitch moves by `radians` inside its band and the caller
 * leaves the camera's pitch alone. False — the camera takes the drag — for every other mover, aloft,
 * or while the keys move nothing.
 */
export function aimMoverPitchBy(radians: number): boolean {
  const world = game.world;
  const rules = moverVehicleRules(world);
  if (rules === undefined || !vehicleAimsWithMouse(rules, pitchAloft())) return false;
  // 11.02-input: a seated turner aims as well (Wow.exe 0x005fba60 asks 0x005fa110, which asks 0x0074b900).
  const seatedAim = ownMovementServerControlled() && freeSeatedTurner(world) !== undefined;
  if (!world || (movementBlocked() !== undefined && !seatedAim) || viewIsOut(world)) return false; // 11.02-input: `&& !seatedAim`
  characterPitch = clampVehiclePitch(rules, characterPitch + radians);
  return true;
}

/**
 * 11.02-E: VehicleAimRequestAngle / RequestNormAngle / Increment / Decrement (Wow.exe 0x005fb3a0 for the
 * active mover): a vehicle mover whose pitch counts (ALWAYS_ALLOW_PITCHING, or aloft) takes `pitch` inside
 * its band; false — nothing changes — for any other mover. The packets follow as for any pitch change
 * (`reportPitch`, the next trajectory cast's elevation).
 */
export function requestMoverPitch(pitch: number): boolean {
  const rules = moverVehicleRules(game.world);
  if (rules === undefined || !Number.isFinite(pitch) || !pitchMatters()) return false;
  characterPitch = clampVehiclePitch(rules, pitch);
  return true;
}

// 11.02-E: the stock VehicleAim* functions and the missile solver reach the mover's pitch through this.
registerVehicleAimInput({
  moverPitch: () => characterPitch,
  setMoverPitch: requestMoverPitch,
  pitchKey: (direction, down) => (down ? beginHeld : endHeld)(direction === "up" ? "pitchUp" : "pitchDown"),
});

/**
 * 11.02-input: the mover held in a vehicle seat whose row has ALLOW_TURNING (SeatedTurn.ts), when it may
 * turn now — movement is ready, it is not stunned and far sight does not hold the body (Wow.exe 0x005fa0d0:
 * 0x005fa060 and UNIT_FLAG_STUNNED before 0x0074b900); undefined otherwise.
 */
function freeSeatedTurner(world: typeof game.world): WorldObjectState | undefined {
  if (!world?.movementReady || game.worldLoading) return undefined;
  const mover = seatedTurner(world);
  return mover === undefined || moverStunned(mover) || farSightHoldsBody(world) ? undefined : mover;
}

/**
 * 11.02-input: one frame of a held mover (the end of `advancePhysics`'s held branch): a seated turner's pitch
 * as on foot (`updateCharacterPitch`: only a vehicle with ALWAYS_ALLOW_PITCHING has one there), its turn keys
 * on its seat and their packets with the transport block. Every other held mover — a spline, a taxi, a seat
 * that does not turn, a stunned one — only has the seated bookkeeping dropped or its keys reported as up.
 */
function seatedFrame(world: NonNullable<typeof game.world>, elapsed: number): void {
  const mover = freeSeatedTurner(world);
  if (mover === undefined) {
    seatedTurnSync(world, 0, 0, characterPitch);
    return;
  }
  const dt = physicsElapsed(elapsed, 0, 0);
  updateCharacterPitch(world, mover, false, dt);
  seatedTurnFrame(world, turnAxis(), pitchAxis(), characterPitch, speedOf(world, mover, "turnRate", DEFAULT_TURN_RATE), dt);
}

/**
 * 5.10: the character's pitch this frame. While steering (right button), the camera's; else the
 * pitch keys at `pitchRate`; else it levels out in water and holds in flight. Zero on land.
 */
function updateCharacterPitch(world: NonNullable<typeof game.world>, self: WorldObjectState,
  stunned: boolean, dt: number): number {
  if (!pitchMatters()) {
    characterPitch = 0;
    return 0;
  }
  if (stunned) return characterPitch;
  const rate = speedOf(world, self, "pitchRate", DEFAULT_PITCH_RATE);
  const key = pitchAxis();
  // 11.02-GF3: a vehicle mover (VehicleMovementFlags.ts). The steer sets the camera's pitch plus
  // MouseLookOffsetPitch where Wow.exe lets the mouse pitch it at all, with the camera on it
  // (0x005fa790 → 0x005fbe70); one that aims with the drag keeps its own (0x00756f00); the keys as
  // ever; and the pitch stays in the vehicle's band (0x005fb3a0) rather than the character's.
  const rules = moverVehicleRules(world);
  if (rules !== undefined) {
    if (steering) {
      if (vehicleSteerPitchesFromCamera(rules, pitchAloft()) && !viewIsOut(world)) {
        characterPitch = game.camera.pitch + rules.mouseLookOffsetPitch;
      }
    } else if (key !== 0) characterPitch += key * rate * dt;
    else if (motion.mode === "swim") {
      const level = rate * dt;
      characterPitch = Math.abs(characterPitch) <= level ? 0 : characterPitch - Math.sign(characterPitch) * level;
    }
    characterPitch = clampVehiclePitch(rules, characterPitch);
    return characterPitch;
  }
  if (steering) characterPitch = game.camera.pitch;
  else if (key !== 0) characterPitch += key * rate * dt;
  else if (motion.mode === "swim") {
    const level = rate * dt;
    characterPitch = Math.abs(characterPitch) <= level ? 0 : characterPitch - Math.sign(characterPitch) * level;
  }
  characterPitch = Math.max(-CHARACTER_PITCH_LIMIT, Math.min(CHARACTER_PITCH_LIMIT, characterPitch));
  return characterPitch;
}

/**
 * M7-0: the character's live MovementInfo for an acknowledgement the server asks of it — the flags,
 * fall clock, jump block and pitch it has now, not the ones of the last packet sent.
 */
function moverSnapshot(guid: bigint): MovementInfo | undefined {
  const world = game.world;
  // 11.02-A: the mover's — a driven vehicle's ACK echoes the vehicle; the character in its seat is
  // answered by `WorldClient` from the seat (UnitSeat.ts).
  // 11.02-input: except a mover that turns on its seat: its seat with the facing and keys it has (SeatedTurn.ts).
  if (world && guid === moverGuid(world) && !game.worldLoading && ownMovementServerControlled()) {
    return seatedTurnSnapshot(world, guid, characterPitch);
  }
  if (!world || guid !== moverGuid(world) || game.worldLoading || ownMovementServerControlled()) return undefined;
  const position = selfPosition();
  if (!position) return undefined;
  return { flags: movementFlags(), flags2: 0, time: Math.trunc(performance.now()) >>> 0, position, ...movementExtra() };
}

/** One state change, one packet. The server is not watching the position for any of these. */
function reportPhysicsEvent(event: PhysicsEvent): void {
  if (event === "jump") {
    sendMovement(OPCODES.MSG_MOVE_JUMP);
    return;
  }
  if (event === "startFall") {
    // There is no "started falling" opcode: the fall announces itself by the flag appearing in the
    // next packet, and `Player::UpdateFallInformationIfNeed` takes that packet's z as where the
    // fall began. Sending one now rather than waiting for the heartbeat is what makes the height
    // the server charges damage on the edge that was actually walked off.
    sendMovement(OPCODES.MSG_MOVE_HEARTBEAT);
    return;
  }
  if (event === "land") {
    sendMovement(OPCODES.MSG_MOVE_FALL_LAND);
    // Cleared only now: the landing packet is the one that carries it, and `Player::HandleFall`
    // charges the height between where the fall began and here.
    motion.fallTime = 0;
    return;
  }
  if (event === "startSwim") sendMovement(OPCODES.MSG_MOVE_START_SWIM);
  else if (event === "stopSwim") sendMovement(OPCODES.MSG_MOVE_STOP_SWIM);
  else if (event === "startAscend") sendMovement(OPCODES.MSG_MOVE_START_ASCEND);
  else if (event === "startDescend") sendMovement(OPCODES.MSG_MOVE_START_DESCEND);
  else if (event === "stopAscend") sendMovement(OPCODES.MSG_MOVE_STOP_ASCEND);
}

/** How far the pitch may drift before the server is told again. */
const PITCH_EPSILON = 0.08;
let sentPitch = 0;

/**
 * Where a swimmer is pointing.
 *
 * Only while it matters: the pitch is not even written into the packet unless the character is
 * swimming or flying, so on dry land this is silence rather than a packet a frame.
 */
function reportPitch(): void {
  const pitch = wirePitch(); // 11.02-GF3: was `motion.pitch` in the four places below
  if (pitch === 0) {
    sentPitch = 0;
    return;
  }
  if (Math.abs(pitch - sentPitch) < PITCH_EPSILON) return;
  sentPitch = pitch;
  sendMovement(OPCODES.MSG_MOVE_SET_PITCH);
}

function selfPosition() {
  const world = game.world;
  if (!world || world.state.selfGuid === undefined) return undefined;
  // 11.02-A: the mover's position — the character's own unless it drives something (Mover.ts).
  return moverObject(world)?.position;
}

/** Sends one movement opcode with the state as it stands. */
export function sendMovement(opcode: number): void {
  // A transfer has already put the server-side mover at its destination, but local terrain and
  // collision may still be in flight. Do not send input or predicted position until the same
  // barrier that gates gravity has opened; otherwise the server can advance while this client is
  // deliberately holding its local position still.
  if (game.worldLoading || ownMovementServerControlled()) return;
  const position = selfPosition();
  if (!position) return;
  const other = otherMoverGuid(game.world);
  // 11.02-A: a driven unit's packets carry its guid (`sendMovementAs`); the character's, as ever.
  if (other !== undefined) game.world?.sendMovementAs(other, opcode, movementFlags(), position, movementExtra());
  else game.world?.sendMovement(opcode, movementFlags(), position, movementExtra());
  movementHeartbeat.sentAt = performance.now();
}

/**
 * Tells the server about whichever axes have changed since last time.
 *
 * Called after anything touches the state — a key, autorun, the mouse. Sending per axis rather
 * than per key is what makes autorun and the two-button run indistinguishable from `W` on the
 * wire, which is what they are.
 */
export function syncMovement(): void {
  // 11.02-input: a held mover that turns on its seat reports its key edges with the seat (SeatedTurn.ts).
  if (game.world?.movementReady && !game.worldLoading && ownMovementServerControlled()) {
    const free = freeSeatedTurner(game.world) !== undefined;
    seatedTurnSync(game.world, free ? turnAxis() : 0, free ? pitchAxis() : 0, characterPitch);
    return;
  }
  if (!game.world?.movementReady || game.worldLoading || ownMovementServerControlled()) return;
  const rooted = moverState(game.world).rooted;
  reportedRooted = rooted;
  const stunned = movementBlocked() === "stun";
  reportedStunned = stunned;
  const forward = rooted || stunned ? 0 : forwardAxis();
  const strafe = rooted || stunned ? 0 : strafeAxis();
  const turn = stunned ? 0 : turnAxis();
  const pitchKey = stunned ? 0 : pitchAxis();
  if (forward !== sentForward) {
    sendMovement(forward > 0 ? OPCODES.MSG_MOVE_START_FORWARD
      : forward < 0 ? OPCODES.MSG_MOVE_START_BACKWARD : OPCODES.MSG_MOVE_STOP);
    sentForward = forward;
  }
  if (strafe !== sentStrafe) {
    sendMovement(strafe > 0 ? OPCODES.MSG_MOVE_START_STRAFE_LEFT
      : strafe < 0 ? OPCODES.MSG_MOVE_START_STRAFE_RIGHT : OPCODES.MSG_MOVE_STOP_STRAFE);
    sentStrafe = strafe;
  }
  if (turn !== sentTurn) {
    sendMovement(turn > 0 ? OPCODES.MSG_MOVE_START_TURN_LEFT
      : turn < 0 ? OPCODES.MSG_MOVE_START_TURN_RIGHT : OPCODES.MSG_MOVE_STOP_TURN);
    sentTurn = turn;
  }
  // 5.09: the third axis. Only where pitch matters (water, flight): elsewhere the keys say nothing.
  if (pitchKey !== sentPitchKey) {
    sendMovement(pitchKey > 0 ? OPCODES.MSG_MOVE_START_PITCH_UP
      : pitchKey < 0 ? OPCODES.MSG_MOVE_START_PITCH_DOWN : OPCODES.MSG_MOVE_STOP_PITCH);
    sentPitchKey = pitchKey;
  }
}

/** Back into (-π, π]. Orientation is compared against the server's, which is always in that range. */
export function normalizeAngle(radians: number): number {
  return ((radians + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

/** How often a mouse turn tells the server where the character now faces. */
const FACING_INTERVAL = 100;
let facingSentAt = 0;

/**
 * Turns the character, which is what dragging with the right button does.
 *
 * The facing has to reach the server whether or not the character is moving: a swing only lands
 * inside a 120-degree arc, and a player who turned on the spot and then attacked would be told to
 * face a target they are already looking at. Throttled, because a mouse reports far more often
 * than the server needs to hear.
 */
export function turnCharacterBy(radians: number): boolean {
  // 11.02-input: a held mover that turns on its seat is turned there, with the camera on it (SeatedTurn.ts).
  if (ownMovementServerControlled()) {
    return !viewIsOut(game.world) && freeSeatedTurner(game.world) !== undefined
      && seatedTurnBy(game.world, radians, characterPitch);
  }
  // 5.11: a stun holds the facing; the caller turns the camera instead. A server-moved character
  // is not the player's to turn either.
  // 11.02-I: nor a mover the camera is not on (ViewSubject.viewIsOut, Wow.exe 0x005fa6b0).
  if (movementBlocked() !== undefined || viewIsOut(game.world)) return false;
  const position = selfPosition();
  if (!position) return false;
  if (radians === 0) return true;
  // 5.18: the mouse turning the character ends a follow (Wow.exe 0x005FB260 → 0x0072EA50).
  if (cancelFollow()) syncMovement();
  position.orientation = normalizeAngle(position.orientation + radians);
  // 11.02-GF3: a FIXED_POSITION vehicle stops at its facing limits (VehicleMovementFlags.ts, Wow.exe 0x0071c1e0).
  const turned = moverObject(game.world);
  if (turned) position.orientation = vehicleFacing(game.world, turned, position.orientation);
  // 11.01-A3: on a deck the facing relative to the ship turns too, or the next frame's carry undoes it.
  rideTurned(selfObject(), radians);
  sendFacingThrottled();
  return true;
}

/** MSG_MOVE_SET_FACING at most every {@link FACING_INTERVAL}. */
function sendFacingThrottled(): void {
  const now = performance.now();
  if (now - facingSentAt < FACING_INTERVAL) return;
  facingSentAt = now;
  sendMovement(OPCODES.MSG_MOVE_SET_FACING);
}

/** The last word on where the character ended up, sent when the drag stops. */
export function flushFacing(): void {
  // 11.02-input: a seated turner's last facing of the drag (SeatedTurn.ts); any other held mover, nothing.
  if (ownMovementServerControlled()) {
    if (!viewIsOut(game.world) && freeSeatedTurner(game.world) !== undefined) seatedFlushFacing(game.world, characterPitch);
    return;
  }
  // 5.11: a drag that ended under a stun turned the camera only; there is no facing to report.
  // 11.02-I: so did one with the camera off the mover.
  if (movementBlocked() !== undefined || viewIsOut(game.world)) return;
  facingSentAt = performance.now();
  sendMovement(OPCODES.MSG_MOVE_SET_FACING);
}

/** A held action has gone down. Autorun ends where the original client ends it: on a walk key. */
export function beginHeld(action: InputAction): void {
  action = heldMovementAction(action); // 11.02-input: VEHICLEAIMUP/DOWN are the pitch keys themselves (Bindings.ts)
  if (held.has(action)) return;
  if (action === "moveForward" || action === "moveBackward") autoRunning = false;
  // 5.18: a movement key ends a follow; the pitch, rise and dive keys only where they move (in water
  // or the air: 0x005FACE0 and 0x005FB1A0 run only then). syncMovement below reports the axis the
  // follow leaves behind.
  if (FOLLOW_BREAKING.has(action) || (FOLLOW_BREAKING_ALOFT.has(action) && pitchMatters())) cancelFollow();
  held.add(action);
  syncMovement();
}

export function endHeld(action: InputAction): void {
  action = heldMovementAction(action); // 11.02-input: as `beginHeld`
  if (!held.delete(action)) return;
  syncMovement();
}

/** Both mouse buttons held is forward, exactly as if the key were down. */
export function setMouseRun(running: boolean): void {
  if (mouseRunning === running) return;
  mouseRunning = running;
  if (running) autoRunning = false;
  // 5.18: both buttons are forward (0x005FAE70), which ends a follow.
  if (running) cancelFollow();
  syncMovement();
}

export function toggleAutoRun(): void {
  autoRunning = !autoRunning;
  if (autoRunning) cancelFollow();
  syncMovement();
}

/** 5.18: the keys whose start ends a follow (Wow.exe 0x005FAE70, 0x005FAFB0, 0x005FB0B0). */
const FOLLOW_BREAKING: ReadonlySet<InputAction> = new Set<InputAction>([
  "moveForward", "moveBackward", "strafeLeft", "strafeRight", "turnLeft", "turnRight",
]);
/** 5.18: and those that end it only in water or the air (0x005FACE0 pitch, 0x005FB1A0 rise and dive). */
const FOLLOW_BREAKING_ALOFT: ReadonlySet<InputAction> = new Set<InputAction>([
  "pitchUp", "pitchDown", "jump", "sitOrStand",
]);

/**
 * Walk or run. The flag is the whole of it — the server reads `MOVEMENTFLAG_WALKING` out of the
 * MovementInfo and mirrors the opcode to everyone nearby, so the opcode itself only says which
 * way it changed.
 */
export function toggleWalkRun(): void {
  walking = !walking;
  sendMovement(walking ? OPCODES.MSG_MOVE_SET_WALK_MODE : OPCODES.MSG_MOVE_SET_RUN_MODE);
}

/**
 * Everything up, and the server told so.
 *
 * Called when the window loses focus and when the world changes under the character. Without it a
 * key held while alt-tabbing never gets its release and the character runs off a cliff.
 */
export function releaseAllInput(): void {
  const wasMoving = held.size > 0 || autoRunning || mouseRunning;
  held.clear();
  autoRunning = false;
  mouseRunning = false;
  if (wasMoving) {
    if (game.worldLoading) {
      // The transfer barrier deliberately suppresses the stop packet. Forget the old wire
      // state anyway, or the first key pressed after the curtain opens compares equal to the
      // pre-teleport axis and waits for a heartbeat before it can start moving again.
      sentForward = 0;
      sentStrafe = 0;
      sentTurn = 0;
      sentPitchKey = 0;
    } else {
      syncMovement();
    }
  }
}

/**
 * Drops the arc without sending anything.
 *
 * A teleport lands the character somewhere else entirely, and a fall clock carried across it is a
 * fall the server would charge damage for on arrival.
 */
export function resetCharacterMotion(): void {
  // 5.18: a teleport, a taxi or a new world ends a follow (0x0072D3F0/0x0072D470, 0x00728F70).
  cancelFollow();
  Object.assign(motion, newCharacterMotion());
  sentPitch = 0;
  characterPitch = 0;
  // 11.01-A3: the ride's counters; a seat the server keeps on the character is picked up again.
  forgetRide();
}

/**
 * 1.17: after a near teleport, START again for every axis still held.
 *
 * `Player::TeleportTo` cleared the server's movement flags, so an axis this client last reported as
 * moving is standing still for the realm and for everybody watching. Wow.exe re-issues held keys
 * once the teleport ACK is out (0x007413F0, case 199 → 0x005FBBC0); forgetting what was sent makes
 * `syncMovement` do the same. Nothing is sent for an axis that is not held.
 */
export function reissueHeldMovement(): void {
  sentForward = 0;
  sentStrafe = 0;
  sentTurn = 0;
  sentPitchKey = 0;
  syncMovement();
}

/** Forgets the state a world owned, without sending anything to a connection that is gone. */
export function forgetMovementState(): void {
  forgetFollow();
  held.clear();
  autoRunning = false;
  mouseRunning = false;
  walking = false;
  sentForward = 0;
  sentStrafe = 0;
  sentTurn = 0;
  reportedRooted = false;
  reportedStunned = false;
  wasServerControlled = false;
  movementReadyReported = false;
  sentPitch = 0;
  sentPitchKey = 0;
  characterPitch = 0;
  steering = false;
  lastMover = undefined;
  Object.assign(motion, newCharacterMotion());
  forgetRide();
  forgetSeatedTurn(); // 11.02-input
}
