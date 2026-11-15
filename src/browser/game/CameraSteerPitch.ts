import { CAMERA_WATER_SUBMERGED, CAMERA_WATER_SURFACE } from "./CameraWater.js";

/**
 * 5.14 (15.11): the pitch the right-button steer gives the character — Wow.exe 3.3.5a (12340) 0x006023d0, read-only notes
 * .runtime/re-2026-10-03/l1102gf3/r1.c and .runtime/re-2026-11-15/camera5/k1.c (the CVars, 0x005fd910), k1.data.txt:
 *
 * - The camera's pitch (camera+0x120) plus the smart pivot's turn about the camera (+0x130, CameraPivot.ts), held to ±89°
 *   (0x00ad1b50/0x00ad1b4c) — the way the view is looking, not the arm alone: a camera the pivot has tilted up past a
 *   low ceiling steers the swimmer up as far as the player sees.
 * - Then, unless the camera tracks a click-to-move (camera+0x98 bit 0x100 — never, here), with the camera's subject at
 *   its water's surface (bit 0x100000) or under it (0x200000, CameraWater.cameraWaterState) and `cameraDive` on (default
 *   "1", 0x00c249a0), and the subject not a drunk player (0x004f7290: PLAYER_BYTES_3's inebriation byte or the local one,
 *   × 0.01, must be 0):
 *   - under water, looking up less steeply than `cameraSurfacePitch` (default "0.0", 0x00c2499c) is no pitch at all —
 *     inert by default, since the CVar must be negative for it;
 *   - at the surface, looking down less steeply than `cameraSubmergePitch` (default "18.0", 0x00c24998) is no pitch at all:
 *     a swimmer steering with the mouse stays on the surface until the view dips more than 18° under the horizon.
 * - 0x005fbe70 hands the mover the negative (Wow.exe's pitch is positive looking down; the mover's positive is up).
 *
 * Everything in this client's sign: `cameraPitch` positive looks up (CameraRig `pitch`), `pivotTurn` Wow.exe's (positive
 * looks down, CameraPivot.turn), the answer the mover's (positive is up).
 */

/** 0x00ad1b50 / 0x00ad1b4c: ±89° as Wow.exe keeps it, radians. */
const STEER_PITCH_LIMIT = 1.5533430576324463;
const DEG = Math.PI / 180;

export interface CameraSteerWater {
  /** CameraWater.cameraWaterState of the camera's subject. */
  readonly state: number;
  /** `cameraDive`. */
  readonly dive: boolean;
  /** `cameraSurfacePitch` and `cameraSubmergePitch`, degrees (Wow.exe's sign). */
  readonly surfacePitch: number;
  readonly submergePitch: number;
  /** The subject is a player with any inebriation (0x004f7290 ≠ 0). */
  readonly drunk: boolean;
}

/**
 * What the steer reads of the camera besides its pitch, kept by CameraOptionsLive.ts once a frame (and on each mouse move
 * for the pivot) so the movement code asks a plain record, not the camera's modules.
 */
export const cameraSteerInputs: { pivotTurn: number; water: CameraSteerWater | undefined } = { pivotTurn: 0, water: undefined };

/** The mover's pitch from the steer (0x006023d0 → 0x005fbe70). */
export function cameraSteerPitch(cameraPitch: number, pivotTurn: number, water?: CameraSteerWater): number {
  const raw = -cameraPitch + (Number.isFinite(pivotTurn) ? pivotTurn : 0);
  let pitch = Number.isFinite(raw) ? Math.max(-STEER_PITCH_LIMIT, Math.min(STEER_PITCH_LIMIT, raw)) : 0;
  if (water !== undefined && water.dive && !water.drunk
    && (water.state === CAMERA_WATER_SURFACE || water.state === CAMERA_WATER_SUBMERGED)) {
    const surface = water.surfacePitch * DEG;
    const submerge = water.submergePitch * DEG;
    if (water.state === CAMERA_WATER_SUBMERGED && surface < 0 && pitch < 0 && surface < pitch) pitch = 0;
    if (water.state === CAMERA_WATER_SURFACE && submerge > 0 && pitch > 0 && pitch < submerge) pitch = 0;
  }
  return pitch === 0 ? 0 : -pitch;
}
