// 6.24 (12.10): a hand that holds an item closes round it, as Wow.exe 3.3.5a 12340 closes it.
//
// Owner: «модели персонажей не держат оружие, рука расслабленная». Wow.exe hangs every hand item
// through one routine, 0x004eaa70 (reached from the hang 0x004eacd0: character select 0x004e4207, a
// corpse 0x00705e7b, a creature's virtual items 0x00725177, a player's slots 0x0072de7b/0x0072b8e6).
// Once the item model is on its point (0x00831630), point 1 calls 0x004e7700(model, 0) and point 2
// 0x004e7700(model, 1): for key bones 8–12 (right index, middle, pinky, ring, thumb) or 13–17 (left),
// `CM2Model::SetBoneSequence(keyBone, 0xf HandsClosed, variation −1, time 0, speed 1.0f, 0, 1)`
// (0x00832ab0). Taking an item off a point (0x004e79a0) clears 8–12 for point 1 and 13–17 for points
// 0 and 2 (0x00832840: the bone back on the model's own sequence); moving one between points as a
// weapon is drawn or sheathed (0x007310a0) closes the hand it lands in and opens the one it left
// (0x004e7750). So a shield, on point 0, closes nothing, and a stowed weapon's hand is open.
// A duplicated model (0x005975e0) closes the hands its points 1 and 2 hold, by the same call.
//
// A bone given a sequence of its own plays it for itself and every bone below it that has none — the
// main animation is the same call on bone 0 (0x005975e0: `SetBoneSequence(−1 → bone 0, Stand)`) —
// so a finger's second joint closes with it. Which bones the ids name is the M2 key bone table
// (`WvmModel.keyBones`, `visual-v24`): on the playable rigs the fingers are not the descendants of
// the bone the hand attachment hangs from (NightElfMale: point 1 on bone 131 under 119, fingers
// under 48), so nothing in the rig's shape can stand in for it.
//
// HandsClosed holds one key per finger track on 35 of the 36 clean-client rigs that name finger key
// bones; BloodElfFemale carries a second key 33 ms later on six tracks, which Wow.exe would loop
// through at speed 1. The first key is the pose taken here (time 0, where Wow.exe starts it). A
// property the sequence does not key is the bone's rest, as an M2 track with no keys evaluates.
//
// The pose rides the path global sequences already take — the clips' last word, on Three's bone
// objects, the flat pose and the pose worker alike (`applyGlobalSequenceBones`,
// `writeGlobalSequenceLocals`, `SharedPose.globalSequences`): one constant channel per finger bone and
// property after the template's own, in a source cached per template, hand mask and clip.
//
// Per-frame cost: one cached lookup per posed unit; the channels are built once per rig and hand.

import type * as THREE from "three";
import type { GlobalChannelSource, SkinnedInstance, SkinnedTemplate } from "./AnimatedModel.js";
import { ATTACHMENT_HAND_LEFT, ATTACHMENT_HAND_RIGHT, type WvmSkeletonGlobalChannel } from "./Wvm.js";

/** AnimationData 15, HandsClosed: Wow.exe passes the literal 0xf (0x004e7700). */
export const HANDS_CLOSED_ANIMATION = 15;
/** Bits of a hand mask. */
export const HAND_RIGHT = 1;
export const HAND_LEFT = 2;
/** Key bone ids 0x004e7700 walks: 8–12 for the right hand, 13–17 for the left. */
const RIGHT_FINGER_KEYS = [8, 12] as const;
const LEFT_FINGER_KEYS = [13, 17] as const;

/** The hand an attachment point closes: point 1 the right, point 2 the left, anything else none. */
export function handOfPoint(point: unknown): number {
  return point === ATTACHMENT_HAND_RIGHT ? HAND_RIGHT : point === ATTACHMENT_HAND_LEFT ? HAND_LEFT : 0;
}

/** The hands closed by items hung on these points (0x004eaa70: points 1 and 2 only). */
export function handsClosedMask(points: Iterable<unknown>): number {
  let mask = 0;
  for (const point of points) mask |= handOfPoint(point);
  return mask;
}

/**
 * The bones a closed hand poses: the finger key bones of each hand in `mask`, and every bone below
 * one of them. Ascending; empty when the rig names none.
 */
export function closedHandBones(parents: Int16Array, keyBones: Int16Array | undefined, mask: number): number[] {
  if (!keyBones || mask === 0) return [];
  const closed = new Uint8Array(parents.length);
  for (const [hand, [first, last]] of [[HAND_RIGHT, RIGHT_FINGER_KEYS], [HAND_LEFT, LEFT_FINGER_KEYS]] as const) {
    if ((mask & hand) === 0) continue;
    for (let key = first; key <= last && key < keyBones.length; key++) {
      const bone = keyBones[key]!;
      if (bone >= 0 && bone < parents.length) closed[bone] = 1;
    }
  }
  const bones: number[] = [];
  for (let bone = 0; bone < parents.length; bone++) {
    // Walk up: a bone closes when it or an ancestor is a finger key bone. Bounded by the rig's size,
    // so a malformed cycle cannot spin.
    let at = bone;
    for (let steps = 0; at >= 0 && at < parents.length && steps <= parents.length; steps++) {
      if (closed[at] === 1) {
        bones.push(bone);
        break;
      }
      at = parents[at]!;
    }
  }
  return bones;
}

/** A closed-hand source, and the bones it poses (for the release). */
export interface ClosedHands {
  readonly source: GlobalChannelSource;
  readonly bones: readonly number[];
}

interface CachedHands {
  readonly clip: THREE.AnimationClip;
  readonly keyBones: Int16Array;
  readonly hands: ClosedHands | null;
}

const closedHandsCache = new WeakMap<SkinnedTemplate, Map<number, CachedHands>>();
/** One shared key time: the pose worker copies keyframe arrays once per array (`PoseEngine.keyframes`). */
const ONE_KEY = new Float32Array([0]);

/**
 * The global-channel source a unit holding items in the hands of `mask` is posed with, or undefined
 * when no hand closes: nothing held, no key bone table, no finger key bone, or the HandsClosed clip
 * not built yet (the caller asks for it — it travels in the animation sidecar).
 */
export function closedHandsFor(template: SkinnedTemplate, keyBones: Int16Array | undefined, mask: number): ClosedHands | undefined {
  if (mask === 0 || !keyBones || keyBones.length === 0) return undefined;
  const clip = template.clips.get(HANDS_CLOSED_ANIMATION);
  if (!clip) return undefined;
  let byMask = closedHandsCache.get(template);
  if (!byMask) {
    byMask = new Map();
    closedHandsCache.set(template, byMask);
  }
  const cached = byMask.get(mask);
  if (cached && cached.clip === clip && cached.keyBones === keyBones) return cached.hands ?? undefined;
  const bones = closedHandBones(template.parents, keyBones, mask);
  const hands = bones.length === 0 ? null : {
    source: {
      parents: template.parents,
      pivots: template.pivots,
      globalChannels: [...template.globalChannels, ...closedHandChannels(template, clip, bones)],
    },
    bones,
  };
  byMask.set(mask, { clip, keyBones, hands });
  return hands ?? undefined;
}

/**
 * One constant channel per bone and property: the clip's first key, or the rest the M2 gives an
 * unkeyed track (no translation off the pivot, no turn, unit scale). Translation is stored the way a
 * global channel carries it — off the rest pivot — because `sampleGlobalChannel` adds the pivot back,
 * where the clip's own position track already holds the sum (`buildClip`).
 */
export function closedHandChannels(
  template: Pick<SkinnedTemplate, "parents" | "pivots">, clip: THREE.AnimationClip, bones: readonly number[],
): WvmSkeletonGlobalChannel[] {
  const tracks = new Map<string, THREE.KeyframeTrack>();
  for (const track of clip.tracks) tracks.set(track.name, track);
  const channels: WvmSkeletonGlobalChannel[] = [];
  for (const bone of bones) {
    const parent = template.parents[bone]!;
    const position = tracks.get(`bone${bone}.position`)?.values;
    const offset = new Float32Array(3);
    if (position && position.length >= 3) {
      for (let axis = 0; axis < 3; axis++) {
        const rest = template.pivots[bone * 3 + axis]! - (parent >= 0 ? template.pivots[parent * 3 + axis]! : 0);
        offset[axis] = position[axis]! - rest;
      }
    }
    const quaternion = tracks.get(`bone${bone}.quaternion`)?.values;
    const turn = quaternion && quaternion.length >= 4
      ? Float32Array.of(quaternion[0]!, quaternion[1]!, quaternion[2]!, quaternion[3]!)
      : Float32Array.of(0, 0, 0, 1);
    const scale = tracks.get(`bone${bone}.scale`)?.values;
    const size = scale && scale.length >= 3 ? Float32Array.of(scale[0]!, scale[1]!, scale[2]!) : Float32Array.of(1, 1, 1);
    channels.push(
      { bone, kind: 0, interpolation: 0, globalSequence: -1, times: ONE_KEY, values: offset },
      { bone, kind: 1, interpolation: 0, globalSequence: -1, times: ONE_KEY, values: turn },
      { bone, kind: 2, interpolation: 0, globalSequence: -1, times: ONE_KEY, values: size },
    );
  }
  return channels;
}

/**
 * Lets go of `bones`: the bone objects back to their rest (0x00832840 hands the bone back to the
 * model's own sequence) and every pose path told to read them again, so a property the clip does not
 * key comes back as the rest and one it does is written afresh rather than skipped as unchanged
 * (`RigSkeleton.reposeBones`).
 */
export function releaseClosedHands(
  instance: SkinnedInstance, template: Pick<SkinnedTemplate, "parents" | "pivots">, bones: readonly number[],
): void {
  if (bones.length === 0) return;
  const objects = instance.skeleton.bones;
  for (const index of bones) {
    const bone = objects[index];
    if (!bone) continue;
    const parent = template.parents[index]!;
    bone.position.set(
      template.pivots[index * 3]! - (parent >= 0 ? template.pivots[parent * 3]! : 0),
      template.pivots[index * 3 + 1]! - (parent >= 0 ? template.pivots[parent * 3 + 1]! : 0),
      template.pivots[index * 3 + 2]! - (parent >= 0 ? template.pivots[parent * 3 + 2]! : 0));
    bone.quaternion.set(0, 0, 0, 1);
    bone.scale.set(1, 1, 1);
  }
  instance.skeleton.reposeBones(instance.mixer);
}
