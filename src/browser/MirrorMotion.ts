/**
 * 22.10 ARC-2 S7: `WorldState.updateMotions` run by the render worker on its mirror world (FrameInputDecoder.ts),
 * for the frames it draws without a fresh input from a stalled page.
 *
 * The same steps on the same data, in the same order: passengers carried onto their carrier's pose (a lift's car,
 * LiftClock.ts `liftCarrierPose`, or the carrier's mirror position), then each spline sampled at `now` — its latch,
 * its carrier's frame, its arrival (seat, target facing, motion dropped, creature flags scrubbed). The page's own parts
 * are not here: held packets, the ship poses (`poseProvider`: RenderInputSmoothing.ts moves ships by their last
 * velocity before this runs), glides and drifts (not carried by the codec), the spline-finished callback. Every
 * object is recorded in `restore` before it is written, so the exact input can be put back.
 */

import { composePassengerPosition, normalizeOrientation } from "../world/TransportMath.js";
import { sampleSpline, type SplineFacing, type SplineSample } from "../world/SplineModel.js";
import {
  SPLINE_SCRUB_MASK, composeSample, fieldAnimationTier, trackFromMotion,
  type WorldObjectState, type WorldPosition,
} from "../world/WorldState.js";
import type { RenderWorld } from "./FrameInput.js";
import type { MirrorRestore } from "./MirrorRestore.js";

/** `WorldState.carrierPoseProvider`'s shape: a carrier's pose this frame, or undefined for its position. */
export type CarrierPose = (carrier: WorldObjectState, now: number, out: WorldPosition) => WorldPosition | undefined;

const TYPEID_UNIT = 3;
const SAMPLE: SplineSample = { x: 0, y: 0, z: 0, orientation: 0 };
const CARRIER_SCRATCH: WorldPosition = { x: 0, y: 0, z: 0, orientation: 0 };

function carrierPoseOf(carrier: WorldObjectState | undefined, now: number, provider: CarrierPose | undefined):
  WorldPosition | undefined {
  if (carrier === undefined) return undefined;
  return provider?.(carrier, now, CARRIER_SCRATCH) ?? carrier.position;
}

/** Where a target facing points, as `WorldState.#facingFrom` answers it. */
function facingTo(world: RenderWorld, position: WorldPosition, facing: SplineFacing): number {
  if (facing.kind === "angle") return facing.angle;
  const spot = facing.kind === "spot" ? facing : world.objects.get(facing.guid)?.position;
  if (!spot || (spot.x === position.x && spot.y === position.y)) return position.orientation;
  return Math.atan2(spot.y - position.y, spot.x - position.x);
}

/** One `updateMotions(now)` over the mirror; returns how many objects it moved. */
export function advanceMirrorMotions(world: RenderWorld, now: number, carrierPose: CarrierPose | undefined,
  restore: MirrorRestore): number {
  let moved = 0;
  for (const object of world.objects.values()) {
    const position = object.position;
    const seat = object.transport;
    const motion = object.motion;
    const latch = object.splineTier;
    // A BYTES_1 tier byte that has moved on since the effect took over overrules it (page: for every object).
    const relatch = latch !== undefined && latch.tier !== undefined && fieldAnimationTier(object) !== latch.fieldTier;
    if (relatch) {
      restore.touch(object);
      latch.tier = undefined;
    }
    if (position === undefined || (seat === undefined && motion === undefined)) continue;
    restore.touch(object);
    moved++;
    // The passenger first (`#carryPassenger`).
    if (seat !== undefined) {
      const transport = carrierPoseOf(world.objects.get(seat.guid), now, carrierPose);
      if (transport !== undefined) {
        const placed = composePassengerPosition(transport, seat);
        position.x = placed.x;
        position.y = placed.y;
        position.z = placed.z;
        position.orientation = placed.orientation;
      }
    }
    if (motion === undefined) continue;
    const track = motion.track ??= trackFromMotion(motion);
    const elapsed = now - motion.startedAt;
    const animation = track.desc.animation;
    if (animation !== undefined && elapsed >= animation.startMs && object.splineTier?.track !== track) {
      object.splineTier = { tier: animation.tier, fieldTier: fieldAnimationTier(object), track };
    }
    const carrier = motion.carrier === undefined ? undefined
      : carrierPoseOf(world.objects.get(motion.carrier), now, carrierPose);
    if (motion.carrier !== undefined && carrier === undefined) continue;
    const done = sampleSpline(track, elapsed, carrier === undefined ? position.orientation
      : normalizeOrientation(position.orientation - carrier.orientation), SAMPLE);
    if (carrier !== undefined) {
      if (done && seat !== undefined && seat.guid === motion.carrier) {
        seat.x = SAMPLE.x;
        seat.y = SAMPLE.y;
        seat.z = SAMPLE.z;
        seat.orientation = normalizeOrientation(SAMPLE.orientation);
      }
      composeSample(carrier, SAMPLE);
    }
    position.x = SAMPLE.x;
    position.y = SAMPLE.y;
    position.z = SAMPLE.z;
    position.orientation = SAMPLE.orientation;
    if (!done) continue;
    const facing = track.desc.facing;
    if (facing?.kind === "target") {
      position.orientation = facingTo(world, position, facing);
      if (carrier !== undefined && seat !== undefined && seat.guid === motion.carrier) {
        seat.orientation = normalizeOrientation(position.orientation - carrier.orientation);
      }
    }
    object.motion = undefined;
    if (object.typeId === TYPEID_UNIT) object.movementFlags &= ~SPLINE_SCRUB_MASK;
  }
  return moved;
}
