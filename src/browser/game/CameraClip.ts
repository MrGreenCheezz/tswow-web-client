/**
 * 5.33: what Wow.exe 3.3.5a 12340 does with its camera where something is in the way — the owner's report
 * «inside buildings the camera jerks and goes into the ceiling». Ghidra read-only:
 * `.runtime/re-2026-10-11/glue-1110/s533-1.txt`, `s533-2.txt` (and `mov-1.txt`, `mov-2.txt`).
 *
 * One frame of its camera (0x00606f90) runs, in this order:
 *
 * 1. 0x00603d30 eases the camera's numbers. Each eased number has a target, a start, a start time and a
 *    duration, and moves on 0x008ca080's half cosine, `from + (to − from) · (1 − cos πt) / 2`, until the
 *    ratio reaches 1 (then the target) — among them the distance (+0x118 toward +0x1e8) and the height of the
 *    hinge over the subject's feet (+0x128 toward +0x218, the model's `$CMA` point, 0x00604640 → 0x00600a10).
 * 2. 0x00605d60 asks the world (mask 0x100171, the liquid bit with `cameraWaterCollision`), with the longer of
 *    each number's target and its eased value:
 *    * the hinge: a plumb line from 5/6 of a yard over the feet (0x00a1e324) up to that height. A hit is the
 *      ceiling less 1/9 (0x00a1e354, and never under 1/9 of rise), no lower than 3/4 of the subject's height
 *      (+0x854 × 0x009e9ee4) — then no lower than the 5/6 and no higher than the eased height.
 *    * the arm, from that hinge: one segment out to the camera (`t` × the arm), then the near plane's quad
 *      swept along it from the camera to the hinge (0x006059e0: the projection's near corners, scaled ×1 and
 *      ×1.75 about their centre by 0x005ff670, each swept by 0x006057b0; the ×1.75 quad holds the ×1, so the
 *      ×1 pass never moves the answer). The arm is shortened to where the quad has left the last triangle it
 *      touched — the camera's near plane clear of everything between it and the hinge — and, if anything
 *      shortened it, by 1/9 more (never under 0). Then no longer than the eased distance.
 * 3. Whatever came out more than 1/9 under its eased number restarts that number's ease from just past it:
 *    the eased value is set to the answer plus 0.1111121 (0x00a1ea80 — a hair over the 1/9, so a camera still
 *    held re-arms every frame), and eased back to its target over two seconds (0x00a4040c) on the cosine.
 *
 * So a wall or a ceiling takes the camera at once, and lets it go slowly: the arm (and the hinge) creep back
 * out over two seconds, slow, fast, slow, from 0.11 past where they were held. The near-plane sweep is what
 * keeps the camera out of a ceiling it is looking up at: the segment only keeps the eye out, and the near
 * plane's upper edge stands higher than the eye.
 *
 * Kept from this client rather than ported: the heightfield's limit, which here is sampled along the boom
 * (`Collision.boomLimits`) and eased both ways for that reason, where Wow.exe intersects the terrain's
 * triangles in the same segment; the hinge's own target, which is the model's shoulder here
 * (`SimpleScene.cameraBodyHeight`) and changes at once; the water rules (`CameraWater.ts`).
 */

import { CAMERA_FOV_DEGREES } from "../SceneCamera.js"; // 21.10 ARC-2 S1: not the DOM overlay
import type { CollisionMesh, CollisionWorld, Vector3 } from "./Collision.js";

/** 0x00a1e354: what a hit gives back (1/9 of a yard, as a float), and how far under its eased number an answer has to fall to restart its ease. */
export const CAMERA_CLIP_MARGIN = Math.fround(1 / 9);
/** 0x00a1ea80: where a restarted ease starts, past the answer — a hair over {@link CAMERA_CLIP_MARGIN}. */
export const CAMERA_CLIP_REARM = 0.1111120656132698;
/** 0x00a4040c: how long a restarted ease takes, in seconds (the ratio is milliseconds × 0.001 over this). */
export const CAMERA_CLIP_RECOVERY_SECONDS = 2;
/** 0x00a1e324: where the hinge's plumb line starts over the feet, and the lowest the hinge goes. */
export const CAMERA_PIVOT_FLOOR = 0.8333333134651184;
/** 0x009e9ee4: the share of the subject's height the hinge is never pushed under. */
export const CAMERA_PIVOT_BODY_SHARE_FLOOR = 0.75;
/**
 * Wow.exe's near distance (camera+0x38: 0x00607c20 is handed 0x00adeed4, 0.1), which 0x006059e0 subtracts from
 * the arm and builds its quad at; the subject's fade is measured past it too. Not this renderer's near plane
 * (`SimpleScene.CAMERA_NEAR_PLANE`, 0.25, chosen for depth precision): the camera is placed with Wow.exe's own
 * quad, so it stands where Wow.exe's does — 1/9 under a ceiling the hinge was lowered to, which a quad the
 * size of this renderer's plane (×1.75) could never clear, and every lowered hinge would fold the arm into the
 * head. The ×1.75 quad at 0.1 is the frustum's section at 0.175, so a near plane at 0.25 can still reach past
 * it by up to 0.037 of a yard upwards and 0.065 sideways, in the corners of a level view under a lowered hinge
 * or along a wall at a grazing angle.
 */
export const CAMERA_CLIP_NEAR = 0.10000000149011612;
/** 0x00a1ea74: the near-plane quad swept on the second pass, scaled about its centre. */
export const CAMERA_NEAR_SWEEP_SCALE = 1.75;
/** 0x00a1e34c: an arm within this of the near plane is no arm (0x006059e0 answers 0). */
export const CAMERA_NEAR_SWEEP_MINIMUM = 0.0010000000474974513;
/** 0x009f1224: how much of a number counts as some (an arm or a height worth asking about). */
const SOME = 9.5367431640625e-7;
/** 0x009ea27c: how far apart two numbers have to be to differ (0x00482900). */
const DIFFERENT = 2.384185791015625e-7;

/** 0x00a1e308: an eye closer than this past the near plane fades the subject's model (0x00606f90's tail). */
export const CAMERA_SUBJECT_FADE_START = 1.8315001726150513;
/** 0x00a1e344: and this close it is not drawn at all. */
export const CAMERA_SUBJECT_FADE_END = 0.0027777778450399637;
/** 0x00a1ea7c: −68° in Wow.exe's pitch (positive looking down) — looking up steeper than this, the fade reaches further. */
const FADE_STEEP_PITCH = -1.186823844909668;
/** 0x00a1ea78: one over the 22° left between that and straight up, negated. */
const FADE_STEEP_SCALE = -2.6043529510498047;
/** 0x009f1ff4: −π/2 as a float. */
const MINUS_HALF_PI = -1.5707963705062866;

/**
 * How opaque the camera's subject is drawn, 0…1 (Wow.exe 0x00606f90's tail → 0x004f8660, an alpha byte): whole
 * until the eye comes within {@link CAMERA_SUBJECT_FADE_START} past the near plane (`view` − `near`), then 0x008ca080's
 * half cosine down to nothing at {@link CAMERA_SUBJECT_FADE_END}. Closer than the hinge's height and looking up
 * past 68° the fade starts further out, by the square of the share of the last 22° still left to straight up.
 * `pitch` is this client's (positive looks up). Not ported: a vehicle's own fade distances from its model's
 * bounds (display flag 0x80000), the fade timed across a change of view (flags 0x40000000/0x8000).
 */
export function cameraSubjectOpacity(view: number, pitch: number, pivotHeight: number, near = CAMERA_CLIP_NEAR): number {
  let start = CAMERA_SUBJECT_FADE_START;
  const wowPitch = -pitch;
  if (view < pivotHeight && wowPitch < FADE_STEEP_PITCH) {
    const share = (MINUS_HALF_PI - wowPitch) * FADE_STEEP_SCALE;
    if (Math.abs(share) >= DIFFERENT) start /= share * share;
  }
  const past = view - near;
  if (!(past < start)) return 1;
  if (past <= CAMERA_SUBJECT_FADE_END) return 0;
  const ratio = (past - CAMERA_SUBJECT_FADE_END) / (start - CAMERA_SUBJECT_FADE_END);
  return Math.round(255 * (1 - Math.cos(ratio * Math.PI)) * 0.5) / 255;
}

/** 0x008ca080 over 0x00603d30's ratio: `from` eased toward `to` `seconds` into a two-second half cosine. */
export function cameraClipEase(from: number, to: number, seconds: number): number {
  const ratio = seconds / CAMERA_CLIP_RECOVERY_SECONDS;
  if (!(ratio < 1)) return to;
  return from + (to - from) * (1 - Math.cos(Math.max(0, ratio) * Math.PI)) * 0.5;
}

/**
 * The hinge's height over the feet at (`x`, `y`, `z`) once a ceiling has had its say (0x00605d60, first half):
 * `scan` is the longer of the target and the eased height, `current` the eased one, `body` the subject's height
 * (undefined: unknown). Never above `current`.
 */
export function cameraPivotUnderCeiling(
  world: CollisionWorld | undefined, x: number, y: number, z: number,
  scan: number, current: number, body: number | undefined, near = CAMERA_CLIP_NEAR,
): number {
  let height = scan;
  if (world !== undefined && world.size > 0 && scan - near > SOME) {
    const rise = Math.max(CAMERA_CLIP_MARGIN, scan - CAMERA_PIVOT_FLOOR);
    PIVOT_FROM.x = x;
    PIVOT_FROM.y = y;
    PIVOT_FROM.z = z + CAMERA_PIVOT_FLOOR;
    PIVOT_TO.x = x;
    PIVOT_TO.y = y;
    PIVOT_TO.z = PIVOT_FROM.z + rise;
    const hit = world.firstHit(PIVOT_FROM, PIVOT_TO);
    let reach = hit === undefined ? rise : hit.t * rise;
    if (Math.abs(rise - reach) >= DIFFERENT) reach = Math.max(CAMERA_CLIP_MARGIN, reach - CAMERA_CLIP_MARGIN);
    height = reach + CAMERA_PIVOT_FLOOR;
    if (body !== undefined && body > 0 && Number.isFinite(body)) {
      height = Math.max(height, body * CAMERA_PIVOT_BODY_SHARE_FLOOR);
    }
  }
  if (height < CAMERA_PIVOT_FLOOR) height = CAMERA_PIVOT_FLOOR;
  return height > current ? current : height;
}

const PIVOT_FROM: Vector3 = { x: 0, y: 0, z: 0 };
const PIVOT_TO: Vector3 = { x: 0, y: 0, z: 0 };

/** The camera's axes `cameraArmClip` reads: `SimpleScene.createCamera`'s `forward`, `right`, `up`. */
export interface CameraAxes {
  readonly forward: Vector3;
  readonly right: Vector3;
  readonly up: Vector3;
}

/** The near-plane quad's half extents for a vertical fov (degrees) and aspect, before the ×1.75. */
export function nearPlaneHalfHeight(near = CAMERA_CLIP_NEAR, fovDegrees = CAMERA_FOV_DEGREES): number {
  return near * Math.tan((fovDegrees * Math.PI) / 360);
}

/**
 * How long the arm from `pivot` along `axes` may be (0x00605d60, second half, without the eased cap): the
 * segment out to `length`, the near-plane sweep (×1.75) back in, and 1/9 off whatever either shortened. `length`
 * itself when nothing is in the way. `aspect` is the drawn camera's width over height.
 */
export function cameraArmClip(
  world: CollisionWorld | undefined, pivot: Vector3, axes: CameraAxes, length: number, aspect: number,
  near = CAMERA_CLIP_NEAR,
): number {
  if (world === undefined || world.size === 0 || !(length - near > SOME)) return length;
  const forward = axes.forward;
  ARM_END.x = pivot.x - forward.x * length;
  ARM_END.y = pivot.y - forward.y * length;
  ARM_END.z = pivot.z - forward.z * length;
  const hit = world.firstHit(pivot, ARM_END);
  let arm = hit === undefined ? length : hit.t * length;
  if (arm > SOME) {
    const halfHeight = nearPlaneHalfHeight(near) * CAMERA_NEAR_SWEEP_SCALE;
    const halfWidth = halfHeight * (Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9);
    arm = nearPlaneSweep(world, pivot, axes, arm, near, halfWidth, halfHeight);
  }
  if (Math.abs(length - arm) >= DIFFERENT) arm = Math.max(0, arm - CAMERA_CLIP_MARGIN);
  return arm;
}

const ARM_END: Vector3 = { x: 0, y: 0, z: 0 };

/**
 * 0x006059e0: the arm after the near plane's quad (half extents `halfWidth` × `halfHeight`, centred on the axis,
 * square to it) is swept from the camera `length` out along `axes` to `pivot`. The sweep covers the quad's own
 * travel, `length − near`; the camera is moved in to where the quad has left the last triangle it touched —
 * which, seen from the hinge, is the first triangle the quad meets going out — and stands `near` behind it.
 * Under {@link CAMERA_NEAR_SWEEP_MINIMUM} of travel there is no arm (0).
 *
 * Exact for the quad: the swept quad is a box along the arm, every triangle is clipped to the box's four sides
 * in the arm's own frame, and the nearest point of what is left is the contact. Triangles are taken from the
 * grid cells the box's four edges and its axis cross (`CollisionMesh.forEachAlong`) — a cell the box enters
 * without any of the five would need the box wider than a cell (4 yards). Allocates nothing.
 */
export function nearPlaneSweep(
  world: CollisionWorld, pivot: Vector3, axes: CameraAxes, length: number, near: number,
  halfWidth: number, halfHeight: number,
): number {
  const travel = length - near;
  if (travel < CAMERA_NEAR_SWEEP_MINIMUM) return 0;
  const forward = axes.forward;
  const right = axes.right;
  const up = axes.up;
  // The arm runs from the hinge back along −forward.
  S.px = pivot.x;
  S.py = pivot.y;
  S.pz = pivot.z;
  S.bx = -forward.x;
  S.by = -forward.y;
  S.bz = -forward.z;
  S.rx = right.x;
  S.ry = right.y;
  S.rz = right.z;
  S.ux = up.x;
  S.uy = up.y;
  S.uz = up.z;
  S.halfWidth = halfWidth;
  S.halfHeight = halfHeight;
  S.travel = travel;
  S.best = Number.POSITIVE_INFINITY;
  // The box's bounds in the world, to skip whole meshes.
  const spanX = Math.abs(right.x) * halfWidth + Math.abs(up.x) * halfHeight;
  const spanY = Math.abs(right.y) * halfWidth + Math.abs(up.y) * halfHeight;
  const spanZ = Math.abs(right.z) * halfWidth + Math.abs(up.z) * halfHeight;
  const endX = pivot.x + S.bx * travel;
  const endY = pivot.y + S.by * travel;
  const endZ = pivot.z + S.bz * travel;
  const minX = Math.min(pivot.x, endX) - spanX;
  const maxX = Math.max(pivot.x, endX) + spanX;
  const minY = Math.min(pivot.y, endY) - spanY;
  const maxY = Math.max(pivot.y, endY) + spanY;
  const minZ = Math.min(pivot.z, endZ) - spanZ;
  const maxZ = Math.max(pivot.z, endZ) + spanZ;
  for (const id of world.ids()) {
    const mesh = world.get(id);
    if (mesh === undefined) continue;
    const bounds = mesh.bounds;
    if (bounds.maxX < minX || bounds.minX > maxX || bounds.maxY < minY || bounds.minY > maxY
      || bounds.maxZ < minZ || bounds.minZ > maxZ) continue;
    S.triangles = mesh.triangles;
    for (let line = 0; line < 5; line++) {
      const across = line === 0 ? 0 : (line === 1 || line === 2 ? halfWidth : -halfWidth);
      const along = line === 0 ? 0 : (line === 1 || line === 3 ? halfHeight : -halfHeight);
      LINE_FROM.x = pivot.x + right.x * across + up.x * along;
      LINE_FROM.y = pivot.y + right.y * across + up.y * along;
      LINE_FROM.z = pivot.z + right.z * across + up.z * along;
      LINE_TO.x = LINE_FROM.x + S.bx * travel;
      LINE_TO.y = LINE_FROM.y + S.by * travel;
      LINE_TO.z = LINE_FROM.z + S.bz * travel;
      walk(mesh, LINE_FROM, LINE_TO);
    }
  }
  S.triangles = undefined;
  return S.best === Number.POSITIVE_INFINITY ? length : near + S.best;
}

function walk(mesh: CollisionMesh, from: Vector3, to: Vector3): void {
  mesh.forEachAlong(from, to, sweepTriangle);
}

const LINE_FROM: Vector3 = { x: 0, y: 0, z: 0 };
const LINE_TO: Vector3 = { x: 0, y: 0, z: 0 };

/** The sweep in progress: the arm's frame, the box and the nearest contact so far (module scratch, no closures). */
const S = {
  px: 0, py: 0, pz: 0, bx: 0, by: 0, bz: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 0, uz: 0,
  halfWidth: 0, halfHeight: 0, travel: 0, best: Number.POSITIVE_INFINITY,
  triangles: undefined as Float32Array | undefined,
};

/** Clip polygons, three numbers (across, up, along the arm) a corner; a triangle clipped four times has at most 7. */
const CLIP_A = new Float64Array(8 * 3);
const CLIP_B = new Float64Array(8 * 3);

function sweepTriangle(triangle: number): void {
  const triangles = S.triangles;
  if (triangles === undefined) return;
  const base = triangle * 9;
  let count = 0;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  let minUp = Infinity;
  let maxUp = -Infinity;
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  for (let corner = 0; corner < 3; corner++) {
    const dx = triangles[base + corner * 3]! - S.px;
    const dy = triangles[base + corner * 3 + 1]! - S.py;
    const dz = triangles[base + corner * 3 + 2]! - S.pz;
    const across = dx * S.rx + dy * S.ry + dz * S.rz;
    const up = dx * S.ux + dy * S.uy + dz * S.uz;
    const along = dx * S.bx + dy * S.by + dz * S.bz;
    CLIP_A[count++] = across;
    CLIP_A[count++] = up;
    CLIP_A[count++] = along;
    if (across < minAcross) minAcross = across;
    if (across > maxAcross) maxAcross = across;
    if (up < minUp) minUp = up;
    if (up > maxUp) maxUp = up;
    if (along < minAlong) minAlong = along;
    if (along > maxAlong) maxAlong = along;
  }
  const halfWidth = S.halfWidth;
  const halfHeight = S.halfHeight;
  // Wholly beside the box, behind the hinge, past the travel, or past a contact already in hand.
  if (minAcross > halfWidth || maxAcross < -halfWidth || minUp > halfHeight || maxUp < -halfHeight) return;
  if (maxAlong < 0 || minAlong > S.travel || minAlong >= S.best) return;
  let points = 3;
  points = clip(CLIP_A, points, CLIP_B, 0, 1, halfWidth);
  points = clip(CLIP_B, points, CLIP_A, 0, -1, halfWidth);
  points = clip(CLIP_A, points, CLIP_B, 1, 1, halfHeight);
  points = clip(CLIP_B, points, CLIP_A, 1, -1, halfHeight);
  if (points === 0) return;
  let nearest = Infinity;
  let farthest = -Infinity;
  for (let point = 0; point < points; point++) {
    const along = CLIP_A[point * 3 + 2]!;
    if (along < nearest) nearest = along;
    if (along > farthest) farthest = along;
  }
  // The part of the triangle inside the box's sides reaches back past the hinge: it touches the quad at the hinge.
  if (farthest < 0) return;
  const contact = nearest < 0 ? 0 : nearest;
  if (contact <= S.travel && contact < S.best) S.best = contact;
}

/** Sutherland–Hodgman against `sign · coordinate[axis] ≤ limit`; returns the corners written to `out`. */
function clip(source: Float64Array, count: number, out: Float64Array, axis: number, sign: number, limit: number): number {
  let written = 0;
  if (count === 0) return 0;
  let previous = count - 1;
  let previousValue = sign * source[previous * 3 + axis]! - limit;
  for (let point = 0; point < count; point++) {
    const value = sign * source[point * 3 + axis]! - limit;
    if ((value <= 0) !== (previousValue <= 0)) {
      const t = previousValue / (previousValue - value);
      out[written * 3] = source[previous * 3]! + (source[point * 3]! - source[previous * 3]!) * t;
      out[written * 3 + 1] = source[previous * 3 + 1]! + (source[point * 3 + 1]! - source[previous * 3 + 1]!) * t;
      out[written * 3 + 2] = source[previous * 3 + 2]! + (source[point * 3 + 2]! - source[previous * 3 + 2]!) * t;
      written++;
    }
    if (value <= 0) {
      out[written * 3] = source[point * 3]!;
      out[written * 3 + 1] = source[point * 3 + 1]!;
      out[written * 3 + 2] = source[point * 3 + 2]!;
      written++;
    }
    previous = point;
    previousValue = value;
  }
  return written;
}
