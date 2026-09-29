import { MOVEMENT_FLAGS, type MovementInfo } from "../../world/MovementProtocol.js";
import { OPCODES } from "../../generated/opcodes.js";
import { game } from "../game/Context.js";
import { unit } from "../../world/Fields.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { serverControlsMovement, type WorldObjectState } from "../../world/WorldState.js";
import type { CollisionFloorHit, CollisionWorld } from "../game/Collision.js";
import { collisionModelLiquidAt, positionLiquid, type WmoLiquidFooting } from "../game/CollisionLiquid.js";
import type { CollisionSource } from "../game/CollisionSource.js";
import type { TerrainClient } from "../Terrain.js";
import {
  DEFAULT_COLLISION_HEIGHT, FLOOR_SEARCH_DEPTH, LIQUID_UNKNOWN, STEP_HEIGHT, newCharacterMotion, stepCharacter,
  type CharacterInput, type CharacterMotion, type LiquidAnswer, type PhysicsEvent, type TerrainProbe,
} from "../game/Physics.js";
import type { InputAction } from "./Bindings.js";

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
/**
 * How wide the character is when it has not said.
 *
 * `UNIT_FIELD_BOUNDINGRADIUS` carries the real figure and arrives with the first object update;
 * 0.389 is what a human is created with, and it is only ever used for the frame before that.
 */
const DEFAULT_RADIUS = 0.389;
/** A ceiling on the substeps: past this the frame is so long that a hitch is the real problem. */
const MAX_SUBSTEPS = 8;

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
/** Input held through a taxi flight is sent once when the server returns control. */
let wasServerControlled = false;

function ownMovementServerControlled(): boolean {
  const state = game.world?.state;
  const guid = state?.selfGuid;
  return guid !== undefined && serverControlsMovement(state?.objects.get(guid));
}

export function isAutoRunning(): boolean {
  return autoRunning;
}

export function isWalking(): boolean {
  return walking;
}

/** +1 forward, -1 back, 0 standing. Opposite keys cancel, as they do in the original client. */
export function forwardAxis(): number {
  const forward = held.has("moveForward") || autoRunning || mouseRunning;
  const backward = held.has("moveBackward");
  return forward === backward ? 0 : forward ? 1 : -1;
}

/** +1 left, -1 right. */
export function strafeAxis(): number {
  const left = held.has("strafeLeft");
  const right = held.has("strafeRight");
  return left === right ? 0 : left ? 1 : -1;
}

/** +1 left, -1 right. Turning is a rate, not a displacement: the loop integrates it. */
export function turnAxis(): number {
  const left = held.has("turnLeft");
  const right = held.has("turnRight");
  return left === right ? 0 : left ? 1 : -1;
}

/**
 * Whether the character is actually going somewhere.
 *
 * Not the same as "the flags word is non-zero": walking is a flag too, and a character standing
 * still in walk mode would otherwise send a heartbeat five times a second forever.
 */
export function isMoving(): boolean {
  if (ownMovementServerControlled()) return false;
  // Being in the air or in the water counts. A character that jumped on the spot presses no key
  // at all, and without a packet on the way down the server never follows the arc — everyone else
  // would see it standing still and then appearing where it landed.
  const rooted = game.world?.movementState.rooted === true;
  return motion.mode !== "ground" || (!rooted && (forwardAxis() !== 0 || strafeAxis() !== 0))
    || turnAxis() !== 0;
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
  const state = game.world?.movementState;
  // Physics already suppresses horizontal input during a server root. Claiming FORWARD or
  // STRAFE in MovementInfo while staying still would make the core relay a moving character.
  const forward = state?.rooted ? 0 : forwardAxis();
  if (forward > 0) flags |= MOVEMENT_FLAGS.forward;
  else if (forward < 0) flags |= MOVEMENT_FLAGS.backward;
  const strafe = state?.rooted ? 0 : strafeAxis();
  if (strafe > 0) flags |= MOVEMENT_FLAGS.strafeLeft;
  else if (strafe < 0) flags |= MOVEMENT_FLAGS.strafeRight;
  const turn = turnAxis();
  if (turn > 0) flags |= MOVEMENT_FLAGS.turnLeft;
  else if (turn < 0) flags |= MOVEMENT_FLAGS.turnRight;
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
  return flags;
}

/** The rest of the MovementInfo: the fall clock, the jump block and the pitch. */
function movementExtra(): Omit<MovementInfo, "flags" | "flags2" | "time" | "position"> {
  const extra: Omit<MovementInfo, "flags" | "flags2" | "time" | "position"> = { fallTime: Math.round(motion.fallTime) };
  if (motion.jump) extra.jump = motion.jump;
  if (motion.pitch !== 0) extra.pitch = motion.pitch;
  return extra;
}

/** How fast the character covers ground right now, in yards a second. */
export function currentSpeed(): number {
  const world = game.world;
  if (walking) return world?.speeds.get("walk") ?? DEFAULT_WALK_SPEED;
  const self = world?.state.selfGuid === undefined ? undefined : world.state.objects.get(world.state.selfGuid);
  return world?.speeds.get("run") ?? self?.runSpeed ?? DEFAULT_RUN_SPEED;
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
  if (world?.movementState.collisionHeight) return world.movementState.collisionHeight;
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
  if (!world || game.worldLoading || world.state.selfGuid === undefined) return;
  const self = world.state.objects.get(world.state.selfGuid);
  let position = self?.position;
  if (!self || !position) return;

  if (serverControlsMovement(self)) {
    if (!wasServerControlled) {
      wasServerControlled = true;
      sentForward = 0;
      sentStrafe = 0;
      sentTurn = 0;
      resetCharacterMotion();
    }
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

  // The root packet changes WorldClient.movementState, not keyboard state. Announce STOP on the
  // first frame under root and START on release if the player is still holding a movement key.
  if (world.movementState.rooted !== reportedRooted) {
    syncMovement();
    // WorldClient.sendMovement snaps the controlled object's position into a new value. Keep
    // stepping the live value, not the old object captured before the stop/start packet.
    position = self.position;
    if (!position) return;
  }

  // Turning is a rate the server also knows, so the character turns at its speed rather than at
  // whatever the frame rate happens to be.
  const turnRate = world.speeds.get("turnRate") ?? self.turnRate ?? DEFAULT_TURN_RATE;
  position.orientation = normalizeAngle(position.orientation + turnAxis() * turnRate * elapsed);

  const input: CharacterInput = {
    forward: forwardAxis(),
    strafe: strafeAxis(),
    ascend: held.has("jump"),
    // The key that sits down on land takes a swimmer down, which is what it does in the original
    // client: there is nothing to sit on in a lake.
    descend: held.has("sitOrStand"),
    // The camera's own elevation, not its negative: looking down is a negative pitch on the wire
    // as well, and swimming forward while looking down is how a dive is expressed.
    pitch: game.camera.pitch,
    runSpeed: currentSpeed(),
    swimSpeed: world.speeds.get("swim") ?? DEFAULT_SWIM_SPEED,
    flightSpeed: world.speeds.get("flight") ?? DEFAULT_FLIGHT_SPEED,
    collisionHeight: collisionHeight(self),
    radius: fieldFloat(self.fields, UPDATE_FIELDS.UNIT_FIELD_BOUNDINGRADIUS.offset, DEFAULT_RADIUS),
    rooted: world.movementState.rooted,
    waterWalking: world.movementState.waterWalking,
    featherFall: world.movementState.featherFall,
    hovering: world.movementState.hovering,
    hoverHeight: fieldFloat(self.fields, UPDATE_FIELDS.UNIT_FIELD_HOVERHEIGHT.offset, 0),
    canFly: world.movementState.canFly,
    gravityDisabled: world.movementState.gravityDisabled,
  };

  // Substeps, so a slow frame cannot walk through a wall.
  //
  // The character is pushed out of what it is standing inside rather than swept towards it, which
  // is only equivalent while a frame moves it less than its own radius. Sixty frames a second at a
  // run is an eighth of a yard and never a problem; ten frames a second on a mount is over a yard,
  // and that is a doorway missed entirely.
  const probe = terrainProbe(world.mapId);
  const radius = input.radius > 0 ? input.radius : DEFAULT_RADIUS;
  const reach = Math.max(input.runSpeed, input.swimSpeed, Math.abs(motion.velocityZ)) * elapsed;
  const substeps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(reach / (radius * 0.5))));
  for (let step = 0; step < substeps; step++) {
    for (const event of stepCharacter(position, motion, input, probe, elapsed / substeps)) {
      reportPhysicsEvent(event);
    }
  }
  reportPitch();
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
  if (motion.pitch === 0) {
    sentPitch = 0;
    return;
  }
  if (Math.abs(motion.pitch - sentPitch) < PITCH_EPSILON) return;
  sentPitch = motion.pitch;
  sendMovement(OPCODES.MSG_MOVE_SET_PITCH);
}

function selfPosition() {
  const world = game.world;
  if (!world || world.state.selfGuid === undefined) return undefined;
  return world.state.objects.get(world.state.selfGuid)?.position;
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
  game.world?.sendMovement(opcode, movementFlags(), position, movementExtra());
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
  if (!game.world?.movementReady || game.worldLoading || ownMovementServerControlled()) return;
  const rooted = game.world.movementState.rooted;
  reportedRooted = rooted;
  const forward = rooted ? 0 : forwardAxis();
  const strafe = rooted ? 0 : strafeAxis();
  const turn = turnAxis();
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
export function turnCharacterBy(radians: number): void {
  if (ownMovementServerControlled()) return;
  const position = selfPosition();
  if (!position || radians === 0) return;
  position.orientation = normalizeAngle(position.orientation + radians);
  const now = performance.now();
  if (now - facingSentAt < FACING_INTERVAL) return;
  facingSentAt = now;
  sendMovement(OPCODES.MSG_MOVE_SET_FACING);
}

/** The last word on where the character ended up, sent when the drag stops. */
export function flushFacing(): void {
  facingSentAt = performance.now();
  sendMovement(OPCODES.MSG_MOVE_SET_FACING);
}

/** A held action has gone down. Autorun ends where the original client ends it: on a walk key. */
export function beginHeld(action: InputAction): void {
  if (held.has(action)) return;
  if (action === "moveForward" || action === "moveBackward") autoRunning = false;
  held.add(action);
  syncMovement();
}

export function endHeld(action: InputAction): void {
  if (!held.delete(action)) return;
  syncMovement();
}

/** Both mouse buttons held is forward, exactly as if the key were down. */
export function setMouseRun(running: boolean): void {
  if (mouseRunning === running) return;
  mouseRunning = running;
  if (running) autoRunning = false;
  syncMovement();
}

export function toggleAutoRun(): void {
  autoRunning = !autoRunning;
  syncMovement();
}

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
  Object.assign(motion, newCharacterMotion());
  sentPitch = 0;
}

/** Forgets the state a world owned, without sending anything to a connection that is gone. */
export function forgetMovementState(): void {
  held.clear();
  autoRunning = false;
  mouseRunning = false;
  walking = false;
  sentForward = 0;
  sentStrafe = 0;
  sentTurn = 0;
  reportedRooted = false;
  wasServerControlled = false;
  sentPitch = 0;
  Object.assign(motion, newCharacterMotion());
}
