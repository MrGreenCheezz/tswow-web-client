import { CAMERA_PITCH_LIMIT } from "./CameraRig.js";
import {
  CAMERA_CVAR_DISTANCE_MAX, CAMERA_CVAR_PITCH_MAX, CAMERA_CVAR_YAW_MAX, cameraCVarAccepts,
  cameraCVarDefinition, cameraCVarFloat, cameraViewCVar,
} from "./CameraCVars.js"; // 3.11

/**
 * DEC-B 3.11 (04.10): the stock camera views — SetView, SaveView, ResetView, NextView, PrevView and
 * FlipCameraYaw, the keys End and Home — as Wow.exe 3.3.5a (12340) keeps them. Read-only notes:
 * .runtime/re-2026-10-04/decb-views/ (v1–v3) and .runtime/re-2026-10-04/l2-targeting/ (g1–g3).
 *
 * - Lua (registration 0xad20d0–0xad20f8): SetView 0x6039b0, SaveView 0x5ff260, ResetView 0x604c80,
 *   NextView 0x604ce0, PrevView 0x604d10, FlipCameraYaw 0x5ff2c0. SetView, SaveView and ResetView act
 *   on views 1–5 only; NextView and PrevView step the current view (camera+0xb4) by one inside 1–5.
 * - The camera keeps eight views (camera+0xb8, three floats each: yards, then pitch and yaw in
 *   radians): 0 FIRST_PERSON, 1–5 THIRD_PERSON_A–E, 6 VIEW_COMMENTATOR, 7 VIEW_BARBER_SHOP (names
 *   0xad213c). The defaults are strings (0xad1ba8, degrees where 0xad1b80 says so): view 1 is 0 yards
 *   — first person — 2 is 5.55 yd at 10°, 3 5.55/20°, 4 13.88/30°, 5 13.88/10°, every yaw 0.
 * - Each view is three CVars (registered 0x5fdc4b, flags 0x50): "camera" + Distance|Pitch|Yaw + "", A–E,
 *   "Com" or "Barber Shop" — cameraDistanceA … cameraYawE — kept between 0 and 50 yards, ±89° and
 *   0–360° by their validators (0x5fd680, 0x5fd6d0, 0x5fd7b0). `cameraView` (0xc24dc4, default "2",
 *   0–7, 0x5fd630) is the current view and `cameraViewBlendStyle` (0xc24e28, default "1") how a switch
 *   moves. Flag 0x10 puts all of them in the account-wide config cache (0x767030 writes the CVars whose
 *   flags & 0x30 match the slot asked for, 0x512890): the views are the account's, not a character's.
 *   This client keeps them per account in browser storage ({@link cameraViewStorageKey}).
 * - SaveView (0x5fe4e0 → 0x5fe440) writes where the camera is going — the distance, pitch and yaw the
 *   glides are heading for (camera+0x1e8, +0x230, +0x260) — into the view and its three CVars ("%f",
 *   degrees). ResetView (0x6048a0) puts the defaults back in the camera only: the CVars keep the saved
 *   view, which the next load brings back (0x5fe510, run when the account data has arrived, 0x518bf0).
 *   Resetting the current view moves the camera to it.
 * - The switch (0x603330): a new index is written to cameraView ("%d"); every glide stops where it is;
 *   the targets are the view's distance, its pitch, and its yaw from the facing. Blend style 1 glides,
 *   2 jumps, anything else moves nothing. Each axis would take |Δ| over its speed — cameraDistance-
 *   SmoothSpeed 8.33 yd/s (0x600e00), cameraPitchSmoothSpeed 45°/s (0x601190), cameraYawSmoothSpeed
 *   180°/s (0x601410, the short way round) — and they all take the longest, held to cameraSmoothTime-
 *   Min/Max (0.1–2 s), easing along 0.5·(1 − cos πt) (0x8ca080, advanced by 0x603d30). An axis under a
 *   thousandth of its target does not glide (0x5fe950). The same view again with the camera untouched
 *   since (camera+0x98 bit 0x40, set by the wheel and the mouse look 0x6020b0) jumps.
 * - Wow.exe's pitch is positive looking down (0x5fbe70 hands the character −pitch): this rig's `pitch`
 *   is the negative of a view's.
 * - FlipCameraYaw adds its degrees to a yaw of its own (camera+0x12c), added after everything else
 *   (0x604490) and left alone by the views, the follow and the steer (0x6023d0 turns the character by
 *   camera+0x11c only); a new camera (0x606b30) starts without one. The rig's `yaw` is the drawn yaw,
 *   so it carries the flip and `flipYaw` says how much of it that is.
 * - A vehicle seat changes nothing here: neither SetView nor 0x603330 asks about it, and the vehicle's
 *   own camera moves (0x600590, 0x5ffb70) are the zoom's, not these glides. The caller passes the
 *   wheel's ceiling of the moment (the vehicle's 50 yards in vehicle mode).
 * - A new camera (world entry, 0x606b30) takes its view index from cameraView; its distance there is
 *   the per-character cameraSavedDistance/Pitch (0x5ff3e0; default view 2's 5.55 yd and 10°) — CameraSaved.ts
 *   since 5.14 (12.10); here only the index is taken.
 *
 * Once a frame `frame` compares numbers and, while a glide runs, writes three; nothing is allocated.
 *
 * 3.11 (13.10): the glides are the camera's own three slots, one per axis, shared with the follow
 * (CameraFollow.ts, 0x00602760) as Wow.exe shares them: each has its target, start, time, delay and factor
 * (distance +0x1e8/+0x1e0/+0x1e4, pitch +0x230/+0x228/+0x22c/+0x23c/+0x238, yaw +0x260/+0x258/+0x25c/
 * +0x26c/+0x268); a start in the future is a delay (0x00603d30 moves an axis only once now − start ≥ 0). The
 * mouse's hold on the camera — "Camera FREELOOK", camera+0x98 bit 1, set when the first of the two mouse commands
 * goes down (0x006047e0 → 0x00601ff0) and cleared when the last comes up (0x00604850 → 0x00601f70) — stops the
 * pitch and yaw glides where they are, both on the press (0x00601ff0 sets their targets to the camera) and on the
 * release (0x00604850 does the same); in between 0x00603d30 does not move the yaw at all, so a switch made while a
 * button is held glides the distance and the pitch, and its yaw never happens. The release with the sticky
 * argument (CameraOrSelectOrMoveStop(IsModifiedClick("STICKYCAMERA")), Bindings.xml) leaves camera+0x98 bit 0x20
 * set, which keeps the follow off until a release without it (0x005fff40). Was one shared glide, and a yaw glide
 * that went on under a held button.
 */

/** The eight views the camera keeps (camera+0xb8). */
export const CAMERA_VIEW_SLOTS = 8;
/** SetView, SaveView and ResetView take 1–5; NextView and PrevView stay inside them. */
export const CAMERA_VIEW_LOWEST = 1;
export const CAMERA_VIEW_HIGHEST = 5;
/** VIEW_COMMENTATOR: 0x603330 takes it only for a commentator, which this client never is. */
export const CAMERA_VIEW_COMMENTATOR = 6;
/** `cameraView`'s default (0x5fdc3c: "2", the string at 0xad1b90). */
export const CAMERA_VIEW_DEFAULT = 2;

/** The defaults (0xad1ba8): yards, pitch in degrees (positive looks down), yaw in degrees from the facing. */
export const CAMERA_VIEW_DEFAULTS: readonly (readonly [distance: number, pitch: number, yaw: number])[] = Object.freeze([
  Object.freeze([0, 0, 0] as const), Object.freeze([0, 0, 0] as const), Object.freeze([5.55, 10, 0] as const),
  Object.freeze([5.55, 20, 0] as const), Object.freeze([13.88, 30, 0] as const), Object.freeze([13.88, 10, 0] as const),
  Object.freeze([0, 0, 0] as const), Object.freeze([5, 10, 0] as const),
]);

/** `cameraViewBlendStyle`: 1 glides (the default), 2 jumps. */
export const CAMERA_VIEW_BLEND_SMOOTH = 1;
export const CAMERA_VIEW_BLEND_INSTANT = 2;
/** `cameraDistanceSmoothSpeed` (0x5fdb08: "8.33"), yards a second; this client has no setting for it. */
export const CAMERA_DISTANCE_SMOOTH_SPEED = 8.33;
/** `cameraSmoothTimeMin` (0x5fe276: "0.1") and `cameraSmoothTimeMax` (0x5fe29e: "2.0"), seconds. */
export const CAMERA_SMOOTH_TIME_MIN = 0.1;
export const CAMERA_SMOOTH_TIME_MAX = 2;

const CVAR_VIEW = "cameraView";
const CVAR_BLEND = "cameraViewBlendStyle";
/** 3.11: 0x005fff40 — the follow runs in a view moved off its defaults only with this on ("0"). */
const CVAR_CUSTOM_SMOOTHING = "cameraCustomViewSmoothing";
/** 3.11: what 0x00603330 holds a switch's time to (cameraSmoothTimeMin/Max, CameraCVars.ts). */
const CVAR_TIME_MIN = "cameraSmoothTimeMin";
const CVAR_TIME_MAX = "cameraSmoothTimeMax";
/** Two numbers closer than this are the same (0x00a1e34c). */
const SAME = 1e-3;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** 3.11: the camera's three glide slots (distance +0x118, pitch +0x120, yaw +0x11c). */
export const CAMERA_AXIS_DISTANCE = 0;
export const CAMERA_AXIS_PITCH = 1;
export const CAMERA_AXIS_YAW = 2;
const AXES = 3;

// 3.11: the names now live with the other camera CVars (CameraCVars.ts); still exported from here.
export { cameraViewCVar };

/** Where an account's views are kept; Latin letters fold, as the account name does (FrameXmlCVarPersistence). */
export function cameraViewStorageKey(account: string): string {
  return `webclient.camera-views.v1:${account.replace(/[A-Z]/g, (letter) => letter.toLowerCase())}`;
}

/** The camera numbers the views move: CameraRig's. */
export interface CameraViewRig {
  /** The drawn yaw, from the facing, flip included. */
  yaw: number;
  /** Positive looks up. */
  pitch: number;
  /** The wheel's number, yards. */
  distance: number;
  /** FlipCameraYaw's part of `yaw` (camera+0x12c); none is 0. */
  flipYaw?: number | undefined;
}

/** What a switch reads from the settings of the moment. */
export interface CameraViewMotion {
  /** cameraYawSmoothSpeed, degrees a second. */
  readonly yawSpeed: number;
  /** cameraPitchSmoothSpeed, degrees a second. */
  readonly pitchSpeed: number;
  /** The wheel's ceiling, yards. */
  readonly ceiling: number;
}

export interface CameraViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Into [−π, π). */
function wrap(angle: number): number {
  return angle - TAU * Math.floor((angle + Math.PI) / TAU);
}

/** The yaw the steer and the follow see: the drawn one less the flip (camera+0x11c). */
export function cameraYawOffFlip(rig: { readonly yaw: number; readonly flipYaw?: number | undefined }): number {
  const flip = rig.flipYaw;
  return flip ? wrap(rig.yaw - flip) : rig.yaw;
}

/** A CVar's value inside its validator's range, or undefined. */
function ranged(text: string | undefined, low: number, high: number): number | undefined {
  if (text === undefined || !/\S/.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= low && value <= high ? value : undefined;
}

/** |Δ| over a speed in radians a second, times the factor; no speed is the longest glide. */
function glideSeconds(delta: number, speed: number, factor: number): number {
  return speed > 0 && Number.isFinite(speed) ? (delta / speed) * factor : CAMERA_SMOOTH_TIME_MAX;
}

function pageStorage(): CameraViewStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** An axis's number on the rig: the yaw is the drawn one. */
function axisValue(rig: CameraViewRig, axis: number): number {
  return axis === CAMERA_AXIS_DISTANCE ? rig.distance : axis === CAMERA_AXIS_PITCH ? rig.pitch : rig.yaw;
}

export class CameraViews {
  /** Yards, pitch degrees (positive looks down) and yaw degrees, per view. */
  readonly #distance = new Float64Array(CAMERA_VIEW_SLOTS);
  readonly #pitch = new Float64Array(CAMERA_VIEW_SLOTS);
  readonly #yaw = new Float64Array(CAMERA_VIEW_SLOTS);
  /** The CVars written so far, by name: what the account keeps. */
  #cvars = new Map<string, string>();
  readonly #storageOption: CameraViewStorage | null | undefined;
  #storage: CameraViewStorage | undefined;
  #key: string | undefined;
  #current = CAMERA_VIEW_DEFAULT;
  /** camera+0x98 bit 0x40: the camera was moved by hand since the last switch. */
  #moved = true;
  /** What the last switch aimed at (rig units: yards, pitch up positive, yaw without the flip). */
  #aimD = 0;
  #aimP = 0;
  #aimY = 0;
  /**
   * 3.11: the three glide slots (was one glide over a mask of axes). Rig units; the yaw's from/to are without the
   * flip. `#start` may lie ahead of now — the follow's delay; `#delay`/`#factor` are what 0x00601190 and 0x00601410
   * compare a new request with; `#wrote` is the number last written, so a hand on the axis shows.
   */
  readonly #active = new Uint8Array(AXES);
  readonly #from = new Float64Array(AXES);
  readonly #to = new Float64Array(AXES);
  readonly #start = new Float64Array(AXES);
  readonly #ms = new Float64Array(AXES);
  readonly #delay = new Float64Array(AXES);
  readonly #factor = new Float64Array(AXES);
  readonly #wrote = new Float64Array(AXES);
  /** 3.11: camera+0x98 bit 1, "Camera FREELOOK": a mouse command holds the camera (0x00601ff0 … 0x00601f70). */
  #freelook = false;
  /** 3.11: camera+0x98 bit 0x20, the sticky release (0x00604850). */
  #sticky = false;
  #world: unknown;
  #bound = false;

  /** `storage`: undefined is the page's localStorage, null none (tests pass their own). */
  constructor(storage?: CameraViewStorage | null) {
    this.#storageOption = storage;
    this.#readTable();
  }

  /** The current view (camera+0xb4). */
  get current(): number {
    return this.#current;
  }

  /** Whether a glide is under way on any axis, a delayed one included. */
  get gliding(): boolean {
    return this.#active[0] !== 0 || this.#active[1] !== 0 || this.#active[2] !== 0;
  }

  /** The longest running glide's time, seconds (tests). */
  get glideSeconds(): number {
    let ms = 0;
    for (let axis = 0; axis < AXES; axis += 1) if (this.#active[axis] !== 0) ms = Math.max(ms, this.#ms[axis]!);
    return ms / 1000;
  }

  /** 3.11: whether a mouse command holds the camera (camera+0x98 bit 1). */
  get freelooking(): boolean {
    return this.#freelook;
  }

  /** A view as the camera keeps it: yards, degrees (positive pitch looks down), yaw 0–360 (tests, diagnostics). */
  view(index: number): { distance: number; pitch: number; yaw: number } {
    return { distance: this.#distance[index] ?? 0, pitch: this.#pitch[index] ?? 0, yaw: this.#yaw[index] ?? 0 };
  }

  /** 3.11: a view's yaw in radians, from the facing (camera+0xc0 + view·0xc). */
  viewYaw(index: number): number {
    return (this.#yaw[index] ?? 0) * DEG;
  }

  /**
   * Once a frame, before the follow: a new world is a new camera (0x606b30 — the index from cameraView,
   * no flip, the account's views), then the glide (0x603d30). Nothing is allocated unless the world changed.
   */
  frame(rig: CameraViewRig, now: number, world: unknown, account: string | undefined): void {
    if (world !== this.#world) this.#newCamera(rig, world, account);
    if (this.gliding) this.#advance(rig, now);
  }

  /** `SetView(index)`: views 1–5. Whether it switched. */
  setView(index: number, rig: CameraViewRig, now: number, motion: CameraViewMotion): boolean {
    if (!(index >= CAMERA_VIEW_LOWEST && index <= CAMERA_VIEW_HIGHEST)) return false;
    return this.#switch(index, rig, now, motion);
  }

  /** `NextView()` (End): the next view up to 5. */
  nextView(rig: CameraViewRig, now: number, motion: CameraViewMotion): boolean {
    return this.#current < CAMERA_VIEW_HIGHEST && this.#switch(this.#current + 1, rig, now, motion);
  }

  /** `PrevView()` (Home): the one before, down to 1 — first person by default. */
  prevView(rig: CameraViewRig, now: number, motion: CameraViewMotion): boolean {
    return CAMERA_VIEW_LOWEST < this.#current && this.#switch(this.#current - 1, rig, now, motion);
  }

  /** `SaveView(index)`: views 1–5 take where the camera is going; the CVars keep what their ranges allow. */
  saveView(index: number, rig: CameraViewRig): boolean {
    if (!(index >= CAMERA_VIEW_LOWEST && index <= CAMERA_VIEW_HIGHEST)) return false;
    // 3.11: the targets of the running glides (camera+0x1e8, +0x230, +0x260), per slot (was the last switch's aims).
    const distance = this.#active[CAMERA_AXIS_DISTANCE] !== 0 ? this.#to[CAMERA_AXIS_DISTANCE]! : rig.distance;
    const pitch = this.#active[CAMERA_AXIS_PITCH] !== 0 ? this.#to[CAMERA_AXIS_PITCH]! : rig.pitch;
    const yaw = this.#active[CAMERA_AXIS_YAW] !== 0 ? this.#to[CAMERA_AXIS_YAW]! : cameraYawOffFlip(rig);
    const turn = ((yaw % TAU) + TAU) % TAU;
    this.#distance[index] = distance;
    this.#pitch[index] = (0 - pitch) / DEG;
    this.#yaw[index] = turn / DEG;
    // 0x5fe440: each CVar through its validator; one it refuses keeps the value it had.
    this.#writeCVar(cameraViewCVar("Distance", index), this.#distance[index]!, 0, CAMERA_CVAR_DISTANCE_MAX);
    this.#writeCVar(cameraViewCVar("Pitch", index), this.#pitch[index]!, -CAMERA_CVAR_PITCH_MAX, CAMERA_CVAR_PITCH_MAX);
    this.#writeCVar(cameraViewCVar("Yaw", index), this.#yaw[index]!, 0, CAMERA_CVAR_YAW_MAX);
    this.#persist();
    return true;
  }

  /** `ResetView(index)`: the default back in the camera (not in the CVars); the current view is re-applied. */
  resetView(index: number, rig: CameraViewRig, now: number, motion: CameraViewMotion): boolean {
    if (!(index >= CAMERA_VIEW_LOWEST && index <= CAMERA_VIEW_HIGHEST)) return false;
    const row = CAMERA_VIEW_DEFAULTS[index]!;
    this.#distance[index] = row[0];
    this.#pitch[index] = row[1];
    this.#yaw[index] = row[2];
    if (index === this.#current) this.#switch(index, rig, now, motion);
    return true;
  }

  /** `FlipCameraYaw(degrees)`: a yaw of its own, kept apart from the view's (camera+0x12c). */
  flipCameraYaw(degrees: number, rig: CameraViewRig): void {
    // Wow.exe would carry a NaN into the camera for good; the rig is kept finite.
    if (!Number.isFinite(degrees)) return;
    const turn = degrees * DEG;
    rig.flipYaw = wrap((rig.flipYaw ?? 0) + turn);
    rig.yaw = wrap(rig.yaw + turn);
    if (this.#active[CAMERA_AXIS_YAW] !== 0) this.#wrote[CAMERA_AXIS_YAW] = rig.yaw;
  }

  // ---- 3.11: the follow's hand on the slots (CameraFollow.ts) and the mouse's hold -------------------------------

  /**
   * 3.11: the first mouse command down (`down`, 0x006047e0 → 0x00601ff0) or the last one up (0x00604850 →
   * 0x00601f70, `sticky` its argument). Both stop the pitch and yaw glides where they are; the distance's goes on.
   */
  freelook(down: boolean, sticky: boolean): void {
    if (down) {
      if (this.#freelook) return;
      this.#freelook = true;
    } else {
      this.#freelook = false;
      this.#sticky = sticky;
    }
    this.stopAxis(CAMERA_AXIS_PITCH);
    this.stopAxis(CAMERA_AXIS_YAW);
  }

  /**
   * 3.11: 0x005fff40 — whether the follow may move this camera: not after a sticky release, and in a view moved off
   * its defaults (0x005ff8e0, SaveView's doing) only with cameraCustomViewSmoothing on.
   */
  followAllowed(): boolean {
    if (this.#sticky) return false;
    return Math.trunc(this.cvarNumber(CVAR_CUSTOM_SMOOTHING)) !== 0 || this.#atDefaults(this.#current);
  }

  /**
   * 3.11: 0x00601190 (pitch) and 0x00601410 (yaw): a glide of `axis` to `target` (rig units; the yaw without the
   * flip) after `delay` seconds over |Δ| / `speed` (rig units a second) × `factor` seconds. The same glide already under way
   * (target, delay and factor within a thousandth) is kept; a camera already there starts none (and leaves any other
   * glide of the axis alone). The answer is the glide's time in seconds, or −1 for none; the follow then holds every
   * glide it asked for to one shared time (`setAxisSeconds`).
   */
  glideAxis(axis: number, target: number, delay: number, factor: number, speed: number, now: number, rig: CameraViewRig): number {
    const own = axis === CAMERA_AXIS_YAW ? cameraYawOffFlip(rig) : axisValue(rig, axis);
    // 0x005fd5c0: the current value is taken within half a turn of the target.
    const from = axis === CAMERA_AXIS_DISTANCE ? own : target + wrap(own - target);
    if (this.#active[axis] !== 0 && Math.abs(this.#to[axis]! - target) < SAME
      && Math.abs(this.#delay[axis]! - delay) < SAME && Math.abs(this.#factor[axis]! - factor) < SAME) {
      return this.#ms[axis]! / 1000;
    }
    if (!(Math.abs(from - target) >= SAME)) return -1;
    const seconds = glideSeconds(Math.abs(target - from), speed, factor);
    this.#active[axis] = 1;
    this.#from[axis] = from;
    this.#to[axis] = target;
    this.#start[axis] = now + delay * 1000;
    this.#ms[axis] = seconds * 1000;
    this.#delay[axis] = delay;
    this.#factor[axis] = factor;
    this.#wrote[axis] = axisValue(rig, axis);
    return seconds;
  }

  /** 3.11: a running glide's time (the follow's shared one), seconds. */
  setAxisSeconds(axis: number, seconds: number): void {
    if (this.#active[axis] !== 0) this.#ms[axis] = seconds * 1000;
  }

  /** 3.11: 0x005feee0 (pitch), 0x005fef40 (yaw): the glide stops, its target where the camera is. */
  stopAxis(axis: number): void {
    this.#active[axis] = 0;
  }

  // ---- 3.11: the account's camera CVars (CameraCVars.ts) for GetCVar/SetCVar ---------------------------------------

  /** A camera CVar's string — what was written, else its default — or undefined for another name. */
  cvar(name: string): string | undefined {
    const definition = cameraCVarDefinition(name);
    if (!definition) return undefined;
    return this.#cvars.get(definition.name) ?? definition.defaultValue;
  }

  /** A camera CVar's default string, or undefined for another name. */
  cvarDefault(name: string): string | undefined {
    return cameraCVarDefinition(name)?.defaultValue;
  }

  /**
   * `SetCVar` of a camera CVar: kept for the account when its validator takes it (false when it refuses), undefined
   * for another name. As in the client, the CVars of the views reach the camera at its next creation (0x005fe510 from
   * 0x00606b30), and cameraView is only the index a new camera starts in.
   */
  setCVar(name: string, value: unknown): boolean | undefined {
    const definition = cameraCVarDefinition(name);
    if (!definition) return undefined;
    const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
    if (text === undefined || text.length > 64 || !cameraCVarAccepts(definition, text)) return false;
    this.#cvars.set(definition.name, text);
    this.#persist();
    return true;
  }

  /** A camera CVar's number: atof of its string (the client's +0x2c). */
  cvarNumber(name: string): number {
    return cameraCVarFloat(this.cvar(name));
  }

  /** 0x606b30 for the camera of a new world; the account's record when the account changed. */
  #newCamera(rig: CameraViewRig, world: unknown, account: string | undefined): void {
    this.#world = world;
    const key = account === undefined ? undefined : cameraViewStorageKey(account);
    if (!this.#bound || key !== this.#key) {
      this.#bound = true;
      this.#key = key;
      this.#storage = key === undefined ? undefined
        : this.#storageOption === null ? undefined : this.#storageOption ?? pageStorage();
      this.#cvars = this.#readRecord();
    }
    // DEC-review 3.11: every new camera reads the views from their CVars (0x606b30 calls 0x5fe510), so a ResetView
    // lasts until the next world; it was read only when the account changed. 24 map reads once a world.
    this.#readTable();
    const flip = rig.flipYaw;
    if (flip) {
      rig.yaw = wrap(rig.yaw - flip);
      rig.flipYaw = 0;
    }
    const index = ranged(this.#cvars.get(CVAR_VIEW), 0, CAMERA_VIEW_SLOTS - 1);
    this.#current = index === undefined ? CAMERA_VIEW_DEFAULT : Math.trunc(index);
    this.#active.fill(0);
    this.#moved = true;
    this.#sticky = false; // 3.11: a new camera's flags are clear
  }

  /** 0x603330: the switch to view `index`. */
  #switch(index: number, rig: CameraViewRig, now: number, motion: CameraViewMotion): boolean {
    if (index === CAMERA_VIEW_COMMENTATOR) return false;
    let style = this.#blendStyle();
    const flip = rig.flipYaw ?? 0;
    if (index === this.#current && !this.#movedSince(rig, flip) && style !== 0) style = CAMERA_VIEW_BLEND_INSTANT;
    if (index !== this.#current) {
      this.#current = index;
      this.#cvars.set(CVAR_VIEW, String(index));
      this.#persist();
    }
    // Every glide stops where it is.
    this.#active.fill(0);
    this.#moved = false;
    const ceiling = Number.isFinite(motion.ceiling) && motion.ceiling >= 0 ? motion.ceiling : CAMERA_CVAR_DISTANCE_MAX;
    const toD = Math.min(this.#distance[index]!, ceiling);
    const toP = Math.max(-CAMERA_PITCH_LIMIT, Math.min(CAMERA_PITCH_LIMIT, (0 - this.#pitch[index]!) * DEG));
    const toY = wrap(this.#yaw[index]! * DEG);
    this.#aimD = toD;
    this.#aimP = toP;
    this.#aimY = toY;
    if (style === CAMERA_VIEW_BLEND_INSTANT) {
      rig.distance = toD;
      rig.pitch = toP;
      rig.yaw = wrap(toY + flip);
      return true;
    }
    if (style !== CAMERA_VIEW_BLEND_SMOOTH) return true;
    // Each axis at factor 1 and no delay (0x00600e00, 0x00601190, 0x00601410 with 0, 1.0), then the longest time,
    // held to cameraSmoothTimeMin/Max, for all of them. The distance's speed has no setting here (8.33).
    const seconds = [
      this.glideAxis(CAMERA_AXIS_DISTANCE, toD, 0, 1, CAMERA_DISTANCE_SMOOTH_SPEED, now, rig),
      this.glideAxis(CAMERA_AXIS_PITCH, toP, 0, 1, motion.pitchSpeed * DEG, now, rig),
      this.glideAxis(CAMERA_AXIS_YAW, toY, 0, 1, motion.yawSpeed * DEG, now, rig),
    ];
    if (!this.gliding) return true;
    const longest = Math.max(0, seconds[0]!, seconds[1]!, seconds[2]!);
    const shared = Math.min(this.#timeMax(), Math.max(this.#timeMin(), longest));
    for (let axis = 0; axis < AXES; axis += 1) this.setAxisSeconds(axis, shared);
    return true;
  }

  #timeMin(): number {
    return this.cvarNumber(CVAR_TIME_MIN);
  }

  #timeMax(): number {
    return this.cvarNumber(CVAR_TIME_MAX);
  }

  /** 0x005ff8e0: a view still holding its defaults (each number within a thousandth, angles in radians). */
  #atDefaults(index: number): boolean {
    const row = CAMERA_VIEW_DEFAULTS[index];
    if (!row) return true;
    return Math.abs(this.#distance[index]! - row[0]) < SAME && Math.abs((this.#pitch[index]! - row[1]) * DEG) < SAME
      && Math.abs((this.#yaw[index]! - row[2]) * DEG) < SAME;
  }

  /** camera+0x98 bit 0x40: moved by hand since the last switch, or a new camera never switched. */
  #movedSince(rig: CameraViewRig, flip: number): boolean {
    if (this.#moved) return true;
    if (this.gliding) return false;
    return Math.abs(rig.distance - this.#aimD) >= SAME || Math.abs(rig.pitch - this.#aimP) >= SAME
      || Math.abs(wrap(rig.yaw - flip - this.#aimY)) >= SAME;
  }

  /**
   * 0x603d30: one frame of each glide; an axis someone else moved since the last frame is theirs. A glide whose start
   * is still ahead waits; the yaw does not move while the mouse holds the camera (3.11).
   */
  #advance(rig: CameraViewRig, now: number): void {
    for (let axis = 0; axis < AXES; axis += 1) {
      if (this.#active[axis] === 0) continue;
      if (axisValue(rig, axis) !== this.#wrote[axis]) {
        this.#active[axis] = 0;
        this.#moved = true;
        continue;
      }
      if (axis === CAMERA_AXIS_YAW && this.#freelook) continue;
      const elapsed = now - this.#start[axis]!;
      if (elapsed < 0) continue;
      const ms = this.#ms[axis]!;
      const t = ms > 0 ? elapsed / ms : 1;
      const done = t >= 1;
      // 0x8ca080: from + (to − from)·0.5·(1 − cos πt).
      const own = done ? this.#to[axis]! : this.#from[axis]! + (this.#to[axis]! - this.#from[axis]!) * 0.5 * (1 - Math.cos(Math.PI * t));
      let value = own;
      if (axis === CAMERA_AXIS_DISTANCE) rig.distance = value;
      else if (axis === CAMERA_AXIS_PITCH) rig.pitch = value;
      else {
        value = wrap(own + (rig.flipYaw ?? 0));
        rig.yaw = value;
      }
      this.#wrote[axis] = value;
      if (done) this.#active[axis] = 0;
    }
  }

  #blendStyle(): number {
    const style = ranged(this.#cvars.get(CVAR_BLEND), -2147483648, 2147483647);
    return style === undefined ? CAMERA_VIEW_BLEND_SMOOTH : Math.trunc(style);
  }

  /** 0x5fe510: the table from the CVars, each through its validator, else the default. */
  #readTable(): void {
    for (let view = 0; view < CAMERA_VIEW_SLOTS; view += 1) {
      const row = CAMERA_VIEW_DEFAULTS[view]!;
      this.#distance[view] = ranged(this.#cvars.get(cameraViewCVar("Distance", view)), 0, CAMERA_CVAR_DISTANCE_MAX) ?? row[0];
      this.#pitch[view] = ranged(this.#cvars.get(cameraViewCVar("Pitch", view)), -CAMERA_CVAR_PITCH_MAX, CAMERA_CVAR_PITCH_MAX) ?? row[1];
      this.#yaw[view] = ranged(this.#cvars.get(cameraViewCVar("Yaw", view)), 0, CAMERA_CVAR_YAW_MAX) ?? row[2];
    }
  }

  /** "%f", as 0x5fe440 formats it; refused outside the validator's range. */
  #writeCVar(name: string, value: number, low: number, high: number): void {
    if (!(value >= low && value <= high)) return;
    this.#cvars.set(name, value.toFixed(6));
  }

  #readRecord(): Map<string, string> {
    const cvars = new Map<string, string>();
    let text: string | null = null;
    try {
      text = this.#key === undefined ? null : this.#storage?.getItem(this.#key) ?? null;
    } catch {
      text = null;
    }
    if (!text) return cvars;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return cvars;
    }
    const stored = (parsed as { cvars?: unknown } | null)?.cvars;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return cvars;
    for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof value === "string" && value.length <= 64) cvars.set(name, value);
    }
    return cvars;
  }

  #persist(): void {
    if (this.#key === undefined || !this.#storage) return;
    try {
      this.#storage.setItem(this.#key, JSON.stringify({ cvars: Object.fromEntries(this.#cvars) }));
    } catch {
      // A blocked store keeps the views for the session, as a refused write would in the client.
    }
  }
}

/** The page's one camera's views: Loop.ts runs the frame, the keys and the stock UI's Lua switch them. */
export const cameraViews = new CameraViews();