import type { WorldPosition } from "../../world/WorldState.js";
import type { KnockbackImpulse } from "../../world/KnockbackImpulse.js";

/**
 * How the character moves through the world.
 *
 * What this replaces is two lines: the height under the character was read, and if it was within
 * six yards the character was put on it. That is not a floor — it is a magnet. A cliff was walked
 * off horizontally, a jump had nowhere to go, and a lake was crossed at a run.
 *
 * The numbers are the server's own, cited where they come from, because the point of the slice is
 * that the two agree: the client's fall has to be the fall the server charges damage for.
 *
 * Pure, and deliberately: it takes a position, some state, an input and a way to ask the world
 * about a point, and it returns what changed. That is what lets a jump arc be a test rather than
 * something to go and look at.
 */

/** `Movement::gravity`, `MovementUtil.cpp:23`. Yards per second squared. */
export const GRAVITY = 19.29110527038574;
/** `Movement::terminalVelocity`, `MovementUtil.cpp:27`. */
export const TERMINAL_VELOCITY = 60.148003;
/** `Movement::terminalSafefallVelocity`: what Slow Fall and its like cap a fall at. */
export const SAFE_FALL_TERMINAL_VELOCITY = 7;

/**
 * The jump impulse.
 *
 * The client's own and in no server table. Wow.exe's jump (0x009883f0) launches with the float at
 * 0x00aa33dc, -7.955547 — negative because the client's fall speed is positive downwards; here
 * vertical speed is positive up. Against the gravity above: an apex of v²/2g = 1.64 yards.
 * (Swimming, the same function takes 0x00aa33e0, -9.096748.)
 */
export const JUMP_VELOCITY = 7.955547;

/** `DEFAULT_COLLISION_HEIGHT`, `Object.h:73`: "most common value in dbc", used when none is known. */
export const DEFAULT_COLLISION_HEIGHT = 2.03128;

/**
 * The steepest ground the character walks up rather than sliding down (5.07).
 *
 * Wow.exe's walkable test (0x0075d1c0, also 0x0075b690) compares a collision triangle's normal Z
 * with the float at 0x00a37f0c, cos 50° = 0.6427876 (cos 80° at 0x00a37f10 under another mover
 * state); the binary carries no cos 55°. The 55° this replaced was the creature navmesh's
 * `walkableSlopeAngle` (`MapBuilder.cpp:1121`), not the client's.
 */
export const MAX_WALKABLE_SLOPE_DEGREES = 50;
const MAX_WALKABLE_GRADIENT = Math.tan(MAX_WALKABLE_SLOPE_DEGREES * Math.PI / 180);

/**
 * How high a lip the character walks over (5.07).
 *
 * Wow.exe's step-up (0x00761b00, called from the move sweep 0x007620f0) sweeps the body up by the
 * budget 0x006e9520 returns, forward by max(radius + 1/720, budget · tan 50°), and back down. The
 * budget is the mover's scale ratio at mover+0xd0 for a unit this client controls (0x00716710),
 * 2.0 (0x00a4040c) for any other; 0x006e9570 sets that ratio from 0x006d78c0 as 0x006cf350's
 * total scale over the model's own, which is max(1, the object's scale): one yard for a player at
 * normal scale, whatever its race (re-2026-10-02/a9-phys-review). The 0.6 tried before was wowee's
 * (`movement_limits.hpp`), the 1.6 before that the creature navmesh's `walkableClimb`.
 */
export const STEP_HEIGHT = 1.0;

/**
 * How far the ground may drop away before the character is falling rather than walking down.
 *
 * Its own figure, deliberately not the step up: a kerb lower than this is walked down without a
 * fall (no `startFall` packet), only a drop higher than it starts one. It keeps the 1.6 yards
 * (`6 · BASE_UNIT_DIM`) the step used to be, which is what the client has always walked down.
 */
export const STEP_DOWN = 6 * 0.2666666;

/**
 * L8 5.07: how far below the feet the ground is still looked for after a step, per yard the step asked to go.
 *
 * Wow.exe 3.3.5a 12340: the frame's move 0x00762e00 hands the whole remaining distance to the ground sweep
 * 0x007620f0, which after the horizontal sweep probes down `param_4` × 1.8493990 (0x00a32830, tan 61.6°) and
 * starts a fall (0x00988370(0)) when the probe finds nothing. So the stickiness follows the step: a descent
 * steeper than 61.6° per step is a fall whatever its height, and a kerb is walked down only while it is lower
 * than the step's probe (0.09 yard for a 7 yd/s run at 144 frames a second). Here per physics substep, which
 * is the frame at 144 Hz; at lower frame rates a long frame's substeps judge a kerb by their shorter steps,
 * where Wow.exe judges it by the frame's (slopes come out the same). A character that does not step is not
 * swept at all in Wow.exe (0x00762e00 returns first); here it keeps {@link STEP_DOWN}, as before.
 * L8-review 5.07: the probe is half of the rule — the body it sweeps stands on a pyramid of the same 1.8494
 * whose face rides an edge down, so a kerb or a stair is walked down at any frame rate ({@link footHolds}).
 */
export const STEP_DOWN_PER_YARD = 1.8493989706039429;

/**
 * 5.06: how far below the surface a floating swimmer's feet are, as a share of its height.
 *
 * The server calls a body whose feet are exactly at the surface "walking on water", not "in
 * water" (`Map::GetLiquidStatus`, `Map.cpp:2538-2545`: `delta > 0` is IN_WATER, `delta >
 * collisionHeight` UNDER_WATER), so the float line has to be strictly between. 1.45 yards for a
 * 2.03-yard human is wowee's `WATER_SURFACE_OFFSET` ("shoulders out, water at the chest"); kept as
 * a ratio so a gnome does not float under water. Not confirmed in Wow.exe (no 1.45 constant).
 */
export const SWIM_SURFACE_RATIO = 1.45 / DEFAULT_COLLISION_HEIGHT;
/** How fast a swimmer that entered above the float line sinks to it, yards a second. */
export const SWIM_SETTLE_SPEED = 3;
export function swimSurfaceOffset(collisionHeight: number): number {
  const height = collisionHeight > 0 ? collisionHeight : DEFAULT_COLLISION_HEIGHT;
  return Math.min(SWIM_SURFACE_RATIO * height, 0.95 * height);
}

/** 5.12: how far under a ceiling a rising head stops. */
export const CEILING_MARGIN = 0.05;
/** 5.10: the character's own pitch never passes this, the same 85° the camera stops at. */
export const CHARACTER_PITCH_LIMIT = 85 * Math.PI / 180;
/**
 * 5.13: how long the character waits at the edge of ground that has not arrived before it walks on
 * regardless — a tile whose download failed must not freeze it for good.
 */
export const LOAD_WAIT_MAX = 3000;

/**
 * How deep the water has to be before the character swims, as a share of its own collision height.
 *
 * **Deliberately rough.** The server has no rule for the swimming flag at all — it reads it out of
 * whatever the client sends — and the one threshold it does define is fully submerged
 * (`Map::GetLiquidStatus`: `delta > collisionHeight` is under water, `delta > 0` is merely wet).
 * Swimming has to begin somewhere between the two, and half the character's height is the middle
 * of that range: waist deep, which is about where the original client starts to float.
 */
const SWIM_DEPTH_RATIO = 0.5;
/** Hysteresis, so a character standing exactly at the threshold does not flap in and out of swimming. */
const SWIM_EXIT_MARGIN = 0.25;

/**
 * The two distances a climb is judged at, and why there are two.
 *
 * Recast, which is what builds the server's own navmesh, uses exactly this pair: `walkableClimb`
 * is a discontinuity between neighbouring cells and `walkableSlopeAngle` is the angle of a face.
 * Judging both at whatever distance one frame happens to cover would make a stair passable at
 * sixty frames a second and a wall at thirty.
 *
 * `CLIMB_PROBE` is one navmesh cell (`BASE_UNIT_DIM`), which is the scale a step is defined at.
 * `SLOPE_PROBE` is a yard, which is far enough that a stair reads as a stair rather than as a
 * vertical face.
 */
const CLIMB_PROBE = 0.2666666;
const SLOPE_PROBE = 1;

/** How far apart the two probes that measure which way is uphill are. */
const GRADIENT_PROBE = 0.5;

export type MovementMode = "ground" | "air" | "swim";

/**
 * What the arc knows about itself between frames.
 *
 * `fallTime` is the one field the server reads back: `Player::UpdateFallInformationIfNeed` uses it
 * to decide when a fall began, and `HandleFall` charges damage on the height between there and the
 * landing. Sending a fall without it is a fall that costs nothing.
 */
export interface CharacterMotion {
  mode: MovementMode;
  /** Yards a second, positive up. */
  velocityZ: number;
  /** Milliseconds since the character left the ground. */
  fallTime: number;
  /** The block every airborne packet carries: the impulse, the direction, the horizontal speed. */
  jump: { velocity: number; sinAngle: number; cosAngle: number; speed: number } | undefined;
  /** Where the character is looking up or down, which is how a swimmer dives. */
  pitch: number;
  /**
   * Whether the character is deliberately rising or sinking: 1, 0 or -1.
   *
   * Its own state because the server is told about it with its own opcodes, and only when it
   * changes. There is no `MSG_MOVE_STOP_DESCEND` in this build — stopping either direction is
   * `MSG_MOVE_STOP_ASCEND`, which is why one number covers both.
   */
  vertical: number;
  /**
   * The last liquid answer at the character's own feet that was not {@link LIQUID_UNKNOWN}, and
   * where it was given. An unknown answer within {@link LIQUID_RECALL_YARDS} of that point is read
   * as this one, which is what keeps a swimmer swimming and a walker walking while the collision
   * around them streams in; further away an unknown answer is read as dry.
   */
  liquid: { x: number; y: number; surface: LiquidSurface | undefined } | undefined;
  /** 5.13: milliseconds in a row the ground ahead has answered "not loaded"; capped by {@link LOAD_WAIT_MAX}. */
  loadWait: number;
  /** 5.09: the last airborne frame was flown, so losing flight mid-air starts a fall from here. */
  airFlight: boolean;
  /**
   * 5.01: a knock back's ground velocity, world frame, yards a second. While set the keys do not
   * steer; it ends on landing, in water, or when flight takes over.
   */
  drift: { vx: number; vy: number } | undefined;
}

export function newCharacterMotion(): CharacterMotion {
  return {
    mode: "ground", velocityZ: 0, fallTime: 0, jump: undefined, pitch: 0, vertical: 0, liquid: undefined,
    loadWait: 0, airFlight: false, drift: undefined,
  };
}

/** A liquid surface: its world height, and the kind id its source carries. */
export interface LiquidSurface {
  height: number;
  type: number;
}

/**
 * What a liquid query answers while the world that decides it has not arrived — not the same
 * thing as dry.
 *
 * Whose water the feet are in is the WMO group of the floor under them (`VMapManager2::
 * getAreaAndLiquidData`), and that floor is streamed collision. Reading "not loaded yet" as "no
 * water" drops a swimmer onto the bed for the frames a tile takes to arrive and starts the swim
 * again when it does: a stop/start packet pair and an animation flicker per tile.
 */
export const LIQUID_UNKNOWN = Symbol("liquid not answered yet");
export type LiquidAnswer = LiquidSurface | undefined | typeof LIQUID_UNKNOWN;

/**
 * How far from its last known answer an unknown one is still read as that answer: one cell of
 * either liquid grid — the map file's 128 per tile, and a WMO's `MLIQ` on the same pitch.
 */
export const LIQUID_RECALL_YARDS = 533.3333333333334 / 128;

/** What the world answers about a point. Handed in so the simulation can be run over a fake one. */
export interface TerrainProbe {
  /** Ground height under a point, or undefined while that tile has not arrived. */
  ground(x: number, y: number): number | undefined;
  /**
   * The liquid a body whose feet are at `z` is in or over, or {@link LIQUID_UNKNOWN}.
   *
   * The height matters. The server asks it of the floor under those feet — a room's own `MLIQ`,
   * and the map file's water only where no interior room is in the way (`Map::
   * GetFullTerrainStatusForPosition`) — so the same column can be a lake at the bottom and a dry
   * gallery above it.
   */
  liquid(x: number, y: number, z: number): LiquidAnswer;
  /** A hole in the ground: the tile says there is no floor here at all. */
  hole(x: number, y: number): boolean;
  /**
   * The highest surface of the server's own collision geometry between two heights, if any is
   * loaded. This is what a tavern's first floor is: the terrain says one height, the building says
   * another, and the one nearer the feet from above wins.
   */
  floor?(x: number, y: number, fromZ: number, minZ: number): number | undefined;
  /** Where the character ends up once pushed out of whatever wall it walked into. */
  pushOut?(x: number, y: number, z: number, radius: number, bodyHeight: number): { x: number; y: number };
  /** 5.12: the lowest flat surface over a point between two heights — what a rising head meets. */
  ceiling?(x: number, y: number, fromZ: number, toZ: number): number | undefined;
  /**
   * 5.13: false while the ground or collision at a point is still on its way. Absent means loaded.
   * The character waits at the edge of such ground rather than walking or falling into it.
   */
  loaded?(x: number, y: number): boolean;
}

/**
 * How far below the character a floor is looked for.
 *
 * Generous, because a falling character has to find what it is going to land on, and the search is
 * over one column of one building's grid either way.
 */
export const FLOOR_SEARCH_DEPTH = 400;

export interface CharacterInput {
  /** -1 to 1, along the facing. */
  forward: number;
  /** -1 to 1, to the left of the facing. */
  strafe: number;
  /** Space: a jump on the ground, a rise in water or in the air. */
  ascend: boolean;
  descend: boolean;
  /** The character's own pitch (5.10), which is the direction a swimmer or flier goes. */
  pitch: number;
  runSpeed: number;
  swimSpeed: number;
  flightSpeed: number;
  /** 5.08: the backward rates; absent means the forward one. */
  runBackSpeed?: number;
  swimBackSpeed?: number;
  flightBackSpeed?: number;
  /** 5.11: `UNIT_FLAG_STUNNED` on the mover — no step, no jump, no rise. */
  stunned?: boolean;
  /** From the character's own model, through `CreatureModelData.CollisionHeight`. */
  collisionHeight: number;
  /** `UNIT_FIELD_BOUNDINGRADIUS`, which is how wide the server says this character is. */
  radius: number;
  /** Everything the server has forced on this character and expects to be obeyed. */
  rooted: boolean;
  waterWalking: boolean;
  featherFall: boolean;
  hovering: boolean;
  hoverHeight: number;
  canFly: boolean;
  gravityDisabled: boolean;
  /**
   * L8-review 5.07: how many substeps this frame is cut into (Movement.advancePhysics); absent is one. Wow.exe
   * judges an edge by the frame's whole step (0x00762e00 hands it to 0x007620f0), see {@link footHolds}.
   */
  frameSubsteps?: number;
}

/**
 * What changed, in the order it changed. Each one is a packet the server is waiting for: a jump it
 * has not been told about is a jump it will not see, and a landing it has not been told about is a
 * fall that goes on forever as far as `m_lastFallZ` is concerned.
 */
export type PhysicsEvent =
  | "jump" | "startFall" | "land"
  | "startSwim" | "stopSwim"
  | "startAscend" | "stopAscend" | "startDescend";

/**
 * Whether the character falls at all.
 *
 * Two different permissions, both the server's to give and neither of them the client's to assume:
 * `SMSG_MOVE_SET_CAN_FLY` is a flying mount, `SMSG_MOVE_GRAVITY_DISABLE` is levitation. Either one
 * means gravity stops applying and the altitude becomes something the player steers.
 */
function isFlying(input: CharacterInput): boolean {
  return input.gravityDisabled || input.canFly;
}

/**
 * The floor at a point, which is very often not the ground.
 *
 * Four things can be the thing under a character's feet: the height field (unless its ADT chunk is
 * a hole), the server's own collision geometry, which is what a building's floors are, and the
 * surface of water for someone walking on it. An ADT hole removes only terrain. WMOs deliberately
 * sit over such cut-outs, so returning before the VMAP query drops the character through the very
 * tavern/city floor the hole was authored to expose. The highest usable surface wins — which is
 * why standing under a bridge stands on the ground and standing on it stands on the bridge.
 */
function floorAt(
  probe: TerrainProbe, input: CharacterInput, motion: CharacterMotion, x: number, y: number, z: number,
): number | undefined {
  const floor = solidFloor(probe, x, y, z);
  if (floor === undefined) return undefined;
  return standingHeight(floor, input.waterWalking ? liquidOver(probe, motion, x, y, z) : undefined, input);
}

/** The ground and the collision geometry: the part of the floor that is not water or levitation. */
function solidFloor(probe: TerrainProbe, x: number, y: number, z: number): number | undefined {
  let floor = probe.hole(x, y) ? undefined : probe.ground(x, y);
  const solid = probe.floor?.(x, y, z + STEP_HEIGHT, z - FLOOR_SEARCH_DEPTH);
  if (solid !== undefined && (floor === undefined || solid > floor)) floor = solid;
  return floor;
}

/** A solid floor raised to the water for a water walker, and to the hover height for a levitator. */
function standingHeight(floor: number | undefined, liquid: LiquidSurface | undefined, input: CharacterInput): number | undefined {
  if (floor === undefined) return undefined;
  const surface = input.waterWalking ? liquid?.height : undefined;
  if (surface !== undefined && surface > floor) floor = surface;
  return input.hovering ? floor + input.hoverHeight : floor;
}

/** The last known answer, when an unknown one is asked for near enough to it. */
function recalledLiquid(motion: CharacterMotion, x: number, y: number): LiquidSurface | undefined {
  const last = motion.liquid;
  if (last === undefined) return undefined;
  return Math.hypot(x - last.x, y - last.y) <= LIQUID_RECALL_YARDS ? last.surface : undefined;
}

/** The liquid over any point the step looks at, reading an unknown answer as the last known one. */
function liquidOver(probe: TerrainProbe, motion: CharacterMotion, x: number, y: number, z: number): LiquidSurface | undefined {
  const answer = probe.liquid(x, y, z);
  return answer === LIQUID_UNKNOWN ? recalledLiquid(motion, x, y) : answer;
}

/** The liquid at the character's own feet. Known answers are remembered for the unknown ones. */
function feetLiquid(probe: TerrainProbe, motion: CharacterMotion, x: number, y: number, z: number): LiquidSurface | undefined {
  const answer = probe.liquid(x, y, z);
  if (answer === LIQUID_UNKNOWN) return recalledLiquid(motion, x, y);
  const last = motion.liquid;
  if (last === undefined) {
    motion.liquid = { x, y, surface: answer };
  } else {
    last.x = x;
    last.y = y;
    last.surface = answer;
  }
  return answer;
}

/** The light slot follows the camera eye crossing the surface, not the character's swim state. */
export function eyeUnderwater(
  eyeZ: number,
  liquid: { height: number } | undefined,
): boolean {
  return liquid !== undefined
    && Number.isFinite(eyeZ)
    && Number.isFinite(liquid.height)
    && eyeZ < liquid.height;
}

/**
 * The one liquid surface the screen is looking through, for the frames where there is one.
 *
 * `eyeUnderwater` answers a boolean because a light slot is a boolean; the underwater screen
 * effect needs the surface itself — how high it is and what kind of liquid it belongs to — and it
 * needs it slightly before the eye passes it, because the near plane cuts the water first.
 */
export interface EyeLiquidSurface {
  /** World Z of the surface over the eye. */
  readonly height: number;
  /** `LiquidType.dbc` row, or 0 where only the map file's flag byte is known. */
  readonly entry: number;
  /** The map file's liquid flag byte; 0 for a WMO's own `MLIQ` grid, which carries no flags. */
  readonly flags: number;
}

/**
 * Which of the two liquid sources the eye is looking through, and how high its surface is.
 *
 * The building wins where it answers at all, and that is not a preference: the WMO candidate is
 * only ever built from the *authoritative floor group* the collision step already selected for this
 * camera, so a room that reports liquid is the room the camera is standing in. The map file's lake
 * over the roof is the outdoor answer and belongs to the frame where the building has none.
 *
 * `band` is how far above the surface the answer still counts — the near plane's half-height, the
 * only slab of world that can be half in the water while the eye is not (wowee
 * `renderer.cpp:2871-2875`).
 */
/**
 * How far above a liquid surface the eye still counts as looking through it, for the two callers
 * that sample liquid before the renderer sees the frame.
 *
 * Deliberately a round half yard rather than the renderer's exact crossing band: that band is a
 * property of the camera's near plane and field of view, both of which live in the renderer, and
 * the renderer re-derives and re-tests it there from its own camera. This one only has to be a
 * superset — offering a surface the renderer then declines costs one comparison, while missing one
 * it wanted would cost the effect. Measured against it: the world camera's band is 0.122 yards.
 */
export const EYE_LIQUID_SAMPLE_BAND = 0.5;

export function eyeLiquidSurface(
  eyeZ: number,
  band: number,
  wmo: EyeLiquidSurface | undefined,
  terrain: EyeLiquidSurface | undefined,
): EyeLiquidSurface | undefined {
  if (!Number.isFinite(eyeZ)) return undefined;
  const reach = Number.isFinite(band) && band > 0 ? band : 0;
  for (const candidate of [wmo, terrain]) {
    if (!candidate || !Number.isFinite(candidate.height)) continue;
    if (eyeZ < candidate.height + reach) return candidate;
  }
  return undefined;
}

/**
 * Whether going this way means climbing something that cannot be climbed.
 *
 * Two questions, both asked at their own fixed distance rather than at the length of this frame's
 * step. A cell ahead: has the ground jumped by more than a step, which is a wall. A yard ahead: is
 * it still rising, and steeply, which is a slope. Anything within one step height is always
 * allowed, because that is what a step is — a stair is not refused for being vertical.
 */
function climbs(probe: TerrainProbe, input: CharacterInput, motion: CharacterMotion,
  x: number, y: number, z: number, moveX: number, moveY: number): boolean {
  const run = Math.sqrt(moveX * moveX + moveY * moveY);
  if (run < 1e-6) return false;
  const from = floorAt(probe, input, motion, x, y, z);
  if (from === undefined) return false;
  const dirX = moveX / run;
  const dirY = moveY / run;

  const near = floorAt(probe, input, motion, x + dirX * CLIMB_PROBE, y + dirY * CLIMB_PROBE, z);
  if (near !== undefined && near - from > STEP_HEIGHT) return true;

  const far = floorAt(probe, input, motion, x + dirX * SLOPE_PROBE, y + dirY * SLOPE_PROBE, z);
  if (far === undefined) return false;
  const rise = far - from;
  return rise > STEP_HEIGHT && rise / SLOPE_PROBE > MAX_WALKABLE_GRADIENT;
}

/** `slideAlongSlope`'s answer, written in place: the step runs per physics substep. */
const SLID = { dx: 0, dy: 0 };

/**
 * Slides a move that would climb too steeply along the hill instead of up it, into {@link SLID}.
 *
 * The uphill direction is the terrain gradient, measured with two probes either side. Only the
 * uphill part of the move is taken away, so a player pressed against a cliff still walks along it
 * and still walks away from it — which is what makes a steep hillside passable rather than sticky.
 *
 * This step only handles terrain height. `stepCharacter` resolves server VMAP walls with
 * `probe.pushOut` after the horizontal step and before asking for the floor height.
 */
function slideAlongSlope(probe: TerrainProbe, input: CharacterInput, motion: CharacterMotion,
  x: number, y: number, z: number, dx: number, dy: number): void {
  SLID.dx = dx;
  SLID.dy = dy;
  if (!climbs(probe, input, motion, x, y, z, dx, dy)) return;
  SLID.dx = 0;
  SLID.dy = 0;

  const here = probe.ground(x, y);
  const east = probe.ground(x + GRADIENT_PROBE, y);
  const west = probe.ground(x - GRADIENT_PROBE, y);
  const north = probe.ground(x, y + GRADIENT_PROBE);
  const south = probe.ground(x, y - GRADIENT_PROBE);
  if (here === undefined || east === undefined || west === undefined || north === undefined || south === undefined) return;
  const gradientX = (east - west) / (2 * GRADIENT_PROBE);
  const gradientY = (north - south) / (2 * GRADIENT_PROBE);
  const length = Math.hypot(gradientX, gradientY);
  if (length < 1e-6) return;

  const uphillX = gradientX / length;
  const uphillY = gradientY / length;
  const along = dx * uphillX + dy * uphillY;
  // Only the uphill half is removed: going down the same slope is always allowed.
  if (along <= 0) return;
  const slidX = dx - along * uphillX;
  const slidY = dy - along * uphillY;
  if (climbs(probe, input, motion, x, y, z, slidX, slidY)) return;
  SLID.dx = slidX;
  SLID.dy = slidY;
}

/**
 * 5.13: whether the ground at a point is still on its way and the character should wait for it.
 *
 * Counts the wait: past {@link LOAD_WAIT_MAX} milliseconds in a row the answer is ignored (the
 * old behaviour), and a "loaded" answer resets the count.
 */
function awaitingGround(probe: TerrainProbe, motion: CharacterMotion, x: number, y: number, elapsed: number): boolean {
  if (!probe.loaded) return false;
  if (probe.loaded(x, y)) {
    motion.loadWait = 0;
    return false;
  }
  if (motion.loadWait >= LOAD_WAIT_MAX) return false;
  motion.loadWait += elapsed * 1000;
  return true;
}

/** Offsets of the four rim probes of a head, as shares of the radius (5.12). */
const CEILING_RIM = 0.7;

/**
 * 5.12: stops a rising head under whatever is over it.
 *
 * Asked only while going up, so walking costs nothing. Five columns — the centre and four on the
 * rim — between where the head was and where it is now; the lowest ceiling wins. `fallTime` is
 * left alone: the server charges a fall from the top of the arc, wherever that ended up.
 */
function clampToCeiling(position: WorldPosition, motion: CharacterMotion, probe: TerrainProbe,
  zBefore: number, collisionHeight: number, radius: number): void {
  if (!probe.ceiling || position.z <= zBefore) return;
  const from = zBefore + collisionHeight;
  const to = position.z + collisionHeight + CEILING_MARGIN;
  const rim = radius > 0 ? radius * CEILING_RIM : 0;
  let lowest = Infinity;
  for (let probeIndex = 0; probeIndex < 5; probeIndex++) {
    const ox = probeIndex === 1 ? rim : probeIndex === 2 ? -rim : 0;
    const oy = probeIndex === 3 ? rim : probeIndex === 4 ? -rim : 0;
    const ceiling = probe.ceiling(position.x + ox, position.y + oy, from, to);
    if (ceiling !== undefined && ceiling < lowest) lowest = ceiling;
  }
  if (lowest === Infinity) return;
  position.z = Math.max(zBefore, lowest - collisionHeight - CEILING_MARGIN);
  if (motion.velocityZ > 0) motion.velocityZ = 0;
}

/** The forward or the backward rate, by the sign of the forward axis (5.08). */
function directed(forward: number, ahead: number, back: number | undefined): number {
  return forward < 0 && back !== undefined ? back : ahead;
}

/**
 * Advances the character by one frame, and says what the server has to be told.
 *
 * `position` and `motion` are written in place: they are the live state the renderer draws and the
 * packets are built from, and copying them would mean deciding who owns the copy. `events` may be
 * handed in to be reused (it is cleared first), which keeps the per-substep path allocation-free.
 */
export function stepCharacter(
  position: WorldPosition,
  motion: CharacterMotion,
  input: CharacterInput,
  probe: TerrainProbe,
  elapsed: number,
  events: PhysicsEvent[] = [],
): PhysicsEvent[] {
  // Only when there is something to clear: shrinking an array's length is a runtime call in V8
  // (≈30 ns, measured), and almost every substep reports nothing.
  if (events.length !== 0) events.length = 0;
  if (elapsed <= 0) return events;

  const collisionHeight = input.collisionHeight > 0 ? input.collisionHeight : DEFAULT_COLLISION_HEIGHT;
  const swimDepth = collisionHeight * SWIM_DEPTH_RATIO;
  const flying = isFlying(input);
  const pitch = Math.max(-CHARACTER_PITCH_LIMIT, Math.min(CHARACTER_PITCH_LIMIT, input.pitch));
  motion.pitch = motion.mode === "swim" || flying ? pitch : 0;

  // A rooted character still falls: root stops it walking, not being subject to gravity (5.11).
  // A stun stops the same and the jump with it; root alone already forbids the jump in Wow.exe
  // (0x009883f0 refuses it with ROOT, FALLING or FLYING in the flags).
  const held = input.rooted || input.stunned === true;
  const forward = held ? 0 : input.forward;
  const strafe = held ? 0 : input.strafe;
  const ascend = !held && input.ascend;
  const descend = !held && input.descend;

  // 5.08/5.09: the rate by mode and direction. On the ground the run rate even with flight allowed;
  // in the air the flight rate live while flying (an ACK changes it next frame), otherwise the rate
  // the jump left the ground with.
  const horizontalSpeed = motion.mode === "swim" ? directed(forward, input.swimSpeed, input.swimBackSpeed)
    : motion.mode === "air"
      ? flying ? directed(forward, input.flightSpeed, input.flightBackSpeed) : motion.jump?.speed ?? input.runSpeed
      : directed(forward, input.runSpeed, input.runBackSpeed);

  let dx = 0;
  let dy = 0;
  let requested = 0; // L8 5.07: the step's length as asked for, before walls and slopes (STEP_DOWN_PER_YARD)
  const fromX = position.x; // L8-review 5.07: where the step began (footHolds)
  const fromY = position.y; // L8-review 5.07
  // 5.01: a knock back carries the body along its own ground velocity until it lands, swims or
  // flies; the keys do not steer it.
  const drift = motion.drift;
  const drifting = drift !== undefined && motion.mode === "air" && !flying;
  if (drift !== undefined && !drifting) motion.drift = undefined;
  // `Math.sqrt` rather than `Math.hypot`: the latter is ≈15 ns slower per call in V8 (measured).
  const length = drifting ? 0 : Math.sqrt(forward * forward + strafe * strafe);
  if (drifting) {
    dx = drift.vx * elapsed;
    dy = drift.vy * elapsed;
  } else if (length > 0) {
    const cosine = Math.cos(position.orientation);
    const sine = Math.sin(position.orientation);
    // Swimming or flying forward follows the pitch, so looking down and going forward is a dive.
    // The horizontal part is what is left of the speed once the vertical part has been taken.
    const planar = motion.mode === "swim" || (motion.mode === "air" && flying) ? Math.cos(motion.pitch) : 1;
    const distance = horizontalSpeed * elapsed * planar;
    requested = distance; // L8 5.07
    dx = (cosine * (forward / length) - sine * (strafe / length)) * distance;
    dy = (sine * (forward / length) + cosine * (strafe / length)) * distance;
  }

  if (motion.mode === "ground" && (dx !== 0 || dy !== 0)) {
    slideAlongSlope(probe, input, motion, position.x, position.y, position.z, dx, dy);
    dx = SLID.dx;
    dy = SLID.dy;
  }
  // 5.13: ground that has not arrived is waited at, not walked onto.
  if ((dx !== 0 || dy !== 0) && motion.mode !== "swim" && !(motion.mode === "air" && flying)
    && awaitingGround(probe, motion, position.x + dx, position.y + dy, elapsed)) {
    dx = 0;
    dy = 0;
  }
  position.x += dx;
  position.y += dy;

  // Out of whatever it walked into. Deliberately after the slope slide and before anything
  // vertical: a wall decides where the character is standing, and only then is it asked what it is
  // standing on.
  if (probe.pushOut) {
    const out = probe.pushOut(position.x, position.y, position.z, input.radius, collisionHeight);
    position.x = out.x;
    position.y = out.y;
  }

  // The solid floor first and the liquid second, at the same feet: a probe that walks the collision
  // column for the one can answer the other from the same walk.
  const solid = solidFloor(probe, position.x, position.y, position.z);
  const liquid = feetLiquid(probe, motion, position.x, position.y, position.z);
  const floor = standingHeight(solid, liquid, input);
  const depth = liquid === undefined ? undefined : liquid.height - position.z;

  if (motion.mode === "swim") {
    stepSwimming(position, motion, input, probe, elapsed, floor, liquid, swimDepth, collisionHeight,
      forward, ascend, descend, horizontalSpeed, events);
  } else if (motion.mode === "air") {
    stepAirborne(position, motion, input, probe, elapsed, floor, swimDepth, collisionHeight,
      forward, ascend, descend, horizontalSpeed, events);
  } else {
    stepGrounded(position, motion, input, probe, elapsed, floor, depth, swimDepth, ascend, horizontalSpeed, events,
      requested, fromX, fromY); // L8 5.07: `requested`; L8-review 5.07: `fromX, fromY`
  }

  return events;
}

/** Records a change of vertical intent and names the opcode the server is waiting for. */
function setVertical(motion: CharacterMotion, wanted: number, events: PhysicsEvent[]): void {
  if (wanted === motion.vertical) return;
  motion.vertical = wanted;
  events.push(wanted > 0 ? "startAscend" : wanted < 0 ? "startDescend" : "stopAscend");
}

function beginSwim(motion: CharacterMotion, events: PhysicsEvent[]): void {
  motion.mode = "swim";
  motion.drift = undefined;
  motion.velocityZ = 0;
  motion.fallTime = 0;
  motion.jump = undefined;
  motion.airFlight = false;
  events.push("startSwim");
}

/** On solid ground nothing is rising or sinking, and the server has to hear that it stopped. */
function clearVertical(motion: CharacterMotion, events: PhysicsEvent[]): void {
  setVertical(motion, 0, events);
}

/** The jump block every airborne packet carries, written into the motion's own (5.13: no allocation per fall). */
function setJump(motion: CharacterMotion, velocity: number, orientation: number, speed: number): void {
  const jump = motion.jump;
  if (jump) {
    jump.velocity = velocity;
    jump.sinAngle = Math.sin(orientation);
    jump.cosAngle = Math.cos(orientation);
    jump.speed = speed;
  } else {
    motion.jump = { velocity, sinAngle: Math.sin(orientation), cosAngle: Math.cos(orientation), speed };
  }
}

function beginFall(motion: CharacterMotion, velocityZ: number, orientation: number, speed: number,
  events: PhysicsEvent[], kind: "jump" | "startFall"): void {
  motion.mode = "air";
  motion.velocityZ = velocityZ;
  motion.fallTime = 0;
  motion.airFlight = false;
  // The direction is the one the character left the ground in; the server echoes it back to
  // everyone watching, and it is what makes a jump land where it was aimed.
  setJump(motion, velocityZ, orientation, speed);
  events.push(kind);
}

function stepGrounded(
  position: WorldPosition, motion: CharacterMotion, input: CharacterInput, probe: TerrainProbe,
  elapsed: number, floor: number | undefined, depth: number | undefined, swimDepth: number,
  ascend: boolean, horizontalSpeed: number, events: PhysicsEvent[],
  requested = 0, // L8 5.07
  fromX = position.x, fromY = position.y, // L8-review 5.07
): void {
  if (depth !== undefined && depth > swimDepth && !input.waterWalking) {
    beginSwim(motion, events);
    return;
  }
  // A tile that has not arrived is not a hole: the character waits on it rather than falling
  // through a world that is merely still loading.
  if (floor === undefined) {
    if (probe.hole(position.x, position.y)) beginFall(motion, 0, position.orientation, horizontalSpeed, events, "startFall");
    return;
  }
  if (ascend) {
    // On a flying mount this is the take-off: the jump starts it, and the next frame finds
    // gravity switched off and the character rising while the key is held.
    beginFall(motion, JUMP_VELOCITY, position.orientation, horizontalSpeed, events, "jump");
    return;
  }
  const drop = position.z - floor;
  // L8 5.07: a step probes down in proportion to its length (Wow.exe 0x007620f0); standing still, as before.
  if (drop > (requested > 0 ? requested * STEP_DOWN_PER_YARD : STEP_DOWN) // L8 5.07: was `drop > STEP_DOWN`
    && !(requested > 0 && footHolds(position, motion, input, probe, fromX, fromY, drop, requested))) { // L8-review 5.07
    beginFall(motion, 0, position.orientation, horizontalSpeed, events, "startFall");
    return;
  }
  // A wall of terrain taller than a step: the character stays where it was rather than being
  // teleported to the top of it. The hover height is added to the allowance, because the frame a
  // levitation starts on is one where the floor is suddenly that much higher and rising to it is
  // not a climb.
  const hover = input.hovering ? input.hoverHeight : 0;
  if (floor - position.z > STEP_HEIGHT + hover) return;
  position.z = floor;
}

/** L8-review 5.07: how far past the foot's reach a ground answer still counts as touching it (0x00a37f14, 1/720). */
const FOOT_SKIN = 1 / 720;
/**
 * L8-review 5.07: how many times the foot looks further along before it gives up. Each look moves to where the
 * face meets the ground last found; over a bevel steeper than the face that doubles the distance each time.
 */
const FOOT_LOOKS = 8;

/**
 * L8-review 5.07: whether the edge a step just went over still holds the character, when the floor under the
 * feet fell away further than the step's probe ({@link STEP_DOWN_PER_YARD}) reaches.
 *
 * Wow.exe 3.3.5a 12340: the body the ground sweep 0x0075f9d0 moves is built by 0x0075ca80 out of 0x0075c8f0's
 * planes — four sides at ± the half-width (mover+0xc8), the top, and four faces through the feet whose normals
 * are (±0.8796, 0, −0.4756) and (0, ±0.8796, −0.4756): a box over an upside-down pyramid of 61.6° faces, its
 * corners at the feet and at half-width × 1.8494 above them (0x00a32830, the probe's own constant). Off an edge a
 * face rests on it and slides down 1.8494 per yard, which is exactly what the probe of 0x007620f0 reaches, so a
 * kerb or a riser is walked down; the probe comes back empty only when the ground falls away steeper than the
 * face (a slope past 61.6°) or the edge has left the foot (a drop deeper than half-width × 1.8494, give or take
 * the next frame's probe).
 *
 * The feet here are a point, so the face is followed from where the step began along its direction: the ground
 * has to come up to it (`need ≤ along × 1.8494`) within the half-width plus the frame's whole step — the larger
 * of Wow.exe's two cases, so a drop at the boundary is walked down, as before 5.07. The answer is a snap down,
 * not Wow.exe's slide along the face. The half-width is `UNIT_FIELD_BOUNDINGRADIUS` (0.389 for any player);
 * Wow.exe's is half the model's CollisionWidth (0.306 for a human male, 0x006e9570), so the foot here holds
 * 0.15 yard more. Asked only when the floor fell away past the probe: never on ground the probe follows.
 */
function footHolds(position: WorldPosition, motion: CharacterMotion, input: CharacterInput, probe: TerrainProbe,
  fromX: number, fromY: number, drop: number, requested: number): boolean {
  const moveX = position.x - fromX;
  const moveY = position.y - fromY;
  const moved = Math.sqrt(moveX * moveX + moveY * moveY);
  // Walked into a wall: nothing was stepped over, so the floor that fell is judged as under a standing body.
  if (!(moved > 1e-6)) return drop <= STEP_DOWN;
  const reach = (input.radius > 0 ? input.radius : 0) + requested * (input.frameSubsteps ?? 1);
  const z = position.z;
  let along = drop / STEP_DOWN_PER_YARD;
  for (let look = 0; look < FOOT_LOOKS && along <= reach; look++) {
    const x = fromX + moveX / moved * along;
    const y = fromY + moveY / moved * along;
    const ground = standingHeight(solidFloor(probe, x, y, z),
      input.waterWalking ? liquidOver(probe, motion, x, y, z) : undefined, input);
    // Ground that has not arrived is no reason to fall (5.13); a hole is.
    if (ground === undefined) return !probe.hole(x, y);
    const need = z - ground;
    if (need <= along * STEP_DOWN_PER_YARD + FOOT_SKIN) return true;
    along = need / STEP_DOWN_PER_YARD;
  }
  return false;
}

function stepAirborne(
  position: WorldPosition, motion: CharacterMotion, input: CharacterInput, probe: TerrainProbe,
  elapsed: number, floor: number | undefined, swimDepth: number, collisionHeight: number,
  forward: number, ascend: boolean, descend: boolean, horizontalSpeed: number, events: PhysicsEvent[],
): void {
  const zBefore = position.z;
  if (isFlying(input)) {
    motion.airFlight = true;
    const rise = (ascend ? 1 : 0) - (descend ? 1 : 0);
    setVertical(motion, rise, events);
    // 5.09: going forward follows the pitch, as it does under water.
    const pitched = forward !== 0 ? Math.sin(motion.pitch) * horizontalSpeed * Math.sign(forward) : 0;
    motion.velocityZ = rise * input.flightSpeed + pitched;
    motion.fallTime = 0;
    position.z += motion.velocityZ * elapsed;
    clampToCeiling(position, motion, probe, zBefore, collisionHeight, input.radius);
    if (floor !== undefined && position.z <= floor) land(position, motion, floor, events);
    return;
  }
  if (motion.airFlight) {
    // 5.09: flight ended in the air (the mount was dismissed): a fall begins here, at the rate the
    // character runs, not at the rate it flew.
    motion.airFlight = false;
    motion.velocityZ = 0;
    motion.fallTime = 0;
    setJump(motion, 0, position.orientation, input.runSpeed);
    clearVertical(motion, events);
  }
  // 5.13: over ground that has not arrived, the fall waits rather than running up a fall clock.
  if (floor === undefined && awaitingGround(probe, motion, position.x, position.y, elapsed)) return;

  const terminal = input.featherFall ? SAFE_FALL_TERMINAL_VELOCITY : TERMINAL_VELOCITY;
  motion.velocityZ = Math.max(-terminal, motion.velocityZ - GRAVITY * elapsed);
  position.z += motion.velocityZ * elapsed;
  motion.fallTime += elapsed * 1000;
  clampToCeiling(position, motion, probe, zBefore, collisionHeight, input.radius);

  // Measured again after the drop rather than before it: at terminal velocity a frame is a yard,
  // and a yard is the difference between hitting the water and hitting the bottom of the lake.
  const liquid = feetLiquid(probe, motion, position.x, position.y, position.z);
  const submerged = liquid === undefined ? undefined : liquid.height - position.z;
  // Water breaks a fall before the ground does, and the server agrees: it is the liquid level that
  // decides, not the lake bed.
  if (submerged !== undefined && submerged > swimDepth && !input.waterWalking) {
    beginSwim(motion, events);
    return;
  }
  if (floor !== undefined && position.z <= floor) land(position, motion, floor, events);
}

function land(position: WorldPosition, motion: CharacterMotion, floor: number, events: PhysicsEvent[]): void {
  position.z = floor;
  motion.mode = "ground";
  motion.velocityZ = 0;
  motion.jump = undefined;
  motion.airFlight = false;
  motion.drift = undefined;
  clearVertical(motion, events);
  // `fallTime` is left standing until the landing packet is built: it is the whole of what the
  // server needs to charge the fall, and clearing it here would send a fall of zero milliseconds.
  events.push("land");
}

function stepSwimming(
  position: WorldPosition, motion: CharacterMotion, input: CharacterInput, probe: TerrainProbe,
  elapsed: number, floor: number | undefined, liquid: LiquidSurface | undefined, swimDepth: number,
  collisionHeight: number, forward: number, ascend: boolean, descend: boolean, horizontalSpeed: number,
  events: PhysicsEvent[],
): void {
  const surface = liquid?.height;
  if (surface === undefined) {
    // Swum out over dry land: fall the rest of the way rather than hanging in the air.
    motion.mode = "air";
    motion.velocityZ = 0;
    motion.fallTime = 0;
    setJump(motion, 0, position.orientation, input.swimSpeed);
    events.push("stopSwim", "startFall");
    return;
  }

  const zBefore = position.z;
  const rise = (ascend ? 1 : 0) - (descend ? 1 : 0);
  setVertical(motion, rise, events);
  // Two ways down: the down key, and going forward while pitched down — the character's own pitch
  // (5.10), which the right-button steer or the pitch keys set, not the camera's resting tilt.
  const dive = forward !== 0 ? Math.sin(motion.pitch) * horizontalSpeed * Math.sign(forward) : 0;
  motion.velocityZ = rise * input.swimSpeed + dive;
  position.z += motion.velocityZ * elapsed;
  clampToCeiling(position, motion, probe, zBefore, collisionHeight, input.radius);

  // 5.06: the float line is under the surface, not on it: feet at the surface are "walking on
  // water" to the server. A swimmer above it (entering waist deep, falling in) sinks to it at
  // SWIM_SETTLE_SPEED rather than in one frame; one rising is held at it at once.
  const floatZ = surface - swimSurfaceOffset(collisionHeight);
  if (position.z > floatZ) {
    position.z = rise > 0 || zBefore <= floatZ ? floatZ
      : Math.max(floatZ, Math.min(position.z, zBefore - SWIM_SETTLE_SPEED * elapsed));
  }
  if (floor !== undefined && position.z < floor) position.z = floor;

  // Swimming ends in the shallows, not at the surface.
  //
  // Measured against the bottom rather than against the swimmer: floating with your head out of
  // the water is still swimming, and reading the distance to the surface would end it the instant
  // the character reached the top — and then start it again the instant it sank back, for ever.
  // Water this shallow is water you can stand up in, which is the mirror of how it began.
  if (floor !== undefined && surface - floor < swimDepth - SWIM_EXIT_MARGIN) {
    motion.mode = "ground";
    motion.velocityZ = 0;
    clearVertical(motion, events);
    events.push("stopSwim");
  }
}

/**
 * 5.01: a knock back (`SMSG_MOVE_KNOCK_BACK`, already acknowledged by `WorldClient`): airborne
 * with `upSpeed` and a fall clock of 0, carried across the ground at `(cos, sin) · speedXY`.
 *
 * The jump block is the physical one (velocity up positive); the packet writer turns it into the
 * wire's sign, which is then exactly `knockbackJump(impulse)`. Nothing is reported: the
 * acknowledgement was the packet.
 */
export function applyImpulse(motion: CharacterMotion, impulse: KnockbackImpulse): void {
  motion.mode = "air";
  motion.velocityZ = impulse.upSpeed;
  motion.fallTime = 0;
  motion.airFlight = false;
  motion.vertical = 0;
  const jump = motion.jump;
  if (jump) {
    jump.velocity = impulse.upSpeed;
    jump.sinAngle = impulse.sin;
    jump.cosAngle = impulse.cos;
    jump.speed = impulse.speedXY;
  } else {
    motion.jump = { velocity: impulse.upSpeed, sinAngle: impulse.sin, cosAngle: impulse.cos, speed: impulse.speedXY };
  }
  motion.drift = { vx: impulse.cos * impulse.speedXY, vy: impulse.sin * impulse.speedXY };
}
