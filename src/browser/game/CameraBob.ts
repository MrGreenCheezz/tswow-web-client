/**
 * 5.14 (11.11): the stock «Покачивание камеры» — `cameraBobbing` (default "0", flags 0, 0x005fd910) with
 * `cameraBobbingSmoothSpeed` ("0.8") — as Wow.exe 3.3.5a (12340) does it. 3.3.5 has no other bobbing CVar (the
 * cameraHeadMovement* family is later); the amplitudes and the rate are plain floats set beside the registration.
 * Read-only notes: .runtime/re-2026-11-11/camera/ (c1.c 0x00600030, c2.c 0x005ffe50/0x00600090/0x009829b0,
 * c2.data.txt), 0x005ffd20 in .runtime/re-2026-10-04/l8-movement/g1.c, 0x00602f30 in .runtime/re-2026-10-03/l1102gf3/r3.c.
 *
 * - The switch (0x00600090, run by 0x005fa170/0x005fa450 as the input word changes): on while the word asks to move —
 *   a run, back, strafe or autorun bit (0xa010f0), both mouse buttons, or the right button (or Mouselook) with a turn
 *   key — and its start time is the moment it came on. Off (0x00600030): the offset of the moment is kept and eased to
 *   nothing over |its largest axis| / cameraBobbingSmoothSpeed seconds (0x00603d30, the camera's half cosine).
 * - The offset (0x00602f30), while the switch is on and 0x005ffd20 lets it: the camera in first person (the arm at most
 *   1/6 yard, 0x00a1e304), the subject a unit, cameraBobbing on, neither swimming nor flying (0x2200000) nor falling
 *   (0x1000), not mounted (unit+0x98c), not on a taxi. With t the seconds since the start and r the subject's speed of
 *   the moment / 7 held to 0.5…1.5 (0x00a1e90c, 0x00a1e378, 0x00a1e2f4; 0x00987570), it sways sideways
 *   sin(2π · 0.8r · t) × 0.0556 yards (0x00c24e5c 0.8, 0x00c24e64 2 × 0x00a3f854 1/36) across the facing (+90°) and
 *   bobs up sin(2π · 1.6r · t) × 0.0556.
 * - Neither on nor easing (0x005ffe50: the offset's sum under 0.001), nothing moves.
 */

/** 0x00a1e304: the arm in first person, yards. */
export const CAMERA_BOB_ARM = 0.1666666716337204;
/** 0x00c24e64 × 0x00a3f854 and 0x00c24e60 × 0x00a3f854: sideways and up, yards. */
export const CAMERA_BOB_AMPLITUDE = 2 * 0.02777777798473835;
/** 0x00c24e5c: the sway's rate at r = 1, cycles a second; the bob runs at twice it. */
export const CAMERA_BOB_RATE = 0.800000011920929;
/** 0x00a1e90c, 0x00a1e378, 0x00a1e2f4: r is the speed × 1/7 held to 0.5…1.5. */
const SPEED_SCALE = 0.1428571492433548;
const RATE_LOW = 0.5;
const RATE_HIGH = 1.5;
/** cameraBobbingSmoothSpeed's default "0.8" (0x00a1e790), yards a second. */
export const CAMERA_BOB_SMOOTH_SPEED = 0.8;
const SAME = 1e-3;

/** The input word's bits 0x00600090 is handed (CameraFollow.ts's word). */
const MOVE_BITS = 0xa010f0;

/** 0x005fa170/0x005fa450: whether an input word turns the bobbing on. */
export function cameraBobInput(word: number): boolean {
  return (word & MOVE_BITS) !== 0 || (word & 3) === 3 || ((word & 0x2000001) !== 0 && (word & 0x300) !== 0);
}

/** What 0x005ffd20 asks of the camera and its subject. */
export interface CameraBobSubject {
  /** The arm, yards (the wheel's distance here). */
  readonly arm: number;
  readonly unit: boolean;
  readonly enabled: boolean;
  readonly movementFlags: number;
  readonly mounted: boolean;
  readonly taxi: boolean;
  /** Radians. */
  readonly facing: number;
  /** The subject's speed of the moment (0x00987570), yards a second. */
  readonly speed: number;
}

/** 0x005ffd20 without the switch. */
export function cameraBobAllowed(subject: CameraBobSubject | undefined): boolean {
  if (subject === undefined || !(subject.arm <= CAMERA_BOB_ARM) || !subject.unit || !subject.enabled) return false;
  if ((subject.movementFlags & 0x2200000) !== 0 || (subject.movementFlags & 0x1000) !== 0) return false;
  return !subject.mounted && !subject.taxi;
}

export class CameraBob {
  /** camera+0x98 bit 0x200. */
  #on = false;
  /** camera+0x288: the switch's start (on) or the ease's (off), ms. */
  #start = 0;
  /** camera+0x28c: the ease's seconds. */
  #seconds = 0;
  /** camera+0x290…0x298: the offset the ease starts from. */
  readonly #from = { x: 0, y: 0, z: 0 };
  /** camera+0x140…0x148: the offset drawn, yards. */
  readonly offset = { x: 0, y: 0, z: 0 };

  get on(): boolean {
    return this.#on;
  }

  /** 0x00600090 with the word's answer. */
  input(on: boolean, now: number): void {
    if (!this.#on && on) {
      this.#on = true;
      this.#start = now;
    }
    if (this.#on && !on) {
      // 0x00600030: the ease takes the largest axis's size over the smoothing speed (0x009829b0 picks it).
      this.#on = false;
      const o = this.offset;
      const ax = Math.abs(o.x);
      const ay = Math.abs(o.y);
      const az = Math.abs(o.z);
      const largest = ax <= ay ? (az < ay ? o.y : o.z) : (az < ax ? o.x : o.z);
      this.#from.x = o.x;
      this.#from.y = o.y;
      this.#from.z = o.z;
      this.#seconds = Math.abs(largest) / CAMERA_BOB_SMOOTH_SPEED;
      this.#start = now;
    }
  }

  /** One camera frame: the ease (0x00603d30), then the bob (0x00602f30). Returns the offset; allocates nothing. */
  frame(now: number, subject: CameraBobSubject | undefined): { readonly x: number; readonly y: number; readonly z: number } {
    const allowed = this.#on && cameraBobAllowed(subject);
    const o = this.offset;
    if (!allowed && Math.abs(o.x + o.y + o.z) >= SAME) {
      const ratio = this.#seconds > 0 ? ((now - this.#start) / 1000) / this.#seconds : Number.POSITIVE_INFINITY;
      if (ratio <= 1) {
        const ease = 0.5 * (1 - Math.cos(Math.PI * ratio));
        o.x = this.#from.x * (1 - ease);
        o.y = this.#from.y * (1 - ease);
        o.z = this.#from.z * (1 - ease);
      } else {
        o.x = 0;
        o.y = 0;
        o.z = 0;
      }
    }
    if (allowed && subject !== undefined) {
      const scaled = subject.speed * SPEED_SCALE;
      const rate = (RATE_LOW <= scaled && scaled < RATE_HIGH ? scaled : scaled >= RATE_HIGH ? RATE_HIGH : RATE_LOW)
        * CAMERA_BOB_RATE;
      const seconds = (now - this.#start) / 1000;
      const sway = Math.sin(seconds * rate * Math.PI * 2) * CAMERA_BOB_AMPLITUDE;
      o.x = Math.cos(subject.facing + Math.PI / 2) * sway;
      o.y = Math.sin(subject.facing + Math.PI / 2) * sway;
      o.z = Math.sin(2 * rate * seconds * Math.PI * 2) * CAMERA_BOB_AMPLITUDE;
    }
    return o;
  }

  reset(): void {
    this.#on = false;
    this.offset.x = 0;
    this.offset.y = 0;
    this.offset.z = 0;
  }
}
