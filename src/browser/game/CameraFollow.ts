import {
  CAMERA_AXIS_PITCH, CAMERA_AXIS_YAW, cameraYawOffFlip, type CameraViewRig, type CameraViews,
} from "./CameraViews.js";
import { cameraSmoothCVar, cameraSmoothViewDataCVar } from "./CameraCVars.js";
import { MOVEMENT_FLAGS } from "../../world/MovementProtocol.js";

/**
 * 3.11 (13.10): the camera coming back behind the character — `cameraSmoothStyle` — as Wow.exe 3.3.5a (12340) does
 * it. Read-only notes: .runtime/re-2026-10-11/glue-1110/cv311-a…f.txt; 0x00602760 in
 * .runtime/re-2026-10-03/l1102gf3/r4.c, 0x005fa170/0x005fa450 in .runtime/re-2026-10-04/l8-movement/g1.c.
 *
 * Not a pull every frame: 0x00602760 runs when the input word ([0x00c24954]+4) changes — from 0x005fa170 when a
 * bit is set and 0x005fa450 when one is cleared — if a movement bit changed (0x13f0: forward 0x10, back 0x20,
 * strafes 0x40/0x80, turns 0x100/0x200, autorun 0x1000), a mouse command went down first or came up last, or the
 * right button and a turn key began or ceased to be held together. It starts at most one glide per axis, with the
 * camera's own glide (CameraViews.glideAxis — 0x00601190 pitch, 0x00601410 yaw) and then leaves the camera alone:
 * - The state is the highest of: Fear 0x40 (the subject on a server spline — not modelled), Turn 0x20 (a turn key, or
 *   the right button/Mouselook), Strafe 0x10 (a strafe key, or the right button with a turn key), Move 8 (forward,
 *   back, autorun, or both buttons), Track 4 (the 0x1e00000 tracking bits — not modelled), Stop 2 (the word was
 *   moving and is now idle, 0x005f9850) and Idle 1 (no movement bit at all).
 * - Gate 0x005fff40: not after a sticky release, and only in a view still at its defaults unless
 *   cameraCustomViewSmoothing (CameraViews.followAllowed).
 * - The style is cameraSmoothStyle (0 Never, 1 Smart, 2 Always, 3 Spline, 4 Smarter — the default). Its state row
 *   `cameraSmooth<style><state>Delay|Factor` (a negative is 0, 100 and over 99) is added to (delay) and multiplied
 *   into (factor) the row `cameraSmoothViewData<style><axis>Delay|Factor`, and each sum or product is held to 0…99.
 * - Pitch (0x005ffeb0): a unit subject, no freelook, cameraSmoothPitch on, neither swimming (0x200000) nor flying
 *   (0x2000000), and the pitch outside cameraPitchSmoothMin…Max (0°…30°, positive looking down). Then a factor of 0
 *   stops the pitch's glide (0x005feee0); otherwise it glides to the nearer bound. A pitch inside the band is left
 *   where it is — so the default 10° or this client's 23.75° is never pulled anywhere.
 * - Yaw (0x00602680): a unit subject, no freelook, cameraSmoothYaw on, and the yaw (without FlipCameraYaw's part)
 *   outside cameraYawSmoothMin…Max (0…0); then a factor of 0 stops its glide (0x005fef40), else it glides to the
 *   nearer bound — behind the character.
 * - A glide's time is |Δ| / (cameraPitchSmoothSpeed or cameraYawSmoothSpeed, degrees a second) × factor, its start
 *   now + delay; the axes it started then share the longest time held to cameraSmoothTimeMin/Max (0.1–2 s), along
 *   0.5·(1 − cos πt). Smarter's Move, Strafe and Turn rows are delay 0, factor 1; Idle and Stop are factor 0 — the
 *   glide in hand stops where it is when the character stops. Smart has a pitch factor of 0; Always glides idle too.
 * - The freelook edges come first in the same call (0x006047e0 on the first press, 0x00604850 on the last release:
 *   CameraViews.freelook), so a press never starts a glide and a release with the character still moving starts one.
 *
 * Was (5.14) a pull at cameraYawSmoothSpeed every frame while moving (style 1/2/4 read from the tooltips), the
 * pitch led to this client's −23.75° at a quarter of it. Nothing is allocated unless the word changed.
 */

/** The input word's bits (0x005fa170) this reads: the two mouse commands and the movement keys. */
export const CAMERA_INPUT_TURN_OR_ACTION = 0x1;
export const CAMERA_INPUT_CAMERA_OR_SELECT = 0x2;
export const CAMERA_INPUT_FORWARD = 0x10;
export const CAMERA_INPUT_BACKWARD = 0x20;
export const CAMERA_INPUT_STRAFE_LEFT = 0x40;
export const CAMERA_INPUT_STRAFE_RIGHT = 0x80;
export const CAMERA_INPUT_TURN_LEFT = 0x100;
export const CAMERA_INPUT_TURN_RIGHT = 0x200;
export const CAMERA_INPUT_AUTORUN = 0x1000;

const BUTTONS = CAMERA_INPUT_TURN_OR_ACTION | CAMERA_INPUT_CAMERA_OR_SELECT;
const MOVEMENT = 0x13f0;
const TURNS = CAMERA_INPUT_TURN_LEFT | CAMERA_INPUT_TURN_RIGHT;
const STRAFES = CAMERA_INPUT_STRAFE_LEFT | CAMERA_INPUT_STRAFE_RIGHT;
const RUNS = CAMERA_INPUT_FORWARD | CAMERA_INPUT_BACKWARD | CAMERA_INPUT_AUTORUN;
const DEG = Math.PI / 180;
const TABLE_CEILING = 100;

/** The follow states (0x00ad1c10), as bits of 0x00602760's mask. */
export const CAMERA_FOLLOW_IDLE = 0x1;
export const CAMERA_FOLLOW_STOP = 0x2;
export const CAMERA_FOLLOW_MOVE = 0x8;
export const CAMERA_FOLLOW_STRAFE = 0x10;
export const CAMERA_FOLLOW_TURN = 0x20;

/** What the follow asks of the subject and the settings when it runs. */
export interface CameraFollowHost {
  /** cameraSmoothStyle, 0–4. */
  readonly style: number;
  /** cameraYawSmoothSpeed and cameraPitchSmoothSpeed, degrees a second. */
  readonly yawSpeed: number;
  readonly pitchSpeed: number;
  /** The camera's subject: a unit (type 3 or 4) with its movement flags; anything else gets no follow. */
  readonly subject: { readonly typeId?: number | undefined; readonly movementFlags?: number | undefined } | undefined;
}

/** 0x005f9850: no movement bit — forward, back, autorun, strafe or turn, under the right button or not. */
export function cameraInputIdle(word: number): boolean {
  return (word & (RUNS | STRAFES | TURNS)) === 0;
}

/** The right button (or Mouselook) together with a turn key: 0x005fa170's third edge. */
function steeringTurn(word: number): boolean {
  return (word & CAMERA_INPUT_TURN_OR_ACTION) !== 0 && (word & TURNS) !== 0;
}

/** 0x00602760's state mask for a word (Track and Fear are not modelled). */
export function cameraFollowStates(word: number, stop: boolean): number {
  const right = (word & CAMERA_INPUT_TURN_OR_ACTION) !== 0;
  let states = 0;
  if ((word & TURNS) !== 0 || right) states |= CAMERA_FOLLOW_TURN;
  if ((word & STRAFES) !== 0 || (right && (word & TURNS) !== 0)) states |= CAMERA_FOLLOW_STRAFE;
  if ((word & RUNS) !== 0 || (word & BUTTONS) === BUTTONS) states |= CAMERA_FOLLOW_MOVE;
  if (stop) states |= CAMERA_FOLLOW_STOP;
  if (cameraInputIdle(word)) states |= CAMERA_FOLLOW_IDLE;
  return states;
}

/**
 * A table CVar as 0x00602760 takes it, and the view-data sum or product after it (0x00a1e368 low, 0x00a1e370 − 1
 * high): a negative is 0, 100 and over 99.
 */
function held99(value: number): number {
  if (!(value >= 0)) return 0;
  return value >= TABLE_CEILING ? TABLE_CEILING - 1 : value;
}

export class CameraFollow {
  #word = 0;

  /** The word last seen (tests). */
  get word(): number {
    return this.#word;
  }

  /** Whether `word` (or a release `latch`) is news; the caller builds its host only then. */
  pending(word: number, latch: boolean | undefined): boolean {
    return word !== this.#word || latch !== undefined;
  }

  /**
   * The input word of the moment. `release` is a last mouse command let go since the last call, with its sticky
   * argument — so a press and release inside one frame still ends the freelook as the client's would. `host`
   * undefined: the word is taken (and the freelook edges with it) but nothing glides — a view that is not the
   * player's to turn (ViewSubject.viewIsOut).
   */
  input(word: number, release: boolean | undefined, rig: CameraViewRig, now: number, views: CameraViews,
    host: CameraFollowHost | undefined): void {
    const before = this.#word;
    this.#word = word;
    if (before === word && release === undefined) return;
    const pressed = (before & BUTTONS) === 0 && (word & BUTTONS) !== 0;
    const released = (before & BUTTONS) !== 0 && (word & BUTTONS) === 0;
    // 0x005fa170 / 0x005fa450: the freelook edges before the follow. A press and its release inside one frame are the
    // release alone: both stop the same glides.
    if (pressed) views.freelook(true, false);
    if (released || (release !== undefined && (word & BUTTONS) === 0)) views.freelook(false, release === true);
    const triggered = ((before ^ word) & MOVEMENT) !== 0
      || ((before ^ word) & CAMERA_INPUT_CAMERA_OR_SELECT) !== 0
      || ((before ^ word) & CAMERA_INPUT_TURN_OR_ACTION) !== 0
      || steeringTurn(before) !== steeringTurn(word)
      || release !== undefined;
    if (!triggered || host === undefined) return;
    const stop = !cameraInputIdle(before) && cameraInputIdle(word);
    this.#follow(cameraFollowStates(word, stop), rig, now, views, host);
  }

  /** 0x00602760. */
  #follow(states: number, rig: CameraViewRig, now: number, views: CameraViews, host: CameraFollowHost): void {
    if (states === 0 || !views.followAllowed()) return;
    const style = Math.trunc(host.style);
    if (!(style >= 0 && style <= 4)) return;
    const state = 31 - Math.clz32(states);
    const stateDelay = held99(views.cvarNumber(cameraSmoothCVar(style, state, false)));
    const stateFactor = held99(views.cvarNumber(cameraSmoothCVar(style, state, true)));
    const subject = host.subject;
    const unit = subject !== undefined && (subject.typeId === 3 || subject.typeId === 4);
    const free = unit && !views.freelooking;
    let shared = 0;
    let pitchStarted = false;
    let yawStarted = false;
    // 0x005ffeb0: the pitch, in Wow.exe's sense (positive looking down).
    const pitch = -rig.pitch;
    const pitchMin = views.cvarNumber("cameraPitchSmoothMin") * DEG;
    const pitchMax = views.cvarNumber("cameraPitchSmoothMax") * DEG;
    const flags = subject?.movementFlags ?? 0;
    if (free && views.cvarNumber("cameraSmoothPitch") !== 0
      && (flags & (MOVEMENT_FLAGS.swimming | MOVEMENT_FLAGS.flying)) === 0 && (pitch < pitchMin || pitchMax < pitch)) {
      const delay = held99(views.cvarNumber(cameraSmoothViewDataCVar(style, 1, false)) + stateDelay);
      const factor = held99(views.cvarNumber(cameraSmoothViewDataCVar(style, 1, true)) * stateFactor);
      if (factor === 0) views.stopAxis(CAMERA_AXIS_PITCH);
      else {
        const target = pitch < pitchMin ? pitchMin : pitchMax;
        const seconds = views.glideAxis(CAMERA_AXIS_PITCH, -target, delay, factor, host.pitchSpeed * DEG, now, rig);
        if (seconds >= 0) {
          pitchStarted = true;
          shared = seconds;
        }
      }
    }
    // 0x00602680: the yaw behind the character (camera+0x11c, without the flip).
    const yaw = cameraYawOffFlip(rig);
    const yawMin = views.cvarNumber("cameraYawSmoothMin") * DEG;
    const yawMax = views.cvarNumber("cameraYawSmoothMax") * DEG;
    if (free && views.cvarNumber("cameraSmoothYaw") !== 0 && (yaw < yawMin || yawMax < yaw)) {
      const delay = held99(views.cvarNumber(cameraSmoothViewDataCVar(style, 2, false)) + stateDelay);
      const factor = held99(views.cvarNumber(cameraSmoothViewDataCVar(style, 2, true)) * stateFactor);
      if (factor === 0) views.stopAxis(CAMERA_AXIS_YAW);
      else {
        // The view's own yaw, then the bound the yaw is past (0x00602760 with camera+0xac < 1).
        let target = views.viewYaw(views.current);
        if (yaw < yawMin) target = yawMin;
        if (yawMax < yaw) target = yawMax;
        const seconds = views.glideAxis(CAMERA_AXIS_YAW, target, delay, factor, host.yawSpeed * DEG, now, rig);
        if (seconds >= 0) {
          yawStarted = true;
          if (shared <= seconds) shared = seconds;
        }
      }
    }
    const held = Math.min(views.cvarNumber("cameraSmoothTimeMax"), Math.max(views.cvarNumber("cameraSmoothTimeMin"), shared));
    if (yawStarted) views.setAxisSeconds(CAMERA_AXIS_YAW, held);
    if (pitchStarted) views.setAxisSeconds(CAMERA_AXIS_PITCH, held);
  }
}

/** The page's one camera's follow: Controls.advanceCameraAutoFollow feeds it the input word once a frame. */
export const cameraFollow = new CameraFollow();
