import { CAMERA_PITCH_LIMIT } from "./CameraRig.js";

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
 *   the per-character cameraSavedDistance/Pitch (0x5ff3e0; default view 2's 5.55 yd and 10°). This
 *   client keeps its own starting camera — only the index is taken.
 *
 * Once a frame `frame` compares numbers and, while a glide runs, writes three; nothing is allocated.
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
/** The suffixes of the view CVars (0xad1b54). */
const SUFFIXES = ["", "A", "B", "C", "D", "E", "Com", "Barber Shop"] as const;
/** The validators' ranges: 0x5fd680 (50, 0x00a1e2fc), 0x5fd6d0 (±1.5533 rad in degrees), 0x5fd7b0 (360). */
const DISTANCE_MAX = 50;
const PITCH_MAX = 1.5533430576324463 * 57.295780181884766;
const YAW_MAX = 360;
/** Two numbers closer than this are the same (0x00a1e34c). */
const SAME = 1e-3;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

const AXIS_DISTANCE = 1;
const AXIS_PITCH = 2;
const AXIS_YAW = 4;

/** A view CVar's name: `cameraViewCVar("Distance", 1)` is `cameraDistanceA`. */
export function cameraViewCVar(axis: "Distance" | "Pitch" | "Yaw", view: number): string {
  return `camera${axis}${SUFFIXES[view] ?? ""}`;
}

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

function glideSeconds(delta: number, speed: number): number {
  return speed > 0 ? delta / speed : CAMERA_SMOOTH_TIME_MAX;
}

function pageStorage(): CameraViewStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
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
  #axes = 0;
  #start = 0;
  #ms = 0;
  #fromD = 0;
  #fromP = 0;
  #fromY = 0;
  #wroteD = 0;
  #wroteP = 0;
  #wroteY = 0;
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

  /** Whether a switch is still gliding the camera. */
  get gliding(): boolean {
    return this.#axes !== 0;
  }

  /** The glide's time, seconds (tests). */
  get glideSeconds(): number {
    return this.#ms / 1000;
  }

  /** A view as the camera keeps it: yards, degrees (positive pitch looks down), yaw 0–360 (tests, diagnostics). */
  view(index: number): { distance: number; pitch: number; yaw: number } {
    return { distance: this.#distance[index] ?? 0, pitch: this.#pitch[index] ?? 0, yaw: this.#yaw[index] ?? 0 };
  }

  /**
   * Once a frame, before the follow: a new world is a new camera (0x606b30 — the index from cameraView,
   * no flip, the account's views), then the glide (0x603d30). Nothing is allocated unless the world changed.
   */
  frame(rig: CameraViewRig, now: number, world: unknown, account: string | undefined): void {
    if (world !== this.#world) this.#newCamera(rig, world, account);
    if (this.#axes !== 0) this.#advance(rig, now);
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
    const distance = (this.#axes & AXIS_DISTANCE) !== 0 ? this.#aimD : rig.distance;
    const pitch = (this.#axes & AXIS_PITCH) !== 0 ? this.#aimP : rig.pitch;
    const yaw = (this.#axes & AXIS_YAW) !== 0 ? this.#aimY : cameraYawOffFlip(rig);
    const turn = ((yaw % TAU) + TAU) % TAU;
    this.#distance[index] = distance;
    this.#pitch[index] = (0 - pitch) / DEG;
    this.#yaw[index] = turn / DEG;
    // 0x5fe440: each CVar through its validator; one it refuses keeps the value it had.
    this.#writeCVar(cameraViewCVar("Distance", index), this.#distance[index]!, 0, DISTANCE_MAX);
    this.#writeCVar(cameraViewCVar("Pitch", index), this.#pitch[index]!, -PITCH_MAX, PITCH_MAX);
    this.#writeCVar(cameraViewCVar("Yaw", index), this.#yaw[index]!, 0, YAW_MAX);
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
    if ((this.#axes & AXIS_YAW) !== 0) this.#wroteY = rig.yaw;
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
    this.#axes = 0;
    this.#moved = true;
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
    this.#axes = 0;
    this.#moved = false;
    const ceiling = Number.isFinite(motion.ceiling) && motion.ceiling >= 0 ? motion.ceiling : DISTANCE_MAX;
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
    // The short way round (0x601410 unwraps the yaw against its target first).
    const fromY = toY + wrap(cameraYawOffFlip(rig) - toY);
    let axes = 0;
    let longest = 0;
    if (Math.abs(rig.distance - toD) >= SAME) {
      axes |= AXIS_DISTANCE;
      longest = Math.max(longest, glideSeconds(Math.abs(rig.distance - toD), CAMERA_DISTANCE_SMOOTH_SPEED));
    }
    if (Math.abs(rig.pitch - toP) >= SAME) {
      axes |= AXIS_PITCH;
      longest = Math.max(longest, glideSeconds(Math.abs(rig.pitch - toP), motion.pitchSpeed * DEG));
    }
    if (Math.abs(fromY - toY) >= SAME) {
      axes |= AXIS_YAW;
      longest = Math.max(longest, glideSeconds(Math.abs(fromY - toY), motion.yawSpeed * DEG));
    }
    if (axes === 0) return true;
    const seconds = Math.min(CAMERA_SMOOTH_TIME_MAX, Math.max(CAMERA_SMOOTH_TIME_MIN, longest));
    this.#start = now;
    this.#ms = seconds * 1000;
    this.#fromD = rig.distance;
    this.#fromP = rig.pitch;
    this.#fromY = fromY;
    this.#wroteD = rig.distance;
    this.#wroteP = rig.pitch;
    this.#wroteY = rig.yaw;
    this.#axes = axes;
    return true;
  }

  /** camera+0x98 bit 0x40: moved by hand since the last switch, or a new camera never switched. */
  #movedSince(rig: CameraViewRig, flip: number): boolean {
    if (this.#moved) return true;
    if (this.#axes !== 0) return false;
    return Math.abs(rig.distance - this.#aimD) >= SAME || Math.abs(rig.pitch - this.#aimP) >= SAME
      || Math.abs(wrap(rig.yaw - flip - this.#aimY)) >= SAME;
  }

  /** 0x603d30: one frame of the glide; an axis someone else moved since the last frame is theirs. */
  #advance(rig: CameraViewRig, now: number): void {
    let axes = this.#axes;
    if ((axes & AXIS_DISTANCE) !== 0 && rig.distance !== this.#wroteD) axes &= ~AXIS_DISTANCE;
    if ((axes & AXIS_PITCH) !== 0 && rig.pitch !== this.#wroteP) axes &= ~AXIS_PITCH;
    if ((axes & AXIS_YAW) !== 0 && rig.yaw !== this.#wroteY) axes &= ~AXIS_YAW;
    if (axes !== this.#axes) this.#moved = true;
    if (axes === 0) {
      this.#axes = 0;
      return;
    }
    const t = this.#ms > 0 ? (now - this.#start) / this.#ms : 1;
    const done = t >= 1;
    // 0x8ca080: from + (to − from)·0.5·(1 − cos πt).
    const k = done ? 1 : 0.5 * (1 - Math.cos(Math.PI * Math.max(0, t)));
    if ((axes & AXIS_DISTANCE) !== 0) {
      const value = done ? this.#aimD : this.#fromD + (this.#aimD - this.#fromD) * k;
      rig.distance = value;
      this.#wroteD = value;
    }
    if ((axes & AXIS_PITCH) !== 0) {
      const value = done ? this.#aimP : this.#fromP + (this.#aimP - this.#fromP) * k;
      rig.pitch = value;
      this.#wroteP = value;
    }
    if ((axes & AXIS_YAW) !== 0) {
      const own = done ? this.#aimY : this.#fromY + (this.#aimY - this.#fromY) * k;
      const value = wrap(own + (rig.flipYaw ?? 0));
      rig.yaw = value;
      this.#wroteY = value;
    }
    this.#axes = done ? 0 : axes;
  }

  #blendStyle(): number {
    const style = ranged(this.#cvars.get(CVAR_BLEND), -2147483648, 2147483647);
    return style === undefined ? CAMERA_VIEW_BLEND_SMOOTH : Math.trunc(style);
  }

  /** 0x5fe510: the table from the CVars, each through its validator, else the default. */
  #readTable(): void {
    for (let view = 0; view < CAMERA_VIEW_SLOTS; view += 1) {
      const row = CAMERA_VIEW_DEFAULTS[view]!;
      this.#distance[view] = ranged(this.#cvars.get(cameraViewCVar("Distance", view)), 0, DISTANCE_MAX) ?? row[0];
      this.#pitch[view] = ranged(this.#cvars.get(cameraViewCVar("Pitch", view)), -PITCH_MAX, PITCH_MAX) ?? row[1];
      this.#yaw[view] = ranged(this.#cvars.get(cameraViewCVar("Yaw", view)), 0, YAW_MAX) ?? row[2];
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
