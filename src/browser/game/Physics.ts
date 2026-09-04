import type { WorldPosition } from "../../world/WorldState.js";

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
 * This one is the client's own and is in no server table, but it is not free to choose: it decides
 * the height of every ledge the character can reach. 7.9558 is the figure the original client
 * uses, and it checks out against the gravity above — an apex of v²/2g = 1.64 yards, which is the
 * jump players know.
 */
export const JUMP_VELOCITY = 7.9558;

/** `DEFAULT_COLLISION_HEIGHT`, `Object.h:73`: "most common value in dbc", used when none is known. */
export const DEFAULT_COLLISION_HEIGHT = 2.03128;

/**
 * The steepest ground the character walks up rather than sliding down.
 *
 * 55 degrees is `config.walkableSlopeAngle` in this fork's own navmesh generator
 * (`MapBuilder.cpp:1121`), where the comment calls it the minimum sensible value. Taking the
 * server's figure rather than guessing is the point: a slope the client refuses but the server's
 * own geometry calls walkable is a hill the player can see a path up and cannot climb.
 */
export const MAX_WALKABLE_SLOPE_DEGREES = 55;
const MAX_WALKABLE_GRADIENT = Math.tan(MAX_WALKABLE_SLOPE_DEGREES * Math.PI / 180);

/**
 * How high a lip the character walks over.
 *
 * `config.walkableClimb` is 6 cells of `BASE_UNIT_DIM` (`MapBuilder.cpp:1130`, `MapBuilder.h:81`),
 * which is 1.6 yards — the height the same generator says lets a creature step over a fence.
 */
export const STEP_HEIGHT = 6 * 0.2666666;

/**
 * How far the ground may drop away before the character is falling rather than walking down.
 *
 * The same figure as the step up. Any smaller and every kerb starts a fall; any larger and the
 * character skates down cliffs without the server ever hearing it fell.
 */
export const STEP_DOWN = STEP_HEIGHT;

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
}

export function newCharacterMotion(): CharacterMotion {
  return { mode: "ground", velocityZ: 0, fallTime: 0, jump: undefined, pitch: 0, vertical: 0 };
}

/** What the world answers about a point. Handed in so the simulation can be run over a fake one. */
export interface TerrainProbe {
  /** Ground height under a point, or undefined while that tile has not arrived. */
  ground(x: number, y: number): number | undefined;
  /** The liquid surface over a point, and the map file's class flags for it. */
  liquid(x: number, y: number): { height: number; type: number } | undefined;
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
  /** Where the camera looks, which is the direction a swimmer swims. */
  pitch: number;
  runSpeed: number;
  swimSpeed: number;
  flightSpeed: number;
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
function floorAt(probe: TerrainProbe, input: CharacterInput, x: number, y: number, z: number): number | undefined {
  let floor = probe.hole(x, y) ? undefined : probe.ground(x, y);
  const solid = probe.floor?.(x, y, z + STEP_HEIGHT, z - FLOOR_SEARCH_DEPTH);
  if (solid !== undefined && (floor === undefined || solid > floor)) floor = solid;
  if (floor === undefined) return undefined;
  const surface = input.waterWalking ? probe.liquid(x, y)?.height : undefined;
  if (surface !== undefined && surface > floor) floor = surface;
  return input.hovering ? floor + input.hoverHeight : floor;
}

/** How deep the character is standing in liquid, or undefined where there is none. */
function submersion(probe: TerrainProbe, x: number, y: number, z: number): number | undefined {
  const liquid = probe.liquid(x, y);
  return liquid === undefined ? undefined : liquid.height - z;
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
 * Slides a move that would climb too steeply along the hill instead of up it.
 *
 * The uphill direction is the terrain gradient, measured with two probes either side. Only the
 * uphill part of the move is taken away, so a player pressed against a cliff still walks along it
 * and still walks away from it — which is what makes a steep hillside passable rather than sticky.
 *
 * Walls are not here. The only geometry this can ask about is the height field, so a building is
 * still walked through; that is slice U3, and it is the one thing in this file that is a stub
 * rather than an approximation.
 */
function slideAlongSlope(probe: TerrainProbe, input: CharacterInput, x: number, y: number, z: number,
  dx: number, dy: number): { dx: number; dy: number } {
  /**
   * Whether going this way means climbing something that cannot be climbed.
   *
   * Two questions, both asked at their own fixed distance rather than at the length of this
   * frame's step. A cell ahead: has the ground jumped by more than a step, which is a wall. A yard
   * ahead: is it still rising, and steeply, which is a slope. Anything within one step height is
   * always allowed, because that is what a step is — a stair is not refused for being vertical.
   */
  const climbs = (moveX: number, moveY: number): boolean => {
    const run = Math.hypot(moveX, moveY);
    if (run < 1e-6) return false;
    const from = floorAt(probe, input, x, y, z);
    if (from === undefined) return false;
    const dirX = moveX / run;
    const dirY = moveY / run;

    const near = floorAt(probe, input, x + dirX * CLIMB_PROBE, y + dirY * CLIMB_PROBE, z);
    if (near !== undefined && near - from > STEP_HEIGHT) return true;

    const far = floorAt(probe, input, x + dirX * SLOPE_PROBE, y + dirY * SLOPE_PROBE, z);
    if (far === undefined) return false;
    const rise = far - from;
    return rise > STEP_HEIGHT && rise / SLOPE_PROBE > MAX_WALKABLE_GRADIENT;
  };

  if (!climbs(dx, dy)) return { dx, dy };

  const here = probe.ground(x, y);
  const east = probe.ground(x + GRADIENT_PROBE, y);
  const west = probe.ground(x - GRADIENT_PROBE, y);
  const north = probe.ground(x, y + GRADIENT_PROBE);
  const south = probe.ground(x, y - GRADIENT_PROBE);
  if (here === undefined || east === undefined || west === undefined || north === undefined || south === undefined) {
    return { dx: 0, dy: 0 };
  }
  const gradientX = (east - west) / (2 * GRADIENT_PROBE);
  const gradientY = (north - south) / (2 * GRADIENT_PROBE);
  const length = Math.hypot(gradientX, gradientY);
  if (length < 1e-6) return { dx: 0, dy: 0 };

  const uphillX = gradientX / length;
  const uphillY = gradientY / length;
  const along = dx * uphillX + dy * uphillY;
  // Only the uphill half is removed: going down the same slope is always allowed.
  if (along <= 0) return { dx: 0, dy: 0 };
  const slidX = dx - along * uphillX;
  const slidY = dy - along * uphillY;
  return climbs(slidX, slidY) ? { dx: 0, dy: 0 } : { dx: slidX, dy: slidY };
}

/**
 * Advances the character by one frame, and says what the server has to be told.
 *
 * `position` and `motion` are written in place: they are the live state the renderer draws and the
 * packets are built from, and copying them would mean deciding who owns the copy.
 */
export function stepCharacter(
  position: WorldPosition,
  motion: CharacterMotion,
  input: CharacterInput,
  probe: TerrainProbe,
  elapsed: number,
): PhysicsEvent[] {
  const events: PhysicsEvent[] = [];
  if (elapsed <= 0) return events;

  const collisionHeight = input.collisionHeight > 0 ? input.collisionHeight : DEFAULT_COLLISION_HEIGHT;
  const swimDepth = collisionHeight * SWIM_DEPTH_RATIO;
  motion.pitch = motion.mode === "swim" || isFlying(input) ? input.pitch : 0;

  // A rooted character still falls: root stops it walking, not being subject to gravity.
  const forward = input.rooted ? 0 : input.forward;
  const strafe = input.rooted ? 0 : input.strafe;

  const horizontalSpeed = motion.mode === "swim" ? input.swimSpeed
    : motion.mode === "air" ? motion.jump?.speed ?? input.runSpeed
      : isFlying(input) ? input.flightSpeed : input.runSpeed;

  let dx = 0;
  let dy = 0;
  const length = Math.hypot(forward, strafe);
  if (length > 0) {
    const cosine = Math.cos(position.orientation);
    const sine = Math.sin(position.orientation);
    // Swimming forward follows the pitch, so looking down and swimming forward is a dive. The
    // horizontal part is what is left of the speed once the vertical part has been taken.
    const planar = motion.mode === "swim" ? Math.cos(motion.pitch) : 1;
    const distance = horizontalSpeed * elapsed * planar;
    dx = (cosine * (forward / length) - sine * (strafe / length)) * distance;
    dy = (sine * (forward / length) + cosine * (strafe / length)) * distance;
  }

  if (motion.mode === "ground" && (dx !== 0 || dy !== 0)) {
    const slid = slideAlongSlope(probe, input, position.x, position.y, position.z, dx, dy);
    dx = slid.dx;
    dy = slid.dy;
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

  const floor = floorAt(probe, input, position.x, position.y, position.z);
  const depth = submersion(probe, position.x, position.y, position.z);

  if (motion.mode === "swim") {
    stepSwimming(position, motion, input, probe, elapsed, floor, depth, swimDepth, events);
  } else if (motion.mode === "air") {
    stepAirborne(position, motion, input, probe, elapsed, floor, swimDepth, events);
  } else {
    stepGrounded(position, motion, input, probe, elapsed, floor, depth, swimDepth, horizontalSpeed, events);
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
  motion.velocityZ = 0;
  motion.fallTime = 0;
  motion.jump = undefined;
  events.push("startSwim");
}

/** On solid ground nothing is rising or sinking, and the server has to hear that it stopped. */
function clearVertical(motion: CharacterMotion, events: PhysicsEvent[]): void {
  setVertical(motion, 0, events);
}

function beginFall(motion: CharacterMotion, velocityZ: number, orientation: number, speed: number,
  events: PhysicsEvent[], kind: "jump" | "startFall"): void {
  motion.mode = "air";
  motion.velocityZ = velocityZ;
  motion.fallTime = 0;
  // The direction is the one the character left the ground in; the server echoes it back to
  // everyone watching, and it is what makes a jump land where it was aimed.
  motion.jump = { velocity: velocityZ, sinAngle: Math.sin(orientation), cosAngle: Math.cos(orientation), speed };
  events.push(kind);
}

function stepGrounded(
  position: WorldPosition, motion: CharacterMotion, input: CharacterInput, probe: TerrainProbe,
  elapsed: number, floor: number | undefined, depth: number | undefined, swimDepth: number,
  horizontalSpeed: number, events: PhysicsEvent[],
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
  if (input.ascend) {
    // On a flying mount this is the take-off: the jump starts it, and the next frame finds
    // gravity switched off and the character rising while the key is held.
    beginFall(motion, JUMP_VELOCITY, position.orientation, horizontalSpeed, events, "jump");
    return;
  }
  const drop = position.z - floor;
  if (drop > STEP_DOWN) {
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

function stepAirborne(
  position: WorldPosition, motion: CharacterMotion, input: CharacterInput, probe: TerrainProbe,
  elapsed: number, floor: number | undefined, swimDepth: number, events: PhysicsEvent[],
): void {
  if (isFlying(input)) {
    const rise = (input.ascend ? 1 : 0) - (input.descend ? 1 : 0);
    setVertical(motion, rise, events);
    motion.velocityZ = rise * input.flightSpeed;
    motion.fallTime = 0;
    position.z += motion.velocityZ * elapsed;
    if (floor !== undefined && position.z <= floor) land(position, motion, floor, events);
    return;
  }

  const terminal = input.featherFall ? SAFE_FALL_TERMINAL_VELOCITY : TERMINAL_VELOCITY;
  motion.velocityZ = Math.max(-terminal, motion.velocityZ - GRAVITY * elapsed);
  position.z += motion.velocityZ * elapsed;
  motion.fallTime += elapsed * 1000;

  // Measured again after the drop rather than before it: at terminal velocity a frame is a yard,
  // and a yard is the difference between hitting the water and hitting the bottom of the lake.
  const submerged = submersion(probe, position.x, position.y, position.z);
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
  clearVertical(motion, events);
  // `fallTime` is left standing until the landing packet is built: it is the whole of what the
  // server needs to charge the fall, and clearing it here would send a fall of zero milliseconds.
  events.push("land");
}

function stepSwimming(
  position: WorldPosition, motion: CharacterMotion, input: CharacterInput, probe: TerrainProbe,
  elapsed: number, floor: number | undefined, depth: number | undefined, swimDepth: number,
  events: PhysicsEvent[],
): void {
  const surface = probe.liquid(position.x, position.y)?.height;
  if (surface === undefined || depth === undefined) {
    // Swum out over dry land: fall the rest of the way rather than hanging in the air.
    motion.mode = "air";
    motion.velocityZ = 0;
    motion.fallTime = 0;
    motion.jump = { velocity: 0, sinAngle: Math.sin(position.orientation), cosAngle: Math.cos(position.orientation), speed: input.swimSpeed };
    events.push("stopSwim", "startFall");
    return;
  }

  const rise = (input.ascend ? 1 : 0) - (input.descend ? 1 : 0);
  setVertical(motion, rise, events);
  // Two ways down and one of them is the camera: swimming forward while looking down is a dive,
  // which is how the original client dives and why the pitch is on the wire at all.
  const dive = input.forward !== 0 ? Math.sin(motion.pitch) * input.swimSpeed * Math.sign(input.forward) : 0;
  motion.velocityZ = rise * input.swimSpeed + dive;
  position.z += motion.velocityZ * elapsed;

  // The surface is a ceiling while swimming: a swimmer floats at it rather than rising out of it.
  if (position.z > surface) position.z = surface;
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
