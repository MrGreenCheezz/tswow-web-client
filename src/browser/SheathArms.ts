// 6.08 (12.10): an arm playing Sheath or HipSheath on its own, as `CM2Model::SetBoneSequence` plays it.
//
// 0x00735820 → 0x00832ab0(keyBone 3 or 2, 89/90, variation −1, time 0, speed 1.0f, 1, 1): the key
// bone — ShoulderR, ShoulderL — and every bone below it with no sequence of its own play that clip
// instead of the model's; the rest of the body keeps what it plays. A finger with a sequence of its
// own (HandsClosed, `HandsClosed.ts`) keeps it. On the playable rigs the shoulder's subtree holds the
// arm, the hand attachment's bone and all five fingers, and none of the sheath points 26–33 (the 6.08
// probe: HumanMale, both night elves, TaurenMale and GnomeMale), and the two clips key 16–21 of its
// bones; a bone the clip does not key stands at its rest, as an M2 track with no keys evaluates.
//
// The arm is posed on Three's bone objects after the mixer and the global channels, entering and
// leaving over the clip's own blend window (6th argument 1 to 0x00832ab0, where HandsClosed passes 0).
// Before each such step the arm's bones go back to their rest and every pose path is told to read
// them again (`RigSkeleton.reposeBones`): the mixer skips a write whose value it believes unchanged,
// and a bone no running clip keys is never written by it, so without this the arm would keep last
// step's pose under this step's blend. The renderer keeps the rig off the flat pose while an arm
// plays (as it does for a strafe turn): one unit, the active player, for about a second.

import * as THREE from "three";
import type { SkinnedInstance, SkinnedTemplate } from "./AnimatedModel.js";
import type { SheathArm } from "./SheathCeremony.js";

const subtreeCache = new WeakMap<Int16Array, Map<number, readonly number[]>>();

/** The bones a key bone's sequence poses: the bone the table names and every bone below it, ascending. */
export function keyBoneSubtree(parents: Int16Array, keyBones: Int16Array | undefined, keyBone: number): readonly number[] {
  const root = keyBones?.[keyBone];
  if (root === undefined || root < 0 || root >= parents.length) return [];
  let byKey = subtreeCache.get(parents);
  if (!byKey) {
    byKey = new Map();
    subtreeCache.set(parents, byKey);
  }
  const cached = byKey.get(root);
  if (cached) return cached;
  const bones: number[] = [];
  for (let bone = 0; bone < parents.length; bone++) {
    // Bounded walk, so a malformed cycle cannot spin.
    let at = bone;
    for (let steps = 0; at >= 0 && at < parents.length && steps <= parents.length; steps++) {
      if (at === root) {
        bones.push(bone);
        break;
      }
      at = parents[at]!;
    }
  }
  byKey.set(root, bones);
  return bones;
}

/** How much of the arm's clip is on the arm at `now`: in over the blend window, out over the same. */
export function sheathArmWeight(arm: Pick<SheathArm, "startAt" | "duration" | "blend">, now: number): number {
  if (arm.duration <= 0) return 0;
  const time = (now - arm.startAt) / 1000;
  if (time < 0 || time >= arm.duration) return 0;
  if (arm.blend <= 0) return 1;
  return Math.max(0, Math.min(1, time / arm.blend, (arm.duration - time) / arm.blend));
}

/** Whether the arm's clip is on the arm at `now`. */
export function sheathArmPlaying(arm: Pick<SheathArm, "startAt" | "duration">, now: number): boolean {
  return arm.duration > 0 && now >= arm.startAt && now < arm.startAt + arm.duration * 1000;
}

/** Puts `bones` back at their rest: no translation off the pivot, no turn, unit scale. */
export function restArmBones(instance: SkinnedInstance, template: Pick<SkinnedTemplate, "parents" | "pivots">,
  bones: readonly number[]): void {
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
}

/**
 * Before the step that poses an arm, and once after the last: its bones at rest and every bound
 * property written again by the next `mixer.update` (see the file comment).
 */
export function resetArmBones(instance: SkinnedInstance, template: Pick<SkinnedTemplate, "parents" | "pivots">,
  bones: readonly number[]): void {
  if (bones.length === 0) return;
  restArmBones(instance, template, bones);
  instance.skeleton.reposeBones(instance.mixer);
}

interface BoneTracks {
  position: THREE.Interpolant | undefined;
  quaternion: THREE.Interpolant | undefined;
  scale: THREE.Interpolant | undefined;
}

const tracksCache = new WeakMap<THREE.AnimationClip, Map<number, BoneTracks>>();

function clipTracks(clip: THREE.AnimationClip): Map<number, BoneTracks> {
  let byBone = tracksCache.get(clip);
  if (byBone) return byBone;
  byBone = new Map();
  for (const track of clip.tracks) {
    const match = /^bone(\d+)\.(position|quaternion|scale)$/.exec(track.name);
    if (!match) continue;
    const bone = Number(match[1]);
    let entry = byBone.get(bone);
    if (!entry) {
      entry = { position: undefined, quaternion: undefined, scale: undefined };
      byBone.set(bone, entry);
    }
    // `createInterpolant` is the track's own factory for its interpolation mode (Three sets it in
    // `setInterpolation`; the typings leave it out): a quaternion track slerps, a vector track lerps.
    entry[match[2] as keyof BoneTracks] = (track as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
  }
  tracksCache.set(clip, byBone);
  return byBone;
}

const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/**
 * Poses `bones` with `clip` at `time` seconds, over what the bone objects hold, by `weight`. `skip`
 * names bones with a sequence of their own (a closed hand's fingers): they are left alone.
 */
export function poseSheathArm(instance: SkinnedInstance, template: Pick<SkinnedTemplate, "parents" | "pivots">,
  clip: THREE.AnimationClip, bones: readonly number[], time: number, weight: number,
  skip?: readonly number[]): void {
  if (weight <= 0 || bones.length === 0) return;
  const tracks = clipTracks(clip);
  const at = Math.max(0, Math.min(clip.duration, time));
  const objects = instance.skeleton.bones;
  for (const index of bones) {
    if (skip !== undefined && skip.includes(index)) continue;
    const bone = objects[index];
    if (!bone) continue;
    const own = tracks.get(index);
    const parent = template.parents[index]!;
    if (own?.position) _position.fromArray(own.position.evaluate(at) as Float32Array);
    else {
      _position.set(
        template.pivots[index * 3]! - (parent >= 0 ? template.pivots[parent * 3]! : 0),
        template.pivots[index * 3 + 1]! - (parent >= 0 ? template.pivots[parent * 3 + 1]! : 0),
        template.pivots[index * 3 + 2]! - (parent >= 0 ? template.pivots[parent * 3 + 2]! : 0));
    }
    if (own?.quaternion) _quaternion.fromArray(own.quaternion.evaluate(at) as Float32Array).normalize();
    else _quaternion.set(0, 0, 0, 1);
    if (own?.scale) _scale.fromArray(own.scale.evaluate(at) as Float32Array);
    else _scale.set(1, 1, 1);
    if (weight >= 1) {
      bone.position.copy(_position);
      bone.quaternion.copy(_quaternion);
      bone.scale.copy(_scale);
    } else {
      bone.position.lerp(_position, weight);
      bone.quaternion.slerp(_quaternion, weight);
      bone.scale.lerp(_scale, weight);
    }
  }
}
