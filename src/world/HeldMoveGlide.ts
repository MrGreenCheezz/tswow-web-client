import { advanceDrift, driftPitch, type DriftSample, type GroundProbe } from "./MovementExtrapolation.js";
import { GLIDE_FACING, existingMoverGlide, moverGlide, type GlidePose, type HeldMove } from "./MovementSchedule.js";
import type { MoveInput, WorldObjectState } from "./WorldState.js";

/**
 * 5.04: WorldState's side of Wow.exe's glide toward the first held packet (MovementSchedule.ts `MoveGlide`,
 * 0x006EA6A0 / 0x006EA7E0). The glide rides the extrapolation (`Drift`): Wow.exe blends the engine's closed-form
 * place for the step (packet base + travel, 0x006EAC40) with the line to the held packet, and the drift is that
 * place here. Only a unit off transports glides — the drift itself runs only there, and 0x006EA6A0 wants the held
 * packet on the mover's transport (none on both sides). A unit's pitch glides in `MoveGlide` but is not drawn by
 * this client, so only the position and the facing are written.
 *
 * This client's frame bookkeeping, per unit: the step starts where the last one ended (`stepFrom`; Wow.exe's step
 * starts at the frame's start), and the facing the unit "has" before the step is the drawn one turned by what the
 * extrapolation turned since (`engineOrientation`) — Wow.exe turns the glide from the mover's facing in place.
 */

interface GlideFrame {
  stepFrom: number;
  engineOrientation: number;
}

const FRAMES = new WeakMap<object, GlideFrame>();
const FROM: GlidePose = { x: 0, y: 0, z: 0, orientation: 0, pitch: 0 };
const HEAD: GlidePose = { x: 0, y: 0, z: 0, orientation: 0, pitch: 0 };
const POSE: GlidePose = { x: 0, y: 0, z: 0, orientation: 0, pitch: 0 };
const SAMPLE: DriftSample = { x: 0, y: 0, z: 0, orientation: 0 };

/**
 * 0x006EA6A0 at `now` toward `head`, the unit's first held packet (undefined: nothing held — no glide). Called when a
 * packet is held into an empty queue (0x006EC950) and after each held packet is applied (0x006EF860).
 */
export function setupHeldGlide(
  object: WorldObjectState, head: HeldMove<MoveInput> | undefined, now: number, ground: GroundProbe | undefined,
): void {
  const position = object.position;
  if (head === undefined || !position || object.transport !== undefined || (head.movement.transport?.guid ?? 0n) !== 0n) {
    existingMoverGlide(object)?.clear();
    return;
  }
  const drift = object.drift;
  if (drift !== undefined) {
    advanceDrift(drift, now, SAMPLE, ground);
    FROM.x = SAMPLE.x;
    FROM.y = SAMPLE.y;
    FROM.z = SAMPLE.z;
    FROM.orientation = SAMPLE.orientation;
    FROM.pitch = drift.pitchTurn !== 0 ? driftPitch(drift, now) : object.pitch ?? 0;
  } else {
    FROM.x = position.x;
    FROM.y = position.y;
    FROM.z = position.z;
    FROM.orientation = position.orientation;
    FROM.pitch = object.pitch ?? 0;
  }
  const target = head.movement.position;
  HEAD.x = target.x;
  HEAD.y = target.y;
  HEAD.z = target.z;
  HEAD.orientation = target.orientation;
  HEAD.pitch = head.movement.pitch ?? 0;
  if (moverGlide(object).setup(now, FROM, object.movementFlags, HEAD, head.at) === 0) return;
  let frame = FRAMES.get(object);
  if (frame === undefined) FRAMES.set(object, frame = { stepFrom: now, engineOrientation: FROM.orientation });
  frame.stepFrom = now;
  frame.engineOrientation = FROM.orientation;
}

/** Ends a unit's glide (a teleport, its queue dropped). */
export function clearHeldGlide(object: WorldObjectState): void {
  existingMoverGlide(object)?.clear();
}

/**
 * 0x006EA7E0 for this frame: `sample` holds the extrapolation's place for `now` and leaves glided; `object.position`
 * is still where the unit was drawn last frame (the speed test's start). No step of zero length (Wow.exe's engine
 * loop does not run for one).
 */
export function stepHeldGlide(object: WorldObjectState, now: number, sample: DriftSample): void {
  const glide = existingMoverGlide(object);
  if (glide === undefined || glide.bits === 0) return;
  const frame = FRAMES.get(object);
  const position = object.position;
  if (frame === undefined || !position) return;
  const stepMs = now - frame.stepFrom;
  if (!(stepMs > 0)) return;
  const engineOrientation = sample.orientation;
  POSE.x = sample.x;
  POSE.y = sample.y;
  POSE.z = sample.z;
  POSE.orientation = position.orientation + (engineOrientation - frame.engineOrientation);
  POSE.pitch = object.pitch ?? 0;
  const facing = glide.bits;
  glide.step(frame.stepFrom, stepMs, position, POSE);
  frame.stepFrom = now;
  frame.engineOrientation = engineOrientation;
  sample.x = POSE.x;
  sample.y = POSE.y;
  sample.z = POSE.z;
  // The facing is the glide's while its bit ran this step; otherwise the extrapolation's, as before.
  if ((facing & GLIDE_FACING) !== 0) sample.orientation = POSE.orientation;
}
