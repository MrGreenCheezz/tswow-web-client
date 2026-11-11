/**
 * 5.14 (11.11): the stock «Умный поворот» — `cameraPivot` (default "1", 0x005fd910) with `cameraPivotDXMax` ("0.05")
 * and `cameraPivotDYMin` ("0.00") — as Wow.exe 3.3.5a (12340) does it. Read-only notes: 0x006020b0 in
 * .runtime/re-2026-10-03/l1102gf3/r2.c, 0x005ffde0 in r3.c, 0x00602600 in r4.c, 0x00606f90 in r1.c; 0x006012d0,
 * 0x005fead0, 0x005fef10 and 0x004c55b0 in .runtime/re-2026-11-11/camera/ (c3.c, c4.c) and decb-views/v1.c.
 *
 * - When (0x005ffde0): the switch on, the subject a unit not moving (no forward, back or strafe bit, 0xf), the camera
 *   level or looking up (its pitch ≤ 0, Wow.exe's sign), and the boom held by something last frame — the arm cut
 *   (camera+0x98 bit 0x10000) or the hinge lowered (0x20000; the arm alone while flying, 0x2000000).
 * - The mouse look (0x006020b0): a vertical move with the horizontal under cameraPivotDXMax radians and the vertical
 *   over cameraPivotDYMin — or a pivot already turned and not gliding — turns the view about the camera itself
 *   (camera+0x130, drawn after the camera is placed, 0x004c55b0) instead of swinging the camera on its arm. Looking down
 *   unwinds that turn first (what is left past zero goes to the arm). While the camera's own pitch is below level the
 *   whole move is the pivot's, never past 89° up in all (0x00ad1b50); level or above, the arm gets it too.
 * - Every frame (0x00606f90 → 0x00602600): a pivot that may no longer be held glides back to nothing at
 *   cameraTargetSmoothSpeed (90°/s, 0x00a1e7c4), the camera's half cosine; one that may is held where it is.
 *
 * Here the boom's «held» is CameraRig's: the arm cut by a wall, the ground or the water, the hinge lowered, or the floor
 * tilting the camera down (this client's stand-in for Wow.exe's arm meeting the ground). The pivot is the rig's
 * `pivotPitch`, drawn as the lens pitch (SceneCamera.createCamera).
 */

/** cameraTargetSmoothSpeed's default "90" (0x00a1e7c4), degrees a second. */
export const CAMERA_PIVOT_RETURN_SPEED = 90;
/** 0x00ad1b50: −89° (Wow.exe's −1.5533 rad), the farthest up pitch and pivot reach together. */
const UP_LIMIT = -1.5533430576324463;
/** 0x00a1e34c and 0x009ea27c: a thousandth, and the float's epsilon the turn counts as nothing under. */
const SAME = 1e-3;
const NOTHING = 2.384185791015625e-7;
const DEG = Math.PI / 180;

/** camera+0x98's boom bits (0x00605d60). */
export const CAMERA_BOOM_ARM_HIT = 0x10000;
export const CAMERA_BOOM_HINGE_HIT = 0x20000;

/** What 0x005ffde0 reads. */
export interface CameraPivotSubject {
  readonly enabled: boolean;
  readonly unit: boolean;
  readonly movementFlags: number;
  /** The camera's own pitch, Wow.exe's sign (positive looks down). */
  readonly pitch: number;
  /** Last frame's boom bits ({@link CAMERA_BOOM_ARM_HIT}, {@link CAMERA_BOOM_HINGE_HIT}). */
  readonly boom: number;
}

/** 0x005ffde0. */
export function cameraPivotAllowed(subject: CameraPivotSubject | undefined): boolean {
  if (subject === undefined || !subject.enabled || !subject.unit) return false;
  if ((subject.movementFlags & 0xf) !== 0 || !(subject.pitch <= 0)) return false;
  const bits = (subject.movementFlags & 0x2000000) === 0 ? CAMERA_BOOM_ARM_HIT | CAMERA_BOOM_HINGE_HIT : CAMERA_BOOM_ARM_HIT;
  return (subject.boom & bits) !== 0;
}

export class CameraPivot {
  /** camera+0x130, radians, Wow.exe's sign (negative looks further up). */
  #turn = 0;
  /** Its glide (+0x248 target, +0x24c from, +0x240 start, +0x244 seconds; bit 0x8000000). */
  #gliding = false;
  #to = 0;
  #from = 0;
  #start = 0;
  #seconds = 0;

  /** The view's turn about the camera, Wow.exe's sign. */
  get turn(): number {
    return this.#turn;
  }

  get gliding(): boolean {
    return this.#gliding;
  }

  reset(): void {
    this.#turn = 0;
    this.#gliding = false;
  }

  /**
   * 0x006020b0 for one mouse move: `yaw` and `pitch` are this move's turns in radians (pitch in Wow.exe's sign,
   * mouseInvertPitch already in it); `allowed` is {@link cameraPivotAllowed}; `cameraPitch` the camera's own pitch
   * (Wow.exe's sign). Returns the part of `pitch` the arm takes.
   */
  look(yaw: number, pitch: number, allowed: boolean, cameraPitch: number, dxMax: number, dyMin: number, now: number): number {
    let delta = pitch;
    let pivoting = !this.#gliding && Math.abs(this.#turn) >= SAME;
    let decided = false;
    if (allowed) {
      if (dyMin < Math.abs(delta) && Math.abs(yaw) < dxMax) pivoting = true;
      if (delta > 0) {
        if (this.#turn >= 0 || this.#turn + delta <= 0) {
          if (!(Math.abs(this.#turn) >= NOTHING)) {
            pivoting = false;
            this.#turn = 0;
            this.#to = 0;
            decided = true;
          }
        } else {
          delta = this.#turn + delta;
          pivoting = false;
          this.#turn = 0;
          this.#to = 0;
          decided = true;
        }
      }
    }
    void decided;
    let armToo = !pivoting;
    if (pivoting) {
      this.#turn += delta;
      armToo = cameraPitch >= 0;
      if (cameraPitch < 0 && this.#turn < UP_LIMIT - cameraPitch) this.#turn = UP_LIMIT - cameraPitch;
      if (this.#turn > 0) armToo = true;
    }
    if (pivoting && !armToo) {
      // The glide stops where the turn is; the arm does not move.
      this.#gliding = false;
      this.#to = this.#turn;
      return 0;
    }
    // 0x006012d0(0, 0, 1): the turn glides back while the arm takes the move.
    this.#glideHome(0, 1, now);
    return delta;
  }

  /** 0x00606f90's per-frame rule after 0x00603d30's ease: home when it may no longer be held, else held. */
  frame(now: number, allowed: boolean): number {
    this.#advance(now);
    if (Math.abs(this.#turn) >= SAME && !allowed) this.#glideHome(0, 1, now);
    else {
      this.#gliding = false;
      this.#to = this.#turn;
    }
    return this.#turn;
  }

  /** 0x006012d0 → 0x005fead0: a glide to 0 over |Δ| / 90°/s × factor after `delay`; the same one runs on. */
  #glideHome(delay: number, factor: number, now: number): void {
    if (this.#gliding && Math.abs(this.#to) < SAME) return;
    if (!(Math.abs(this.#turn) >= SAME)) return;
    this.#gliding = true;
    this.#from = this.#turn;
    this.#to = 0;
    this.#start = now + delay * 1000;
    this.#seconds = (Math.abs(this.#turn) / (CAMERA_PIVOT_RETURN_SPEED * DEG)) * factor;
  }

  /** 0x00603d30 on +0x130. */
  #advance(now: number): void {
    if (!this.#gliding) return;
    if (Math.abs(this.#to - this.#turn) < NOTHING) {
      this.#gliding = false;
      this.#turn = this.#to;
      return;
    }
    const elapsed = now - this.#start;
    if (elapsed < 0) return;
    const ratio = this.#seconds > 0 ? (elapsed / 1000) / this.#seconds : Number.POSITIVE_INFINITY;
    this.#turn = ratio <= 1 ? this.#from + (this.#to - this.#from) * 0.5 * (1 - Math.cos(Math.PI * ratio)) : this.#to;
  }
}
