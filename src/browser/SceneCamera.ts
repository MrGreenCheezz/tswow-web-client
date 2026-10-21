// 21.10 ARC-2 S1: the camera the world renderer and the 2D overlay share — its constants, its
// orbit and the pivot height — moved out of `SimpleScene.ts` so that `WorldRenderer3D` no longer
// imports the overlay (and through it `NamePlate.ts` and `ui/IconImage.ts`, which want a DOM) and
// can later run in a worker. `SimpleScene` re-exports all of it, so its importers are unchanged.

import type { WorldPosition } from "../world/WorldState.js";

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Camera {
  position: Vector3;
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

export type HeightSampler = (x: number, y: number) => number | undefined;

/**
 * The vertical field of view of the WebGL camera. The Canvas 2D overlay projects with exactly
 * the same intrinsics, otherwise its unit markers drift away from the terrain underneath them.
 */
export const CAMERA_FOV_DEGREES = 52;
/**
 * 5.33: the world camera's near plane, in yards (`WorldRenderer3D.WORLD_CAMERA_NEAR_PLANE` is this), where
 * the camera's code can read it without importing the renderer. Wow.exe's is 0.1 and its camera is placed
 * with that one (game/CameraClip.ts `CAMERA_CLIP_NEAR`), which says what this one costs.
 */
export const CAMERA_NEAR_PLANE = 0.25;
/**
 * How far the camera orbits by default, in yards.
 *
 * 21.31 rather than the 27.313 the old rig asked for, because the old rig never stood that far
 * away: it aimed at a point seven yards in front of the character and sat 27.313 behind *that*,
 * which left it 21.31 yards from the character's chest and 22.20 from their feet (measured, at
 * the default pitch). Orbiting the chest at 21.31 therefore leaves the body all but exactly the
 * size it has always been — measured on a 1920x1080 window with a 2.127-yard HumanMale, 93.6 px
 * from foot to head before and 99.2 px after — where keeping the 27.313 would have shrunk it to
 * 77.7 px on the day the pivot moved.
 */
export const CAMERA_DEFAULT_DISTANCE = 21.31;
export const CAMERA_DEFAULT_PITCH = -Math.atan2(11, 25);
/** The closest the camera orbits before the wheel drops it into the character's own head. */
export const CAMERA_MIN_DISTANCE = 3.5;
export const CAMERA_MAX_DISTANCE = 55;
/**
 * First person. Not a mode with a flag of its own: the orbit distance simply becomes zero, so
 * every projection, pick and plate goes on working out of the same camera.
 */
export const CAMERA_FIRST_PERSON_DISTANCE = 0;
/**
 * Where the camera hangs on a character nobody has measured yet: the upper chest, wowee's
 * `PIVOT_HEIGHT_DEFAULT` (camera_controller.hpp:387). Only used until the character's own model
 * arrives and says where its shoulder is — on a gnome, whose whole body is 1.524 yards, this
 * constant is nearly at the crown of its head.
 */
export const CAMERA_DEFAULT_PIVOT_HEIGHT = 1.6;
/**
 * Where the eye is in first person before the model arrives.
 *
 * A separate number from the pivot and a decision rather than a side effect: until now the eye
 * stood at a flat `z + 2` for everyone, which is 0.476 yards above a gnome's own head and well
 * below a tauren's shoulders. Third person hangs the camera off the shoulder because that is what
 * keeps the body centred; first person has to be behind the eyes, which is higher.
 */
export const CAMERA_DEFAULT_EYE_HEIGHT = 1.9;
/** What share of a body its shoulder is, over the 20 playable displays: measured median 0.807. */
export const CAMERA_PIVOT_BODY_SHARE = 0.8;
/** And its helm point: measured median 0.924 over the same displays. */
export const CAMERA_EYE_BODY_SHARE = 0.95;
/**
 * The band a pivot height may land in, as wowee clamps it (`hpp:384`, 0..3).
 *
 * The floor is not decoration: a model that arrives with a broken attachment table, or a display
 * scale of 0.01, would otherwise put the orbit centre on the ground and the camera underneath it.
 */
export const CAMERA_MIN_PIVOT_HEIGHT = 0.4;
export const CAMERA_MAX_PIVOT_HEIGHT = 3;

/**
 * The point the camera orbits and keeps on its own optical axis: a place on the character's body.
 *
 * It used to be a point seven yards *in front* of the character at a fixed `z + 2`, and that one
 * decision is the whole of "the camera feels like it belongs to somewhere behind me rather than
 * to me". Measured on the old rig at 1920x1080: the camera stood 18.000 yards from the character
 * horizontally at every yaw and 22.20 in space while the wheel said 27.313; a HumanMale's body sat
 * 190 px below the middle of the screen and at the closest zoom its feet were 156 px below the
 * bottom edge of the window; and because yaw turned the whole rig about the character while pitch
 * turned it about the point in front, a vertical drag slid the body 539 px up the screen while the
 * real camera-to-character distance wandered over seven yards — 20.27 to 27.25, measured at six
 * pitches — for one unchanging number on the wheel.
 *
 * Orbiting the body itself makes `distance` mean the distance to the character at every pitch, to
 * the last digit, and holds the body 10..28 px from the middle of the screen over that same drag.
 */
export function cameraPivot(player: WorldPosition, pivotHeight: number): Vector3 {
  return { x: player.x, y: player.y, z: player.z + pivotHeight };
}

/**
 * The camera, hung on the character at `pivotHeight` and swung `distance` back along its own axis.
 *
 * `anchorDistance` used to be the fifth argument here and is gone: it existed only to keep the
 * look-ahead from chasing the boom around a pillar and to keep the camera behind the character
 * when a wall squeezed it, and neither problem outlived the look-ahead. It stays a parameter of
 * `draw`, where it decides first person — the distance the player *asked* for, never the one a
 * wall granted.
 *
 * The remaining parameter is an options object rather than a fifth number on purpose. Five call
 * sites and two test lines used to pass `anchorDistance` in that slot; a number landing there
 * silently becomes a 21-yard-high orbit centre, and one of the two tests would have gone on
 * passing while measuring nothing. An object refuses a stray number at the type level and falls
 * back to the default at runtime.
 */
export function createCamera(
  player: WorldPosition,
  yawOffset = 0,
  pitch = CAMERA_DEFAULT_PITCH,
  distance = CAMERA_DEFAULT_DISTANCE,
  options: { pivotHeight?: number | undefined } = {},
): Camera {
  const yaw = player.orientation + yawOffset;
  const forward = { x: Math.cos(yaw) * Math.cos(pitch), y: Math.sin(yaw) * Math.cos(pitch), z: Math.sin(pitch) };
  const pivot = cameraPivot(player, options.pivotHeight ?? CAMERA_DEFAULT_PIVOT_HEIGHT);
  const position = {
    x: pivot.x - forward.x * distance,
    y: pivot.y - forward.y * distance,
    z: pivot.z - forward.z * distance,
  };
  const right = normalize({ x: forward.y, y: -forward.x, z: 0 });
  const up = cross(right, forward);
  return { position, forward, right, up };
}

/**
 * How high on a character the camera hangs, out of the three things that can know it.
 *
 * The model's own attachment point is the answer whenever there is one — a shoulder for the orbit
 * centre, a helm point for the first-person eye — because it is the only source that scales with
 * the body: measured over the 20 playable displays the shoulder sits between 0.540 (gnome) and
 * 0.861 of the drawn height. Failing that, a share of the drawn body, which is within 0.040 yards
 * of the true shoulder on the median playable body and 0.396 at worst. Failing *that*, a constant,
 * because until a real model is applied the drawn "height" is the clamped combat reach the
 * stand-in capsule was shaped to, which is not a body height at all.
 *
 * Every link is tested for being a usable number rather than merely for being present, so all
 * three are really in the chain: a model whose attachment table says the shoulder is at zero, or
 * at NaN, used to skip the body share and land straight on the constant — 1.6 yards, which is
 * above a gnome's head — where the drawn body standing right there could have answered.
 *
 * `CreatureModelData.CollisionHeight` is deliberately not in this chain, although it is already on
 * the wire: measured over the same 20 displays it puts 31 of 190 pairs in the wrong order and
 * gives Human, Orc, Troll and both blood elves one identical 2.031 across bodies from 2.033 to
 * 3.192 yards. It is the water-depth threshold the core builds, not a height.
 */
export function cameraBodyHeight(
  attachment: number | undefined,
  bodyHeight: number | undefined,
  share: number,
  fallback: number,
): number {
  const usable = (value: number | undefined): number | undefined =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
  const body = usable(bodyHeight);
  const height = usable(attachment) ?? (body === undefined ? undefined : usable(body * share)) ?? fallback;
  return Math.max(CAMERA_MIN_PIVOT_HEIGHT, Math.min(CAMERA_MAX_PIVOT_HEIGHT, height));
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function normalize(vector: Vector3): Vector3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}
