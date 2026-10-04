import {
  CAMERA_DEFAULT_PITCH, CAMERA_FIRST_PERSON_DISTANCE, CAMERA_MAX_DISTANCE, CAMERA_MIN_DISTANCE,
  boomAnchor, createCamera, type Vector3,
} from "../SimpleScene.js";
import { boomLimits, type CollisionWorld } from "./Collision.js";
import { FLOOR_SEARCH_DEPTH } from "./Physics.js";
import { MOVEMENT_FLAGS } from "../../world/MovementProtocol.js";
import type { WorldPosition } from "../../world/WorldState.js";
import { cameraWaterArm, cameraWaterFloor } from "./CameraWater.js"; // L8 5.14

/**
 * What the camera does between the player's hands and the geometry: the wheel, the easing, and
 * the two limits that stop it from ending up somewhere it cannot see from.
 *
 * `SimpleScene` owns where a camera *is* — the pivot, the boom, the projection — and every
 * function there is a pure one of its arguments. This file owns how those arguments change from
 * frame to frame, which is a different question and the one slice К2 is about: the wheel used to
 * write the drawn distance directly, a wall let the camera back out at a flat fourteen yards a
 * second, and in ground mode nothing at all stopped a pitched-up camera from standing twenty
 * yards under the character's own feet. Flight explicitly relaxes that synthetic floor.
 *
 * Kept out of `Loop.ts` so that it can be run without a frame: `advanceCameraFrame` is the whole
 * of a frame's camera — where the floor is asked about, what the boom is scanned along, and the
 * easing — and it takes the world as two queries rather than reaching for `game`. That division
 * used to run one function earlier, with the loop deciding *where* the floor was asked about, and
 * the half that no test could reach is the half that held a bug: the floor was sampled under a
 * camera built at the full arm, and applied to the arm a wall had actually granted. Measured
 * against a real `CollisionWorld` — a character in a street, a building four yards behind them
 * with an upper storey at z = 8 — the sample landed 19.51 yards away *inside* that building and
 * the drag's -23.75 degrees came out as -85.00: a top-down flip while standing in the open.
 */

/**
 * The camera's own state, everything the loop keeps between frames.
 *
 * Two pairs of "asked for" and "got", and they are apart for the same reason both times: the
 * player's number has to survive whatever the world did to it this frame, or the camera never
 * comes back to where it was put.
 *
 * * `distance` is the wheel's number and `view` is what is drawn. Only the wheel writes the first.
 * * `pitch` is the drag's number and `viewPitch` is what is drawn — the camera stops tilting when
 *   the next degree would put it under the floor, and the drag goes on meaning what it meant.
 * * `zoom` is `distance` eased, and `wallView` / `terrainView` are the two obstruction limits
 *   eased separately. `view` is the smallest of the three.
 *
 * `pivotHeight` and `eyeHeight` come off the player's own model once a frame (slice К1).
 */
export interface CameraRig {
  /** An offset from the character's own facing: the left button turns the camera alone. */
  yaw: number;
  /** What the drag asked for, in radians. Positive looks up, which swings the camera *down*. */
  pitch: number;
  /** What the wheel asked for, in yards, and the witness for first person. */
  distance: number;
  /** How far the camera actually got this frame, and the only one of these numbers to be drawn. */
  view: number;
  /** How far it is tilted this frame, once the floor has had its say. */
  viewPitch: number;
  /** `distance` eased, so a notch of the wheel glides instead of jumping. */
  zoom: number;
  /**
   * How far the walls are letting the boom out, eased, in yards — or `Infinity` when they are
   * letting it out as far as it asked to go.
   *
   * The infinity is not decoration. «Nothing is in the way» has to be a state this can *be* and
   * not a number that happens to equal the boom, because the two behave differently the moment
   * the wheel moves: a limit standing at the old twenty-one yards, easing towards the new
   * twenty-four over its own four tenths of a second, holds the drawn distance back and turns
   * every zoom out into the slowest of the three easings. Measured with the release taken back
   * out: a single 2.5572-yard notch lands inside a hundredth of a yard after 2.500 seconds
   * against 0.383, and moves 0.0930 yards on its biggest frame against 0.5657.
   */
  wallView: number;
  /** The same for the ground, eased on its own and slower. Yards, or `Infinity` for clear. */
  terrainView: number;
  pivotHeight: number;
  eyeHeight: number;
}

/** How fast the mouse turns the camera, in radians a pixel. wowee's 0.2 deg/px (`hpp:342`). */
export const CAMERA_LOOK_SENSITIVITY = (0.2 * Math.PI) / 180;

/**
 * 5.14: the mouse look's angle per pixel for the stock `mouseSpeed` (percent here) and
 * `cameraYawMoveSpeed` (degrees, 180 by default): this client's 0.2° a pixel at the defaults, scaled
 * by both. The vertical axis moves at `cameraPitchMoveSpeed`, which the stock slider keeps at half of
 * the yaw speed (`InterfaceOptionsPanels.xml`, SetCVar("cameraPitchMoveSpeed", value/2)) — the same
 * ratio as the defaults, so the look stays isotropic and the one number serves both axes.
 */
export function cameraLookPerPixel(mouseSpeedPercent: number, lookSpeedDegrees: number): number {
  const speed = Number.isFinite(mouseSpeedPercent) && mouseSpeedPercent > 0 ? mouseSpeedPercent / 100 : 1;
  const look = Number.isFinite(lookSpeedDegrees) && lookSpeedDegrees > 0 ? lookSpeedDegrees / 180 : 1;
  return CAMERA_LOOK_SENSITIVITY * speed * look;
}

/** 5.14: the stock `cameraSmoothStyle` values (InterfaceOptionsCameraPanelStyleDropDown_Initialize). */
export const CAMERA_SMOOTH_NEVER = 0;
export const CAMERA_SMOOTH_HORIZONTAL_WHEN_MOVING = 1;
export const CAMERA_SMOOTH_ALWAYS = 2;
export const CAMERA_SMOOTH_WHEN_MOVING = 4;

/** Moves an angle towards another by at most `step`, the short way round. */
function stepAngle(current: number, target: number, step: number): number {
  let delta = target - current;
  delta = ((delta + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

/**
 * 5.14: the camera bringing itself back behind the character, per the stock `cameraSmoothStyle`
 * (GlobalStrings OPTION_TOOLTIP_CAMERA1–4): 0 never; 1 only the horizontal, only while the character
 * moves; 4 both axes while it moves; 2 both axes always. The yaw offset goes to zero at
 * `cameraYawSmoothSpeed` degrees a second, the tilt to the default at a quarter of that (the stock
 * slider's SetCVar("cameraPitchSmoothSpeed", value/4)). Nothing while a mouse button holds the camera.
 * Writes `yaw` and `pitch` — the player's numbers — because this is the original's own hand on them.
 */
export function advanceCameraFollow(
  rig: CameraRig, style: number, yawSpeedDegrees: number, moving: boolean, mouseHeld: boolean, elapsed: number,
): void {
  if (mouseHeld || !(elapsed > 0) || !(yawSpeedDegrees > 0)) return;
  if (style !== CAMERA_SMOOTH_HORIZONTAL_WHEN_MOVING && style !== CAMERA_SMOOTH_WHEN_MOVING
    && style !== CAMERA_SMOOTH_ALWAYS) return;
  if (style !== CAMERA_SMOOTH_ALWAYS && !moving) return;
  const yawStep = yawSpeedDegrees * Math.PI / 180 * elapsed;
  rig.yaw = stepAngle(rig.yaw, 0, yawStep);
  if (style === CAMERA_SMOOTH_HORIZONTAL_WHEN_MOVING) return;
  const pitchStep = yawStep / 4;
  const gap = CAMERA_DEFAULT_PITCH - rig.pitch;
  rig.pitch = Math.abs(gap) <= pitchStep ? CAMERA_DEFAULT_PITCH : rig.pitch + Math.sign(gap) * pitchStep;
}

/**
 * How far the camera may be tilted either way, in radians. wowee clamps at 88 degrees
 * (`camera_controller.hpp:393-394`); 85 leaves the last three, where the horizon is a line and the
 * yaw becomes a spin about the character's own axis.
 *
 * Both ends were far tighter — -65.9 to +51.6 degrees — and the low end was the one that mattered:
 * with the pivot in front of the character (before К1) a top-down orbit was unusable because the
 * body slid off the bottom of the screen as the view tilted. It does not any more, so the limit
 * can be the reference's.
 */
export const CAMERA_PITCH_LIMIT = (85 * Math.PI) / 180;

/**
 * Camera floors are normally clamped to the character's feet. During a real flight the feet are
 * not a world surface, however: using that synthetic floor limits the default boom to about
 * +3.9 degrees and makes looking into the flight path impossible. The collision world remains the
 * authority for actual roofs/floors; this option only removes the synthetic feet fallback.
 */
export interface CameraOrbitOptions {
  allowBelowFeet?: boolean;
}

/**
 * Whether this frame may use the flight camera rule. Movement toggles are acknowledged before the
 * next movement packet is reflected in the self object's flags, so both sources are intentional:
 * packet/spline flags cover the ordinary and remote state, while `movementState` closes that one
 * frame-sized acknowledgement gap for the controlled mover.
 */
export function cameraAllowsUpwardOrbit(
  movementFlags: number,
  movementState?: { canFly?: boolean; gravityDisabled?: boolean },
): boolean {
  return (movementFlags & (MOVEMENT_FLAGS.flying | MOVEMENT_FLAGS.canFly | MOVEMENT_FLAGS.disableGravity)) !== 0
    || movementState?.canFly === true
    || movementState?.gravityDisabled === true;
}

/**
 * How fast the drawn distance chases the wheel, as a time constant in seconds.
 *
 * wowee writes it as a rate — `currentDistance += (target - current) * (1 - exp(-15*dt))`
 * (`camera_controller.cpp:1659-1660`) — and one over that rate is this. At 60 frames a second a
 * notch of the wheel is 22% of the way home on the first frame and inside a hundredth of a yard
 * by the twentieth, which is a third of a second.
 */
export const CAMERA_ZOOM_TAU = 1 / 15;

/**
 * How fast the camera comes back out once whatever was in the way is not, in seconds.
 *
 * The way in is instant and has to be: a camera that eased into a wall would show the room behind
 * it for the frames it took to arrive. The way out is not, and that asymmetry is the whole of it —
 * walking past a fence post pulls the camera to two yards for one frame, and without this it would
 * snap back to twenty-one on the next, once per post, all the way along the fence.
 *
 * An exponential rather than the flat 14 yards a second this replaces (wowee `cpp:1788`): a linear
 * ramp takes the same time to cross the last tenth of a yard as the first, so the end of every
 * recovery was a visible crawl and a long one was a visible slide.
 */
export const CAMERA_RECOVERY_TAU = 0.4;

/**
 * The ground's own limit is eased separately from the walls', and slower, in seconds.
 *
 * wowee's numbers (`cpp:1767-1769`) and its reason: the height read off a marched hillside changes
 * with every step of the march, so passing it straight through is a shudder. A wall is a plane and
 * answers the same thing twice in a row; a hillside sampled every yard and a half does not, and
 * the same walk that leaves a wall's limit still gives the ground's a new number every frame.
 */
export const CAMERA_TERRAIN_TAU_IN = 0.18;
export const CAMERA_TERRAIN_TAU_OUT = 0.45;

/**
 * The closest a wall may push the camera while the player is still in third person.
 *
 * Zero is not merely close: `distance <= CAMERA_FIRST_PERSON_DISTANCE` is how first person is
 * recognised, and it hides the character's own body and drops it out of the hit list. A corner
 * tight enough to reach zero must leave the player in an awkward close shot, not silently in a
 * different camera mode.
 */
export const CAMERA_MIN_WALL_DISTANCE = 0.75;

/**
 * How far above the character's own feet the camera is kept by the normal ground-mode clamp, in
 * yards. wowee `cpp:1943-1948`.
 *
 * In ground mode this is unconditional, and the only one of the two clamps that needs nothing from
 * the world. Measured on this client before it: at the pitch the drag could already reach, +0.9 radians, the camera stood
 * at z = -19.80 with the character at z = 0 — nineteen and a half yards under their own feet, with
 * nothing but the boom's ground scan between the player and a view from inside the map.
 */
export const CAMERA_FEET_CLEARANCE = 0.15;

/**
 * And how far above the floor under it, where the server's own collision geometry answers.
 * wowee's `MIN_FLOOR_CLEARANCE` (`cpp:1889`).
 *
 * The heightfield is deliberately *not* asked here — it is the boom scan's job, and since К2 it
 * has an easing of its own. Asking it twice would put a hillside behind the character into a
 * clamp that swings the whole camera overhead rather than into the limit that shortens the arm,
 * and standing on any slope would tilt the view to the sky.
 */
export const CAMERA_FLOOR_CLEARANCE = 0.35;

/**
 * One frame of an exponential approach: how far a number gets towards another one in `elapsed`.
 *
 * Frame-rate independent, which a per-frame fraction is not — `current += (target - current) * 0.2`
 * moves twice as fast at 120 frames a second as at 60, and the camera would feel different on
 * every machine. `tau` is the time to close all but 1/e of the gap.
 *
 * The last thousandth is given rather than approached. An exponential never arrives, and two of
 * the three things eased here are compared against the number they are chasing to decide whether
 * they are still holding the camera at all — a limit left a millimetre short of the whole arm
 * goes on being a limit forever.
 */
export const CAMERA_EASE_ARRIVAL = 1e-3;

export function approachCamera(current: number, target: number, tau: number, elapsed: number): number {
  if (!(elapsed > 0)) return current;
  if (!(tau > 0)) return target;
  const next = current + (target - current) * (1 - Math.exp(-elapsed / tau));
  return Math.abs(target - next) < CAMERA_EASE_ARRIVAL ? target : next;
}

/**
 * The most the camera may be tilted before it would stand below `floorZ`, in radians.
 *
 * The camera is the pivot swung back along its own axis, so `z = pivotZ - sin(pitch) * distance`:
 * looking up swings it down, and every yard of boom multiplies the fall. Solving that for the
 * floor gives a limit on the sine, and the answer is a *pitch* rather than a lift of the camera's
 * z on purpose. Lifting z alone is what the reference does (`cpp:1943-1948`), but this client
 * recovers the boom's hinge by walking the boom forwards from the camera (`boomAnchor`, slice К1)
 * and projects the plates and the bubbles through the same camera the world was drawn with — a
 * camera lifted off its own axis is no longer hinged on the character, and the scan would start
 * from a point in mid-air. Turning the tilt down keeps the pivot exactly on the optical axis, and
 * the body exactly in the middle of the screen, which is the whole of К1.
 *
 * Only ever downwards: a floor cannot make the camera tilt *up* into a view the player did not ask
 * for. And never past the clamp the drag itself obeys, so `viewPitch` stays inside the same band
 * as `pitch` however high the floor is.
 *
 * A floor higher than the whole band can lift the camera to is left alone rather than answered
 * with the top of the band, and that is the difference between a clamp and a flip. The equation
 * has no solution there — even straight up, the camera stands at `pivotZ + distance` and the floor
 * is above that — so the tilt is not the thing that can fix it, and turning the view over to 85
 * degrees would leave the camera under the floor *and* looking down at the character's scalp. It
 * used to saturate: measured with a floor 8 yards up against an arm a wall had squeezed to 3.920,
 * the drag's -23.75 degrees came out as -85.00, and sweeping that same arm's floor gave -26.51 at
 * 3 yards, -44.55 at 4 and the full -85.00 from 6 up. Shortening the arm is the mechanism for a
 * camera that is under something — the boom scan owns it, and it runs on the same frame.
 */
export function cameraFloorPitch(pitch: number, pivotZ: number, distance: number, floorZ: number): number {
  // Keep every caller inside the same finite band. This is also the final guard for a malformed
  // movement packet or a missing collision answer: neither can turn the camera into a NaN or over
  // the pole, where yaw would become a roll.
  const safePitch = Number.isFinite(pitch)
    ? Math.max(-CAMERA_PITCH_LIMIT, Math.min(CAMERA_PITCH_LIMIT, pitch))
    : 0;
  if (!(distance > 0) || !Number.isFinite(distance) || !Number.isFinite(pivotZ) || !Number.isFinite(floorZ)) return safePitch;
  // The highest the camera can be lifted at this arm, which is the top of the drag's own band.
  if (floorZ > pivotZ + Math.sin(CAMERA_PITCH_LIMIT) * distance) return safePitch;
  const highest = (pivotZ - floorZ) / distance;
  if (highest >= 1) return safePitch;
  const limit = Math.asin(Math.max(-1, Math.min(1, highest)));
  return Math.min(safePitch, Number.isFinite(limit) ? limit : safePitch);
}

/**
 * Where a notch of the wheel leaves the orbit.
 *
 * Multiplicative, so a notch moves the same proportion at every distance, with one step that is
 * not: below the closest orbit there is nowhere left to go but first person, and 12% of 3.5 yards
 * would never get there.
 *
 * `maxDistance` is the player's own ceiling — the «Максимальная дистанция камеры» setting, which
 * is the original client's `cameraDistanceMaxFactor` in yards rather than in multiples. It is
 * clamped against `CAMERA_MAX_DISTANCE` here as well as in the setting's own range, because the
 * setting is read out of a blob the account carries and a blob is not a promise.
 *
 * A pure function of its three arguments so that the wheel can be tested without a canvas to roll
 * it over: `Controls` owns the event and this owns the arithmetic.
 */
export function zoomedDistance(distance: number, step: number, maxDistance: number): number {
  const ceiling = Math.min(CAMERA_MAX_DISTANCE, maxDistance);
  if (distance <= CAMERA_FIRST_PERSON_DISTANCE) {
    return step > 0 ? Math.min(ceiling, CAMERA_MIN_DISTANCE) : distance;
  }
  const next = distance * (1 + step * 0.0012);
  if (next < CAMERA_MIN_DISTANCE) return step < 0 ? CAMERA_FIRST_PERSON_DISTANCE : CAMERA_MIN_DISTANCE;
  return Math.min(ceiling, next);
}

/**
 * How long the arm is this frame, for the purpose of asking the world what is in it.
 *
 * The longer of what the wheel asked for and where the eased camera still is, and it has to be
 * both: zooming *in*, `zoom` is still outside `distance` for a third of a second, and an arm
 * scanned only as far as `distance` would have nothing to say about a wall standing between the
 * two — the camera would be drawn through it for those frames. Zooming out it is `distance`, which
 * is where the camera is going.
 */
export function boomLength(rig: CameraRig): number {
  return Math.max(rig.distance, rig.zoom);
}

/** What the world had to say about the boom this frame, in yards, and where its floor is. */
export interface CameraLimits {
  /**
   * How far out the walls, the buildings and the doodads let the boom reach. The whole of
   * `boomLength(rig)` when the scan found nothing in it, which is how «clear» is spelled.
   */
  wall: number;
  /** How far out the ground does. Measured separately because it is eased separately. */
  terrain: number;
  /** Where the arm is hinged, in world z. */
  pivotZ: number;
  /**
   * The lowest the camera may stand. In ground mode the character's own feet answer it wherever
   * they are standing; flight may use a synthetic `-Infinity` fallback while a real floor under
   * the camera can still raise the answer.
   */
  floorZ: number;
}

/**
 * One frame of the camera's own motion: the wheel eased, the two limits eased, and the floor.
 *
 * Writes `zoom`, `wallView`, `terrainView`, `view` and `viewPitch` and reads everything else.
 * Nothing is written back into `distance` or `pitch`. Those two numbers belong to the player's
 * hands, and a clamp that overwrote either would leave someone who had squeezed through a doorway
 * zoomed in for good, with no way to notice that the world had stopped obeying the wheel.
 *
 * First person is the one state with no easing anywhere in it. The mode is decided by `distance`
 * alone — a wall must never put the player behind their own eyes — so the frames it would take to
 * ease across the boundary are frames with the body hidden and the camera still yards behind it,
 * or with the body drawn on the lens. Both ends of the crossing snap, and that is what the
 * `zoom <= CAMERA_FIRST_PERSON_DISTANCE` half of the test is for: the way back out snaps too.
 */
export function advanceCameraRig(rig: CameraRig, limits: CameraLimits, elapsed: number): void {
  if (rig.distance <= CAMERA_FIRST_PERSON_DISTANCE) {
    // Nothing was scanned this frame either: the boom has no length to obstruct.
    rig.zoom = rig.distance;
    rig.wallView = Number.POSITIVE_INFINITY;
    rig.terrainView = Number.POSITIVE_INFINITY;
    rig.view = rig.distance;
    // Keep first person behind the same finite pitch guard as the orbit path. Controls normally
    // supplies a clamped number, but movement packets and restored settings are not trusted input.
    rig.viewPitch = cameraFloorPitch(rig.pitch, limits.pivotZ, 0, limits.floorZ);
    return;
  }
  // The arm the world was asked about, read before the zoom moves and derived rather than passed:
  // `boomLength` is the one place that says how long the scanned segment is, and the caller called
  // it with this same rig a moment ago. Saying it twice would be a place for the two to disagree,
  // and what they are used for — deciding whether a limit is still a limit — is exactly where a
  // disagreement is invisible until a wall is drawn through.
  const arm = boomLength(rig);
  rig.zoom = rig.zoom <= CAMERA_FIRST_PERSON_DISTANCE
    ? rig.distance
    : approachCamera(rig.zoom, rig.distance, CAMERA_ZOOM_TAU, elapsed);
  // Walls come in at once and go out on an exponential. Nearer than the limit standing is what a
  // wall the camera has just backed into looks like, and there is nothing to ease about it: the
  // frames it took to arrive would be frames spent looking at the inside of the stone.
  rig.wallView = limits.wall <= rig.wallView
    ? limits.wall
    : approachCamera(rig.wallView, limits.wall, CAMERA_RECOVERY_TAU, elapsed);
  // The ground is eased both ways, and slower coming in than a wall — the difference between a
  // slope and a series of nudges. Easing *from* «nothing in the way» has to start somewhere, and
  // the whole arm is where: that is where the camera is standing when the hillside first appears.
  const ground = Number.isFinite(rig.terrainView) ? rig.terrainView : arm;
  rig.terrainView = approachCamera(ground, limits.terrain,
    limits.terrain <= ground ? CAMERA_TERRAIN_TAU_IN : CAMERA_TERRAIN_TAU_OUT, elapsed);
  // A limit that has recovered to the whole arm is not a limit. Said here rather than left as a
  // number equal to the arm, because the two part company the instant the wheel moves — see
  // `wallView`.
  //
  // Against the arm that was *scanned* and never against the wheel's number, which is not the same
  // thing while a zoom in is easing: `distance` drops on the frame the wheel turns and `zoom` takes
  // a third of a second to follow it, so for those frames a wall standing between the two is
  // measured, found to be further out than `distance`, and thrown away as «nothing in the way» —
  // and `view` falls back to `zoom`, which is still outside the wall. Measured against the wheel's
  // number: a wall holding the camera at 12 yards and one roll of the wheel in to 9.90 drew 18.7861
  // on the very next frame, a 6.7861-yard step *outward* and six frames — a tenth of a second —
  // spent behind the stone; a pillar granting 5 drew 17.3704 and nine frames. Against the arm,
  // both hold at what the scan granted until the eased camera comes inside it.
  if (rig.wallView >= arm) rig.wallView = Number.POSITIVE_INFINITY;
  if (rig.terrainView >= arm) rig.terrainView = Number.POSITIVE_INFINITY;
  rig.view = drawnArm(rig.zoom, rig.wallView, rig.terrainView);
  // Against the arm the camera actually got rather than the one it asked for: a boom squeezed to
  // three yards by a doorway dips three yards' worth for a given tilt, and clamping it as though
  // it were still twenty-one would hold the view level for no reason the player can see.
  rig.viewPitch = cameraFloorPitch(rig.pitch, limits.pivotZ, rig.view, limits.floorZ);
}

/**
 * How long the drawn arm is, out of the wheel's eased number and whatever the two limits grant.
 *
 * One function rather than the same `min` written twice, because it is written in two places for
 * two different purposes and they have to agree: the rig draws the camera here, and the frame asks
 * the world where the floor is *under* that camera before the rig has run. Two copies of a `min`
 * is one place for the floor to be measured under a camera nobody draws, which is the bug this
 * whole file was fixed for once already.
 */
export function drawnArm(zoom: number, wall: number, terrain: number): number {
  return Math.max(CAMERA_MIN_WALL_DISTANCE, Math.min(zoom, wall, terrain));
}

/** What the world can be asked about the camera, adapted from `game` by the render loop. */
export interface CameraWorld {
  /** The collision meshes streamed in around the player: the walls in the boom, and the floors. */
  collision?: CollisionWorld | undefined;
  /** The heightfield under a point, or `undefined` where nothing has been loaded there. */
  heightAt?: ((x: number, y: number) => number | undefined) | undefined;
  /** True while gravity is disabled or flight is granted; permits the boom below synthetic feet. */
  allowUpwardOrbit?: boolean | undefined;
  /** L8 5.14: the water surface the boom stops at (cameraWaterCollision, CameraWater.ts); none without it. */
  waterZ?: number | undefined;
}

/**
 * The lowest the camera may stand where it is standing, in world z.
 *
 * Two rules, both of them wowee's (`camera_controller.cpp:1889`, `:1943-1948`). In ground mode the
 * character's own feet plus a hand's width is unconditional and needs nothing from the world; the
 * floor under the camera plus a third of a yard is asked of the server's own collision meshes, the
 * same query the physics stands the character on (`Physics.floorAt`). Flight skips only that
 * synthetic feet fallback.
 *
 * The heightfield is deliberately not one of them. The ground is the boom scan's business and
 * since К2 it has an easing of its own — asking it here as well would turn every hillside behind a
 * character into a clamp that swings the whole camera overhead rather than into a limit that
 * shortens the arm, so standing on any slope would tilt the view at the sky.
 *
 * The search starts at the higher of the camera and the hinge, because a camera that has dived
 * under a tavern's first floor must find that floor and be brought back above it; a search that
 * began at the camera itself would find the cellar and agree with where it already was.
 */
export function cameraFloorHeight(
  player: WorldPosition, camera: Vector3, pivotZ: number, collision?: CollisionWorld | undefined,
  options: CameraOrbitOptions = {},
): number {
  const feet = player.z + CAMERA_FEET_CLEARANCE;
  const solid = collision?.floorUnder(
    camera.x, camera.y, Math.max(camera.z, pivotZ) + CAMERA_FLOOR_CLEARANCE, camera.z - FLOOR_SEARCH_DEPTH,
  );
  if (solid === undefined) return options.allowBelowFeet ? Number.NEGATIVE_INFINITY : feet;
  return options.allowBelowFeet ? solid + CAMERA_FLOOR_CLEARANCE : Math.max(feet, solid + CAMERA_FLOOR_CLEARANCE);
}

/**
 * A whole frame of camera: how far the boom reaches, where the floor under it is, and the easing.
 *
 * The order is the whole of it, and every step of it is where it is for a reason that was measured.
 *
 * **The arm is scanned to `boomLength`**, the longer of what the wheel asked for and where the
 * eased camera still is, so that the scan covers wherever the camera may be drawn this frame.
 *
 * **The scan is run at the tilt the floor mode grants** — the character's own-feet tilt in ground
 * mode and the requested tilt during flight. The ground-mode value is the half of the floor that
 * costs nothing to ask about — it is `player.z + 0.15` wherever they are standing. It has to be
 * applied before the scan and not after, because the two disagree otherwise: a camera the floor is
 * about to hold at eye level must not have its arm cut short by the hillside it would have dived
 * into had the floor not stopped it. On open ground it is the whole of the floor, since a scan over
 * grass finds no solid floor to raise it.
 *
 * **The floor under the camera is asked about at the arm the scan has just granted** — the point
 * the frame is about to draw the camera at, give or take the easing. Both other places one could
 * ask are wrong, and both were measured against a real `CollisionWorld` with a character in a
 * street, a building four yards behind them and that building's upper storey overhead:
 *
 * * Under a camera built at the *full* arm: the wall cuts the boom to 3.920 yards, but the sample
 *   is taken 19.51 yards away and inside the building. With the storey at z = 8 the clamp was
 *   handed 8.35 to apply to a 3.920-yard arm — which no tilt can answer — and the drag's -23.75
 *   degrees came out as -85.00, a top-down flip while standing in the open. With the storey at 4 it
 *   came out as -44.55, which is the same mistake without the saturation to make it obvious.
 * * Under the camera the *last* frame drew: right in the steady state and wrong for exactly one
 *   frame whenever the arm jumps, which is every time a wall comes into the boom, because a wall
 *   takes the camera in at once. Measured walking past a building's corner at 7 yd/s: one frame at
 *   -44.55 degrees between two at -23.75 — a 20.80-degree flash, once per corner.
 *
 * One pass rather than a loop: the camera whose floor is sampled is built at the feet's tilt rather
 * than at the tilt that floor will grant, so a camera the solid floor lifts is sampled slightly
 * below where it ends up. A frame of easing, which is the resolution of the whole mechanism anyway.
 *
 * The scan is hinged at the character's own shoulder rather than at a spot seven yards in front of
 * them (slice К1): `boomAnchor` recovers the hinge from the camera, and it is the same
 * `player + (0, 0, pivotHeight)` the camera was built around. It cannot start at the feet — from
 * there the very floor the character is standing on is an obstruction, and the camera would be
 * pinned to the back of their head. Moving the hinge onto the body swung the whole segment behind
 * the character and lowered it: measured, its near end went from (7.00, 2.00) to (0.00, 1.60) and
 * its far end from (-18.00, 13.00) to (-19.51, 10.18), so the uphill slope at which the far end
 * first reads "sunk" falls from 34.9 to 26.5 degrees. Hillsides between the two are ground the
 * player can stand on where the camera now squeezes and did not before — which is correct, because
 * the camera really is inside the hill.
 *
 * Nothing is written back into `distance` or `pitch`. Those numbers belong to the wheel and to the
 * drag, and a clamp that overwrote either would leave a player who had squeezed through a doorway
 * zoomed in for good, with no way to notice that the world had stopped obeying their hands.
 */
export function advanceCameraFrame(
  rig: CameraRig, player: WorldPosition, pivotHeight: number, world: CameraWorld, elapsed: number,
): void {
  const options = { pivotHeight };
  const pivotZ = player.z + pivotHeight;
  const feetZ = player.z + CAMERA_FEET_CLEARANCE;
  const orbitOptions: CameraOrbitOptions = { allowBelowFeet: world.allowUpwardOrbit === true };
  // L8 5.14: over water the surface is one more floor (CameraWater.ts); -Infinity without it.
  const waterFloor = cameraWaterFloor(pivotZ, world.waterZ);
  // L8 5.14: `Math.max(…, waterFloor)` around the old value.
  const floorForPitch = Math.max(orbitOptions.allowBelowFeet ? Number.NEGATIVE_INFINITY : feetZ, waterFloor);
  if (rig.distance <= CAMERA_FIRST_PERSON_DISTANCE) {
    // Behind the character's own eyes there is no boom to obstruct and no floor to be held off:
    // the rig reads none of these three and snaps everything to the wheel's number.
    const eye = rig.distance;
    advanceCameraRig(rig, { wall: eye, terrain: eye, pivotZ, floorZ: feetZ }, elapsed);
    return;
  }
  const wanted = boomLength(rig);
  const pitch = cameraFloorPitch(rig.pitch, pivotZ, wanted, floorForPitch);
  const camera = createCamera(player, rig.yaw, pitch, wanted, options);
  // The sample count is not passed either: `boomLimits` derives it from the length of the segment
  // it was handed, which is this boom to the last digit — the hinge is the camera walked `wanted`
  // forwards along its own axis. The number that matters is the spacing, and it lives with the
  // scan (`boomTerrainSamples`).
  const reach = boomLimits(boomAnchor(camera, wanted), camera.position, {
    world: world.collision, heightAt: world.heightAt,
  });
  // L8 5.14: was `wanted * reach.wall` — under water the surface stops the boom as a wall does (CameraWater.ts).
  const wall = Math.min(wanted * reach.wall, cameraWaterArm(pivotZ, pitch, world.waterZ));
  const terrain = wanted * reach.terrain;
  // Where the camera is about to stand: the same three numbers `view` is the smallest of, taken
  // before the two limits are eased. `zoom` is the one the rig has not moved yet this frame, and
  // it is `distance` on the frame after first person, where the rig snaps it rather than easing it.
  const eased = rig.zoom <= CAMERA_FIRST_PERSON_DISTANCE ? rig.distance : rig.zoom;
  const standing = createCamera(player, rig.yaw, pitch, drawnArm(eased, wall, terrain), options);
  advanceCameraRig(rig, {
    wall, terrain, pivotZ,
    // L8 5.14: `Math.max(…, waterFloor)` around the old value.
    floorZ: Math.max(cameraFloorHeight(player, standing.position, pivotZ, world.collision, orbitOptions), waterFloor),
  }, elapsed);
}
