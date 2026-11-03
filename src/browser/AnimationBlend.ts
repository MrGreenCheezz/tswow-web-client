// 03.11 (6.33): how Wow.exe 3.3.5a 12340 mixes two clips, measured off its own bone palette, frame by frame, to 0.1° on
// HumanMale (docs/implementation/anim-blends.ru.md):
//
// * the weight of the incoming clip is 3x² − 2x³ of x = time / the incoming clip's blend time, not a straight line;
// * the outgoing clip's clock keeps running under the blend, and the incoming one starts from zero;
// * a switch in the first half of a blend leaves the outgoing clip where it is: the new clip takes the incoming one's
//   place and the blend's clock goes on; in the second half the clip coming in becomes the outgoing one, whole, and a new
//   blend starts from zero. Either way the third clip is gone at once, which is a small pop in the original too.
//
// * a wound is no blend into anything: it lies over whatever plays, at once at 3/4 of its strength, and the same curve takes
//   it down to nothing over the clip's whole length (0x00826dd0 with `_DAT_009e9ee4`, measured to 0.2° on the upper body of a
//   unit running and the whole of one standing).
//
// Three's fades are straight lines from a fixed weight, and a third clip stays in the mixer until its own fade ends.

import * as THREE from "three";

/** The curve of the blend: 3x² − 2x³, x in 0..1. */
export function blendWeight(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

interface ControlInterpolant {
  parameterPositions: Float32Array;
  sampleValues: Float32Array;
  resultBuffer: Float32Array;
  interpolate_: (i1: number, t0: number, t: number, t1: number) => Float32Array;
}

/** A two-key weight fade, along the curve instead of the line. */
function interpolateAlongCurve(this: ControlInterpolant, i1: number, t0: number, t: number, t1: number): Float32Array {
  const result = this.resultBuffer;
  const values = this.sampleValues;
  const weight = blendWeight((t - t0) / (t1 - t0));
  result[0] = values[i1 - 1]! * (1 - weight) + values[i1]! * weight;
  return result;
}

interface MixerInternals {
  _lendControlInterpolant(): ControlInterpolant;
}

/**
 * Every weight fade in every mixer follows the curve. The mixer lends each action one control interpolant for its fades, and
 * this is the one place all of them come from, the mixer, the fast pose and the pose engine alike (`_updateWeight`).
 * The other thing a control interpolant does is a warped time scale, which no caller here asks for (`animationBlend`).
 */
const mixer = THREE.AnimationMixer.prototype as unknown as MixerInternals;
const lend = mixer._lendControlInterpolant;
mixer._lendControlInterpolant = function curvedControlInterpolant(this: MixerInternals): ControlInterpolant {
  const interpolant = lend.call(this);
  interpolant.interpolate_ = interpolateAlongCurve;
  return interpolant;
};

/** How strong a wound starts. */
export const FLINCH_WEIGHT = 0.75;

/**
 * The flinch's share of the pose, as a mixer weight. The mixer averages by weight, and what it is averaged against is a clip
 * at weight 1, so a share s of the pose is s / (1 − s) of that.
 */
function interpolateFlinch(this: ControlInterpolant, _i1: number, t0: number, t: number, t1: number): Float32Array {
  const share = FLINCH_WEIGHT * (1 - blendWeight((t - t0) / (t1 - t0)));
  const result = this.resultBuffer;
  result[0] = share / (1 - share);
  return result;
}

/** Lays a restarted action over the pose as a wound: gone by the end of `duration`, and disabled by the mixer then. */
export function flinchWith(action: THREE.AnimationAction, duration: number): void {
  action.fadeOut(duration);
  const fade = (action as unknown as ActionInternals)._weightInterpolant;
  if (fade) fade.interpolate_ = interpolateFlinch;
}

interface ActionInternals {
  _weightInterpolant: ControlInterpolant | null;
}

/** The blend an action is coming in on. Only ever read for an action that is the one on show. */
interface ActionBlend {
  from: THREE.AnimationAction;
  start: number;
  duration: number;
}

const blends = new WeakMap<THREE.AnimationAction, ActionBlend>();

/**
 * Hands over from `previous` to `next`, which the caller has already restarted at weight 1.
 *
 * `time` is the mixer's own clock (`mixer.time`), in seconds.
 */
export function blendInto(next: THREE.AnimationAction, previous: THREE.AnimationAction, duration: number, time: number): void {
  const blend = blends.get(previous);
  if (blend && time < blend.start + blend.duration) {
    if (time - blend.start < blend.duration / 2) {
      previous.stop();
      blends.delete(previous);
      // Back to the clip it was leaving: one action cannot be that clip twice, and it was restarted to come in anew. Its two
      // clocks would be two poses of one clip, so the difference is small.
      if (next === blend.from) return;
      next.fadeIn(duration);
      const fade = (next as unknown as ActionInternals)._weightInterpolant;
      if (fade) {
        fade.parameterPositions[0] = blend.start;
        fade.parameterPositions[1] = blend.start + blend.duration;
      }
      blends.set(next, blend);
      return;
    }
    if (next !== blend.from) blend.from.stop();
    blends.delete(previous);
  }
  previous.fadeOut(duration);
  next.fadeIn(duration);
  blends.set(next, { from: previous, start: time, duration });
}
