import * as THREE from "three";
import type { EnvironmentModel, ModelClip, ModelSkeleton } from "../gateway/VMapModel.js";
import {
  BONE_ANY_BILLBOARD, BONE_CYLINDRICAL_BILLBOARD_X, BONE_CYLINDRICAL_BILLBOARD_Y,
  BONE_CYLINDRICAL_BILLBOARD_Z, BONE_SPHERICAL_BILLBOARD,
  type WvmSkeleton, type WvmSkeletonClip,
} from "./Wvm.js";
import { ANIMATION_FALLBACK, ANIMATION_IDS } from "../generated/animations.js";
import { MOVEMENT_FLAGS } from "../world/MovementProtocol.js";
import {
  UNIT_STAND_STATE_DEAD, UNIT_STAND_STATE_KNEEL, UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_SIT_CHAIR,
  UNIT_STAND_STATE_SIT_HIGH_CHAIR, UNIT_STAND_STATE_SIT_LOW_CHAIR, UNIT_STAND_STATE_SIT_MEDIUM_CHAIR,
  UNIT_STAND_STATE_SLEEP,
} from "../world/CharacterProgressProtocol.js";

/**
 * Poses, by the name AnimationData.dbc gives them.
 *
 * Every one of these used to be a number written here by hand, and seven of the eighteen named a
 * different pose than the constant did: 13 for sitting is Walkbackwards, 15 for the precast is
 * HandsClosed, 26 for the unarmed stance is Ready1H, 39 for looting is JumpEnd, 46 for talking is
 * AttackBow, 60 for falling is EmoteTalk and 69 for the swim idle is EmoteDance. Nothing ever
 * complained, because a model that lacks a sequence and a model asked for the wrong one both just
 * stand there.
 */
const {
  Stand, Walk, Run, Walkbackwards, ShuffleLeft, ShuffleRight, RunLeft, RunRight,
  JumpStart, Jump, JumpEnd, Fall, Swim, SwimIdle, SwimLeft, SwimRight, SwimBackwards,
  Fly, Hover, Mount, Death, Dead, SitGround, SitGroundDown, SitGroundUp, KneelLoop,
  SitChairLow, SitChairMed, SitChairHigh, Sleep, SleepDown,
  AttackUnarmed, Attack1H, Attack2H, AttackBow, FireBow, AttackRifle, AttackThrown, AttackOff,
  ReadyUnarmed, Ready1H, Ready2H, ReadyBow, ReadyRifle, ReadyThrown,
  SpellPrecast, SpellCast, SpellCastArea,
  ReadySpellDirected, ReadySpellOmni, SpellCastDirected, SpellCastOmni,
  ChannelCastDirected, ChannelCastOmni, Loot,
  FlySpellPrecast, FlySpellCast, FlySpellCastArea,
  FlyReadySpellDirected, FlyReadySpellOmni, FlySpellCastDirected, FlySpellCastOmni,
  FlyChannelCastDirected, FlyChannelCastOmni,
} = ANIMATION_IDS;

/**
 * M2 model space is Z-up and faces +X — measured from the full-body camera every client model
 * carries, which always stands on +X in front of the model. The scene keeps world +X as +X and
 * uses +Y for up, so the model root turns a quarter turn backwards about X.
 */
export const M2_TO_SCENE = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

export interface SkinnedTemplate {
  /** Shared across every unit using this model; positions stay in raw M2 space. */
  geometry: THREE.BufferGeometry;
  /** The clips that have been built so far. Grows when the held-back animations arrive. */
  clips: Map<number, THREE.AnimationClip>;
  /**
   * Every animation the model can play, whether or not its keyframes are here yet.
   *
   * The difference between this and `clips` is the request still to make. Without it there is no
   * way to tell a model that cannot swim from one whose swim clip has not been fetched, and the
   * renderer would either ask forever or never ask at all.
   */
  animations: Set<number>;
  /** Whether the held-back animations have been merged in, so the merge happens exactly once. */
  merged?: boolean;
  boneInverses: THREE.Matrix4[];
  parents: Int16Array;
  pivots: Float32Array;
  /**
   * Per-bone `M2CompBone.flags`, which until now were decoded and dropped.
   *
   * The doc comment on `buildSkinnedTemplateFrom` has claimed since slice U4 that "bone flags come
   * through too — three.js will not billboard a bone on its own", and they did not: the field was
   * read in `Wvm.ts`, four constants were named for it, and nothing in `src` ever looked at one.
   */
  flags: Uint16Array;
  /** Which bones are billboards, so the per-frame pass is empty on the models that have none. */
  billboards: number[];
  /** Model height in world units, for placing the name plate. */
  height: number;
  /** Lower-body bones kept under the locomotion action while a transient upper-body action plays. */
  locomotionBones?: Uint8Array;
  /** Per-clip upper-body variants used by locomotion-preserving transient actions. */
  overlayClips?: Map<number, THREE.AnimationClip>;
}

export interface SkinnedInstance {
  root: THREE.Object3D;
  mesh: THREE.SkinnedMesh;
  mixer: THREE.AnimationMixer;
  skeleton: THREE.Skeleton;
}

/** Instances own their mixer, bone objects and Skeleton, but borrow model geometry and materials. */
const disposedSkinnedInstances = new WeakSet<SkinnedInstance>();

/** Releases one playable rig exactly once without disposing its shared model build. */
export function disposeSkinnedInstance(instance: SkinnedInstance | undefined): void {
  if (!instance || disposedSkinnedInstances.has(instance)) return;
  disposedSkinnedInstances.add(instance);
  try {
    instance.mixer.stopAllAction();
  } finally {
    try {
      instance.mixer.uncacheRoot(instance.root);
    } finally {
      instance.skeleton.dispose();
    }
  }
}

/**
 * A template around geometry that has already been built for one appearance.
 *
 * Geometry and materials now depend on which geosets a character shows and which files fill its
 * texture slots, so they are built by ModelBuild and handed in; only the rig is shared with the
 * file. Bone flags come through too — three.js will not billboard a bone on its own.
 */
export function buildSkinnedTemplateFrom(
  geometry: THREE.BufferGeometry,
  skeleton: WvmSkeleton,
  height: number,
): SkinnedTemplate | undefined {
  const boneCount = skeleton.parents.length;
  if (boneCount === 0) return undefined;

  const boneInverses: THREE.Matrix4[] = [];
  for (let bone = 0; bone < boneCount; bone++) {
    // A bone's rest transform is the translation to its pivot, so the inverse undoes exactly that.
    boneInverses.push(new THREE.Matrix4().makeTranslation(
      -skeleton.pivots[bone * 3]!, -skeleton.pivots[bone * 3 + 1]!, -skeleton.pivots[bone * 3 + 2]!));
  }

  const clips = new Map<number, THREE.AnimationClip>();
  for (const clip of skeleton.clips) {
    const built = buildClip(clip, skeleton);
    if (built) clips.set(clip.animationId, built);
  }
  // A rig whose whole set was held back is still a rig: the clips are one request away, and
  // refusing it here would drop the model back to a stand-in capsule it never recovers from.
  if (clips.size === 0 && skeleton.animations.length === 0) return undefined;

  const locomotionBones = locomotionBoneMask(skeleton.parents, skeleton.pivots);
  const overlayClips = new Map<number, THREE.AnimationClip>();
  for (const [animation, clip] of clips) {
    overlayClips.set(animation, locomotionOverlayClip(clip, locomotionBones));
  }

  return {
    geometry, clips, animations: new Set(skeleton.animations),
    boneInverses, parents: skeleton.parents, pivots: skeleton.pivots,
    flags: skeleton.flags, billboards: billboardBones(skeleton.flags), height,
    locomotionBones, overlayClips,
  };
}

/** The bones that face the camera rather than whatever the animation put them at. */
export function billboardBones(flags: Uint16Array): number[] {
  const found: number[] = [];
  for (let bone = 0; bone < flags.length; bone++) {
    if ((flags[bone]! & BONE_ANY_BILLBOARD) !== 0) found.push(bone);
  }
  return found;
}

/**
 * Builds the animations that arrived after the model did, into the template every unit shares.
 *
 * Returns how many were added. The clips are keyframes against this rig and nothing else, so they
 * are built once here rather than per unit; the mixers pick them up on the next pose change.
 */
export function addSkinnedClips(template: SkinnedTemplate, clips: readonly WvmSkeletonClip[]): number {
  let added = 0;
  for (const clip of clips) {
    if (template.clips.has(clip.animationId)) continue;
    const built = buildClip(clip, template);
    if (!built) continue;
    template.clips.set(clip.animationId, built);
    template.animations.add(clip.animationId);
    if (template.locomotionBones) {
      (template.overlayClips ??= new Map()).set(
        clip.animationId, locomotionOverlayClip(built, template.locomotionBones));
    }
    added++;
  }
  return added;
}

/**
 * Whether a pose needs keyframes this model claims and has not downloaded yet.
 *
 * The decision `#requestAnimations` makes, out here where it can be driven without a renderer.
 * The review that put it here found the mounted pose never asking at all, and neither the emote
 * path nor `chooseAnimation` could show it: both are given a clip map with the pose already in it.
 *
 * Three answers, and the first one is the trap. A list that *resolves* against what is already
 * built asks for nothing — which is right for a wolf that has Run, and wrong for any list whose
 * tail is a pose the base set carries. `[Mount, Stand]` resolves to Stand the moment those 21 clips
 * are built, which is before anything can be mounted, so it could never reach the sidecar 91 is in;
 * a list is a preference order for drawing, and only its head is a request. `merged` is the second: one fetch per model, whatever came back.
 * The third is the model's own animation table, so a stand-in creature does not ask for a set it
 * does not have.
 */
export function needsSidecarAnimations(
  template: Pick<SkinnedTemplate, "clips" | "animations" | "merged">,
  wanted: readonly number[],
): boolean {
  if (resolveAnimation(template.clips, wanted) !== undefined) return false;
  if (template.merged) return false;
  return resolveAnimation(template.animations, wanted) !== undefined;
}

export function buildSkinnedTemplate(model: EnvironmentModel): SkinnedTemplate | undefined {
  const skeleton = model.skeleton;
  if (!skeleton || model.vertices.length === 0) return undefined;
  const vertexCount = model.vertices.length / 3;
  if (skeleton.skinIndices.length !== vertexCount * 4 || skeleton.skinWeights.length !== vertexCount * 4) return undefined;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(model.vertices, 3));
  if (model.uvs?.length === vertexCount * 2) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(model.uvs, 2));
  geometry.setAttribute("skinIndex", new THREE.Uint8BufferAttribute(skeleton.skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skeleton.skinWeights, 4));
  geometry.setIndex(model.indices);
  for (const [ordinal, group] of (model.groups ?? []).entries()) {
    geometry.addGroup(group.start, group.count, ordinal);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  const boneCount = skeleton.parents.length;
  const boneInverses: THREE.Matrix4[] = [];
  for (let bone = 0; bone < boneCount; bone++) {
    // A bone's rest transform is the translation to its pivot, so the inverse undoes exactly that.
    boneInverses.push(new THREE.Matrix4().makeTranslation(
      -skeleton.pivots[bone * 3]!, -skeleton.pivots[bone * 3 + 1]!, -skeleton.pivots[bone * 3 + 2]!));
  }

  const clips = new Map<number, THREE.AnimationClip>();
  for (const clip of skeleton.clips) {
    const built = buildClip(clip, skeleton);
    if (built) clips.set(clip.animationId, built);
  }
  if (clips.size === 0) {
    geometry.dispose();
    return undefined;
  }

  const locomotionBones = locomotionBoneMask(skeleton.parents, skeleton.pivots);
  const overlayClips = new Map<number, THREE.AnimationClip>();
  for (const [animation, clip] of clips) {
    overlayClips.set(animation, locomotionOverlayClip(clip, locomotionBones));
  }

  // In M2 space the model stands on z = 0, so its top is the height that matters.
  const height = geometry.boundingBox ? Math.max(0.4, geometry.boundingBox.max.z) : 2;
  // The older artifact has no bone flags at all, so nothing in it billboards.
  const flags = new Uint16Array(boneCount);
  return {
    geometry, clips, animations: new Set(clips.keys()),
    boneInverses, parents: skeleton.parents, pivots: skeleton.pivots,
    flags, billboards: [], height, locomotionBones, overlayClips,
  };
}

/**
 * Finds the lower-body branches that must remain owned by locomotion during an upper-body action.
 *
 * M2 does not publish bone names in WVM, but its rest pivots do preserve one useful invariant:
 * humanoid legs have a pronounced vertical drop and bilateral lateral separation below the hip.
 * Requiring both signals avoids treating zero-pivot finger/attachment helper bones as legs. The
 * first bilateral branches are retained, rather than their common pelvis subtree: the latter also
 * contains the spine and arms on several playable rigs. If a creature has no such branch, the
 * empty mask deliberately selects the full-body fallback.
 */
export function locomotionBoneMask(parents: Int16Array, pivots: Float32Array): Uint8Array {
  const count = parents.length;
  const mask = new Uint8Array(count);
  if (count === 0 || pivots.length < count * 3) return mask;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let bone = 0; bone < count; bone++) {
    const z = pivots[bone * 3 + 2]!;
    if (!Number.isFinite(z)) continue;
    maxZ = Math.max(maxZ, z);
  }
  // M2 character feet sit close to z=0; negative pivots are usually weapon/effect helper bones and
  // should not turn an entire root branch into the lower-body mask. Scale thresholds from the model
  // top rather than min/max so those helpers cannot distort the classification.
  if (!Number.isFinite(maxZ) || maxZ <= 0) return mask;
  const lowCutoff = maxZ * 0.72;
  // An arm/forearm can drop a little in the bind pose too; the leg chain's first useful segment is
  // deeper on every playable rig audited here, including the compact Gnome skeleton.
  const minimumDrop = maxZ * 0.08;
  const lateralMinimum = maxZ * 0.025;
  const children: number[][] = Array.from({ length: count }, () => []);
  for (let bone = 0; bone < count; bone++) {
    const parent = parents[bone]!;
    if (parent >= 0 && parent < count) children[parent]!.push(bone);
  }
  const zAt = (bone: number): number => pivots[bone * 3 + 2]!;
  const yAt = (bone: number): number => pivots[bone * 3 + 1]!;
  const floorCutoff = maxZ * 0.2;
  const spanCutoff = maxZ * 0.2;

  // First find deep, laterally separated segments. The WVM skeleton has no bone names, but all
  // playable rigs expose the same two-sided chain in this rest-pivot geometry.
  const candidateSide = new Int8Array(count);
  for (let bone = 0; bone < count; bone++) {
    const parent = parents[bone]!;
    if (parent < 0 || parent >= count) continue;
    const z = zAt(bone);
    const parentZ = zAt(parent);
    const lateral = Math.abs(yAt(bone));
    if (z < 0 || z > lowCutoff || parentZ - z < minimumDrop || lateral < lateralMinimum) continue;
    candidateSide[bone] = Math.sign(yAt(bone));
  }

  // Propagate candidate sides upward. It lets a root whose own pivot is nearly centred (Night Elf
  // female is one example) inherit the sign of its actual leg descendants.
  const subtreeSides = new Uint8Array(count);
  for (let bone = count - 1; bone >= 0; bone--) {
    const side = candidateSide[bone]!;
    if (side < 0) subtreeSides[bone]! |= 1;
    else if (side > 0) subtreeSides[bone]! |= 2;
    const parent = parents[bone]!;
    if (parent >= 0 && parent < count) subtreeSides[parent]! |= subtreeSides[bone]!;
  }

  const subtreeStats = (root: number): { minZ: number; span: number } => {
    let minZ = Number.POSITIVE_INFINITY;
    const stack = [root];
    while (stack.length > 0) {
      const bone = stack.pop()!;
      minZ = Math.min(minZ, zAt(bone));
      for (const child of children[bone]!) stack.push(child);
    }
    return { minZ, span: zAt(root) - minZ };
  };

  type LegBranch = { root: number; side: -1 | 1; depth: number; z: number; span: number };
  const branches: LegBranch[] = [];
  for (let bone = 0; bone < count; bone++) {
    const side = candidateSide[bone]!;
    if (side === 0) continue;
    let root = bone;
    // Stop at the first ancestor whose sibling subtree carries the opposite leg. This prevents a
    // pelvis with spine/arms and legs from becoming one giant lower-body branch.
    while (parents[root]! >= 0 && parents[root]! < count) {
      const parent = parents[root]!;
      const opposite = side < 0 ? 2 : 1;
      if (children[parent]!.some((child) => child !== root
        && (subtreeSides[child]! & opposite) !== 0)) break;
      root = parent;
    }
    const stats = subtreeStats(root);
    if (stats.minZ > floorCutoff || stats.span < spanCutoff) continue;
    let depth = 0;
    for (let ancestor = parents[root]!; ancestor >= 0 && ancestor < count; ancestor = parents[ancestor]!) depth++;
    branches.push({ root, side: side < 0 ? -1 : 1, depth, z: zAt(root), span: stats.span });
  }
  if (branches.length === 0) return mask;

  const ancestorSet = (bone: number): Set<number> => {
    const found = new Set<number>();
    for (let current = bone; current >= 0 && current < count; current = parents[current]!) found.add(current);
    return found;
  };
  const firstChildBelow = (ancestor: number, bone: number): number => {
    let current = bone;
    while (parents[current]! >= 0 && parents[current] !== ancestor) current = parents[current]!;
    return current;
  };
  const lowestCommonAncestor = (left: number, right: number): number => {
    const leftAncestors = ancestorSet(left);
    for (let current = right; current >= 0 && current < count; current = parents[current]!) {
      if (leftAncestors.has(current)) return current;
    }
    return -1;
  };
  const pairCandidates: Array<{
    left: LegBranch; right: LegBranch; common: number; commonDepth: number;
    symmetry: number; z: number; span: number;
  }> = [];
  for (let left = 0; left < branches.length; left++) {
    for (let right = left + 1; right < branches.length; right++) {
      const first = branches[left]!;
      const second = branches[right]!;
      if (first.side === second.side || first.root === second.root
        || Math.abs(first.z - second.z) > maxZ * 0.2) continue;
      const common = lowestCommonAncestor(first.root, second.root);
      if (common < 0 || firstChildBelow(common, first.root) === firstChildBelow(common, second.root)) continue;
      let commonDepth = 0;
      for (let ancestor = common; ancestor >= 0 && ancestor < count && parents[ancestor]! >= 0;
        ancestor = parents[ancestor]!) commonDepth++;
      pairCandidates.push({
        left: first, right: second, common, commonDepth,
        // Actual legs start at practically the same rest height and have matching vertical spans.
        // Stock HumanFemale also exposes a high helper/whole-torso cross-pair; it passed the broad
        // cutoff above but is visibly asymmetric, while the real thigh roots are not.
        symmetry: Math.abs(first.z - second.z) + Math.abs(first.span - second.span),
        z: Math.min(first.z, second.z), span: Math.min(first.span, second.span),
      });
    }
  }
  if (pairCandidates.length === 0) return mask;
  // Depth 1 pairs in full character rigs are usually cross-branch equipment helpers. A tiny
  // synthetic rig has no deeper pelvis node, so only fall back to them when no proper pair exists.
  const properPairs = pairCandidates.filter((pair) => pair.commonDepth >= 2);
  const pairs = properPairs.length > 0 ? properPairs : pairCandidates;
  pairs.sort((left, right) => left.commonDepth - right.commonDepth
    || left.symmetry - right.symmetry || right.z - left.z || right.span - left.span);
  const chosen = pairs[0]!;
  const markDescendants = (root: number): void => {
    const stack = [root];
    while (stack.length > 0) {
      const bone = stack.pop()!;
      if (mask[bone]) continue;
      mask[bone] = 1;
      for (const child of children[bone]!) stack.push(child);
    }
  };
  markDescendants(chosen.left.root);
  markDescendants(chosen.right.root);
  // Keep every ancestor of the leg branches on locomotion too. The first shared node is usually
  // the pelvis, but several playable rigs put a keyed root translation above it (HumanMale's
  // SpellCastOmni and Run both key bone1). Leaving that ancestor on the upper layer moves the
  // entire lower body even though the thigh/shin tracks were filtered out.
  for (const branch of [chosen.left.root, chosen.right.root]) {
    for (let ancestor = parents[branch]!; ancestor >= 0 && ancestor < count;
      ancestor = parents[ancestor]!) {
      mask[ancestor] = 1;
    }
  }
  return mask;
}

/** Builds a clip whose lower-body tracks are left to the locomotion action. */
export function locomotionOverlayClip(clip: THREE.AnimationClip, lowerBody: Uint8Array): THREE.AnimationClip {
  if (lowerBody.length === 0 || clip.tracks.length === 0) return clip;
  const tracks = clip.tracks.filter((track) => {
    const match = /^bone(\d+)\./.exec(track.name);
    return match === null || lowerBody[Number(match[1])] !== 1;
  });
  return tracks.length === clip.tracks.length
    ? clip
    : new THREE.AnimationClip(`${clip.name}-locomotion-overlay`, clip.duration, tracks);
}

/** Only the rig's shape matters here, so this takes it rather than a whole skeleton. */
function buildClip(clip: ModelClip | WvmSkeletonClip, skeleton: { parents: Int16Array; pivots: Float32Array }): THREE.AnimationClip | undefined {
  const tracks: THREE.KeyframeTrack[] = [];
  for (const channel of clip.channels) {
    const name = `bone${channel.bone}`;
    if (channel.kind === 1) {
      tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, channel.times, channel.values));
      continue;
    }
    if (channel.kind === 2) {
      tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, channel.times, channel.values));
      continue;
    }
    // M2 stores translation as an offset from the pivot; a keyframe track needs the final value.
    const parent = skeleton.parents[channel.bone]!;
    const rest = [0, 1, 2].map((axis) =>
      skeleton.pivots[channel.bone * 3 + axis]! - (parent >= 0 ? skeleton.pivots[parent * 3 + axis]! : 0));
    const values = new Float32Array(channel.values.length);
    for (let key = 0; key < channel.times.length; key++) {
      for (let axis = 0; axis < 3; axis++) values[key * 3 + axis] = rest[axis]! + channel.values[key * 3 + axis]!;
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, channel.times, values));
  }
  if (tracks.length === 0) return undefined;
  return new THREE.AnimationClip(`animation-${clip.animationId}`, clip.duration, tracks);
}

/**
 * One playable copy. Geometry, materials and bone inverses are shared with every other unit using
 * the model; only the bone objects and the mixer are per unit, because each plays its own
 * animation at its own time.
 */
export function instantiateSkinned(template: SkinnedTemplate, material: THREE.Material | THREE.Material[]): SkinnedInstance {
  const root = new THREE.Group();
  root.quaternion.copy(M2_TO_SCENE);

  const bones: THREE.Bone[] = [];
  for (let index = 0; index < template.parents.length; index++) {
    const bone = new THREE.Bone();
    bone.name = `bone${index}`;
    const parent = template.parents[index]!;
    const pivotX = template.pivots[index * 3]!;
    const pivotY = template.pivots[index * 3 + 1]!;
    const pivotZ = template.pivots[index * 3 + 2]!;
    if (parent >= 0 && bones[parent]) {
      bone.position.set(pivotX - template.pivots[parent * 3]!, pivotY - template.pivots[parent * 3 + 1]!, pivotZ - template.pivots[parent * 3 + 2]!);
      bones[parent]!.add(bone);
    } else {
      bone.position.set(pivotX, pivotY, pivotZ);
      root.add(bone);
    }
    bones.push(bone);
  }

  const mesh = new THREE.SkinnedMesh(template.geometry, material);
  // A skinned silhouette leaves its rest-pose bounds, and the unit is culled by distance anyway.
  mesh.frustumCulled = false;
  root.add(mesh);
  // An identity bind matrix keeps the bone matrices relative to this root, so the unit can be
  // moved and turned freely afterwards.
  mesh.bind(new THREE.Skeleton(bones, template.boneInverses), new THREE.Matrix4());
  return { root, mesh, mixer: new THREE.AnimationMixer(root), skeleton: mesh.skeleton };
}

/**
 * Turns the model's billboard bones to face the camera, after the animation has posed them.
 *
 * A billboard bone is how the files hang a flat card in a model and keep it facing the eye — the
 * glow inside a lantern, the flare on a spell, the halo on a wisp. Nothing about it is expressed
 * in the keyframes, which is why a bone flagged this way and left to its animation renders
 * edge-on from half the angles it is seen from.
 *
 * The rule is the reference clients': the bone's own axes are replaced with the camera's, so the
 * card lies in the screen plane whatever the model underneath it is doing. Its up becomes the
 * camera's up and its depth axis the camera's right, negated — a left-handed pairing that is what
 * makes the card face the viewer rather than away. A cylindrical bone keeps the axis it is pinned
 * to and only turns about it.
 *
 * Called after `mixer.update` and before the world matrices are read, because it overwrites
 * exactly what the mixer just wrote.
 */
export function applyBillboardBones(
  instance: SkinnedInstance,
  template: SkinnedTemplate,
  camera: THREE.Object3D,
): void {
  if (template.billboards.length === 0) return;
  // `updateWorldMatrix(true, …)`, not `updateMatrixWorld`. The latter composes against the parent's
  // `matrixWorld` exactly as it stands and only ever walks downwards, and nothing recomposes the
  // unit's own node until the render call at the end of the frame — so the bones would be turned
  // against where the unit stood last frame.
  instance.root.updateWorldMatrix(true, true);
  const view = camera.matrixWorld.elements;
  const right = _right.set(view[0]!, view[1]!, view[2]!).normalize();
  const up = _up.set(view[4]!, view[5]!, view[6]!).normalize();

  for (const index of template.billboards) {
    const bone = instance.skeleton.bones[index];
    if (!bone) continue;
    const flags = template.flags[index] ?? 0;

    const axisY = _axisY.copy(up);
    const axisZ = _axisZ.copy(right).negate();
    const axisX = _axisX.crossVectors(axisY, axisZ);
    if (axisX.lengthSq() < 1e-8) continue;
    axisX.normalize();
    axisY.crossVectors(axisZ, axisX).normalize();

    if ((flags & BONE_SPHERICAL_BILLBOARD) === 0) {
      // Pinned to one of its own axes: that axis stays exactly where the animation left it, and
      // the other two turn about it towards the camera — a torch flame follows the eye and still
      // stands upright. The three axes are taken in their cyclic order, so the pinned one crossed
      // into the next gives the third and the basis stays right-handed whichever axis is pinned.
      const pinned = (flags & BONE_CYLINDRICAL_BILLBOARD_X) !== 0 ? 0
        : (flags & BONE_CYLINDRICAL_BILLBOARD_Y) !== 0 ? 1 : 2;
      _pinned.setFromMatrixColumn(bone.matrixWorld, pinned).normalize();
      const columns = [axisX, axisY, axisZ];
      const next = columns[(pinned + 1) % 3]!;
      const last = columns[(pinned + 2) % 3]!;
      // The part of the next axis that is not along the pinned one. Parallel means there is no
      // turn to make, and the bone is left as the animation posed it.
      next.addScaledVector(_pinned, -next.dot(_pinned));
      if (next.lengthSq() < 1e-8) continue;
      next.normalize();
      last.crossVectors(_pinned, next);
      columns[pinned]!.copy(_pinned);
    }

    _basis.makeBasis(axisX, axisY, axisZ);
    _world.setFromRotationMatrix(_basis);
    // The bone's own rotation is what is left after its parents have had their say.
    const parent = bone.parent;
    if (parent) {
      parent.getWorldQuaternion(_parent);
      bone.quaternion.copy(_parent.invert()).multiply(_world);
    } else {
      bone.quaternion.copy(_world);
    }
  }
  // Once, at the end, rather than per bone: updating a bone's world matrix walks everything under
  // it, and a rig with a dozen billboard cards would walk most of itself a dozen times.
  instance.root.updateWorldMatrix(false, true);
}

const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _axisZ = new THREE.Vector3();
const _pinned = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _world = new THREE.Quaternion();
const _parent = new THREE.Quaternion();

/**
 * TrinityCore movement flags: forward, backward and the two strafes. Turning on the spot is not
 * movement, and neither is the interpolation between packets — that lasts a fraction of a second,
 * so a unit judged by it flickered between running and standing.
 */
export const MOVEMENT_FLAG_TRANSLATING = MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.backward
  | MOVEMENT_FLAGS.strafeLeft | MOVEMENT_FLAGS.strafeRight;
/** The unit is deliberately walking rather than running. */
export const MOVEMENT_FLAG_WALKING = MOVEMENT_FLAGS.walking;

export function isUnitMoving(movementFlags: number, hasSplineMotion: boolean): boolean {
  // The two halves answer for different units, and for a creature it is the second one.
  // `MoveSplineInit::Launch` does raise `SPLINE_ENABLED|FORWARD`, but on the core's own unit
  // (`MoveSplineInit.cpp:95-101`), and that word never reaches this client: `SMSG_MONSTER_MOVE`
  // has no flags field, so a creature's only word is the one its create block brought — and
  // `WorldState.#applyMovement` scrubs that, performing the removal `Unit::DisableSpline`
  // (`Unit.cpp:609-613`) makes without sending anything. Measured on `dist/code` with a spline
  // live: a plain creature reads `0x00000000`, a swimming one `0x00200000`, a flying one
  // `0x00000400` — FORWARD in none of them. The flags half is for the units whose word arrives by
  // `MSG_MOVE_*` relay and is left alone: a player on a taxi and a charmed creature both read
  // `0x08000001` in the same measurement, carrying the flags and the motion at once.
  return (movementFlags & MOVEMENT_FLAG_TRANSLATING) !== 0 || hasSplineMotion;
}

/** Whether the authoritative movement word (or an explicitly flying spline) says the unit flies. */
export function isUnitFlying(movementFlags: number, splineFlying = false): boolean {
  return (movementFlags & MOVEMENT_FLAGS.flying) !== 0 || splineFlying;
}

/**
 * Where walking stops and running starts, in yards a second.
 *
 * Halfway between the two defaults of 3.3.5a: walk 2.5, run 7.0. A creature dawdling at 2.5 and a
 * player sprinting at 7 are the two cases that have to land on opposite sides, and anything between
 * them is a judgement call this number makes once.
 */
const WALK_RUN_SPLIT = (2.5 + 7.0) / 2;

/** What the server says a unit is doing, which is all the animation is allowed to know. */
export interface UnitPose {
  dead: boolean;
  /** The `MovementFlags` word from the last packet about this unit. */
  movementFlags: number;
  /** A server-side spline is under way; it raises no movement flag of its own. See `isUnitMoving`. */
  spline: boolean;
  /** A flying `SMSG_MONSTER_MOVE` spline; its flag is not part of MovementInfo. */
  flight?: boolean;
  /**
   * A second model is standing under this one and the unit is sitting on it.
   *
   * Not `UNIT_FIELD_MOUNTDISPLAYID` directly: the renderer sets this once the mount is really
   * built, so a rider whose horse is still downloading keeps walking instead of gliding along in
   * the seated pose with nothing beneath them.
   */
  mounted?: boolean;
  /** `UNIT_FIELD_BYTES_1` byte 0: standing, sitting, kneeling. */
  standState: number;
  /**
   * How fast the unit is actually travelling, in yards a second, when that is known.
   *
   * The walking flag cannot answer this on its own. TrinityCore never sets it for a unit on a
   * server-side spline — `MoveSplineInit` says so in as many words, and `MoveSplineFlag` has no
   * walk bit at all, so `SMSG_MONSTER_MOVE` physically cannot report one — while
   * `RandomMovementGenerator` defaults every wandering NPC to walking. The result was that every
   * creature ambling about a town played the run clip. The spline itself carries the answer: its
   * length over its duration.
   */
  speed?: number;
}

/** Whether a pose is terminal and must take precedence over transient unit actions. */
export function isTerminalUnitPose(pose: UnitPose): boolean {
  return pose.dead || pose.standState === UNIT_STAND_STATE_DEAD;
}

export type AnimationTransition = "crossfade" | "stop" | "none";

/**
 * Decide how a new clip should replace the previous one.  A stopped one-shot is still enabled in
 * THREE.AnimationMixer until it is explicitly stopped, so it must not be left at weight 1 while
 * the next clip starts.  Only a live predecessor is suitable as a cross-fade source.
 */
export function animationTransition(previousRunning: boolean, differentAnimation: boolean): AnimationTransition {
  if (!differentAnimation) return "none";
  return previousRunning ? "crossfade" : "stop";
}

/**
 * Blend policy for replacing a clip.
 *
 * Continuous poses use an ordinary cross-fade with a fixed playback rate.  Three.js's optional
 * `warp` mode changes each action's time scale for the hand-off; HD models carry deliberately
 * different authored loop lengths, and that runtime speed change made otherwise valid poses
 * appear frozen or jumpy in the live renderer.  One-shots likewise keep authored timing and use a
 * shorter hand-off so the reaction remains readable instead of spending a fifth of a second in
 * two poses.
 */
export const LOOP_ANIMATION_BLEND = 0.18;
export const ACTION_ANIMATION_BLEND = 0.12;

export interface AnimationBlendProfile {
  duration: number;
  warp: boolean;
}

export function animationBlend(previousLoop: boolean, nextLoop: boolean): AnimationBlendProfile {
  return previousLoop && nextLoop
    ? { duration: LOOP_ANIMATION_BLEND, warp: false }
    : { duration: ACTION_ANIMATION_BLEND, warp: false };
}

/** Authored one-shot interval and the short blend window used to return to locomotion. */
export function animationFadeWindow(duration: number, fullDuration = false): {
  start: number;
  end: number;
} {
  const authored = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  return fullDuration
    ? { start: authored, end: authored + ACTION_ANIMATION_BLEND }
    : { start: Math.max(0, authored - ACTION_ANIMATION_BLEND), end: authored };
}

/**
 * A finished one-shot is already clamped on its last keyframe. Blending a new pose from that
 * stale frame makes short-lived reactions (most visibly training-dummy impacts) snap back before
 * the ordinary stance takes over. Live actions still blend normally; only a stopped predecessor
 * is excluded.
 */
export function shouldCrossFadeAnimation(previousRunning: boolean, differentAnimation: boolean): boolean {
  return animationTransition(previousRunning, differentAnimation) === "crossfade";
}

export function shouldStopPreviousAnimation(previousRunning: boolean, differentAnimation: boolean): boolean {
  return animationTransition(previousRunning, differentAnimation) === "stop";
}

/**
 * The pose a unit should be in, in order of preference, and whether it repeats.
 *
 * Nothing in the files says an animation loops — `replay` is 0..0 on Stand, Walk and Run alike —
 * so it is decided here, where the state is known: a stance or a stride repeats, a landing does
 * not. The list is ordered rather than single because a model may lack the exact pose and the
 * next name is a better answer than the DBC's generic fallback: a unit strafing in water should
 * try SwimLeft, then Swim, and only then whatever Swim falls back to.
 */
export function poseAnimation(pose: UnitPose): { wanted: number[]; loop: boolean } {
  const flags = pose.movementFlags;
  const has = (flag: number): boolean => (flags & flag) !== 0;
  // Dead is already the authored terminal pose and may be a static loop. Death is the transient
  // fall-back action; chooseAnimation changes only that action to LoopOnce + clampWhenFinished.
  if (pose.dead) return { wanted: [Dead, Death], loop: true };
  // Before every movement branch below, because the rider is not the one moving: the horse walks,
  // swims and flies, and the character holds one pose the whole way. Measured on this build's
  // `AnimationData.dbc` (506 rows) and the twenty playable models: eight names contain "mount" —
  // 91 Mount, 94 MountSpecial, 320 FlyMount, 323 FlyMountSpecial, 484 ReclinedMount, 485
  // FlyReclinedMount, 500 ReclinedMountPassenger, 501 FlyReclinedMountPassenger — and of those the
  // twenty carry 91, 484 and 500, all twenty each, and 94 and 320 not once. So 91 is the pose a
  // player has for this, a flying mount included. (The 380..386 the reference client calls
  // MOUNT_FLIGHT_* are FlyDestroyed, FlyRebuild, FlyCustom0-3 and FlyDespawn in 3.3.5.)
  //
  // 91 alone, with no Stand written behind it, and that is the whole of the fix the review caught.
  // The list is what `#requestAnimations` asks the sidecar for, and it asks only for what the list
  // cannot already resolve to (`needsSidecarAnimations`). 91 is not one of the 21 base ids that
  // travel inside the model (`BASE_ANIMATIONS`; the split is `tools/generate-visual-model.mjs`) and
  // `ANIMATION_FALLBACK` gives it no substitute, while Stand travels with everything — so `[91, 0]`
  // resolved to 0 on every freshly built model, nothing was ever fetched, and the rider stood in
  // the saddle with its legs together until some unrelated emote happened to pull the sidecar in.
  // Falling back to Stand is `chooseAnimation`'s own last resort below, which is where it belongs:
  // it is what to draw *this* frame, not what to stop asking for.
  if (pose.mounted) return { wanted: [Mount], loop: true };

  const forward = has(MOVEMENT_FLAGS.forward);
  const backward = has(MOVEMENT_FLAGS.backward);
  const left = has(MOVEMENT_FLAGS.strafeLeft);
  const right = has(MOVEMENT_FLAGS.strafeRight);
  const moving = forward || backward || left || right || pose.spline;

  // Water first: a swimmer who is also falling is still swimming, and the flags can say both
  // during the frame the character enters the water.
  // Every list ends with the pose on dry land: not every model can swim or fly, and one that
  // cannot should keep moving the way it does rather than stand there gliding across the lake.
  if (has(MOVEMENT_FLAGS.swimming)) {
    if (backward) return { wanted: [SwimBackwards, Swim, Walkbackwards], loop: true };
    if (left && !right) return { wanted: [SwimLeft, Swim, ShuffleLeft], loop: true };
    if (right && !left) return { wanted: [SwimRight, Swim, ShuffleRight], loop: true };
    // Sinking and rising are movement too: a character that stops paddling forward and dives is
    // not idling. Without this the swim idle plays all the way to the bottom of the lake.
    if (moving || has(MOVEMENT_FLAGS.ascending) || has(MOVEMENT_FLAGS.descending)) {
      return { wanted: [Swim, SwimIdle, Run], loop: true };
    }
    return { wanted: [SwimIdle, Swim, Stand], loop: true };
  }

  const flying = isUnitFlying(flags, pose.flight === true);
  if (flying) return { wanted: moving ? [Fly, Swim, Run] : [Hover, Fly, Stand], loop: true };
  if (has(MOVEMENT_FLAGS.hover) || has(MOVEMENT_FLAGS.disableGravity)) {
    return { wanted: moving ? [Fly, Run] : [Hover, Stand], loop: true };
  }
  // Airborne. The arc's own pose loops until something lands; JumpStart and JumpEnd are played by
  // the transition, not by the state, because they are over in under a second either way.
  if (has(MOVEMENT_FLAGS.falling) || has(MOVEMENT_FLAGS.fallingFar)) {
    return { wanted: [Jump, Fall], loop: true };
  }

  if (!moving) {
    switch (pose.standState) {
      case UNIT_STAND_STATE_SIT:
        return { wanted: [SitGround, SitGroundDown], loop: true };
      // Four of the states are chairs, and the poses are named for the same three heights. The
      // middle one answers for the state that only says "a chair".
      case UNIT_STAND_STATE_SIT_CHAIR:
      case UNIT_STAND_STATE_SIT_MEDIUM_CHAIR:
        return { wanted: [SitChairMed, SitGround], loop: true };
      case UNIT_STAND_STATE_SIT_LOW_CHAIR:
        return { wanted: [SitChairLow, SitChairMed, SitGround], loop: true };
      case UNIT_STAND_STATE_SIT_HIGH_CHAIR:
        return { wanted: [SitChairHigh, SitChairMed, SitGround], loop: true };
      case UNIT_STAND_STATE_KNEEL:
        return { wanted: [KneelLoop, SitGround], loop: true };
      case UNIT_STAND_STATE_DEAD:
        return { wanted: [Dead, Death], loop: true };
      case UNIT_STAND_STATE_SLEEP:
        return { wanted: [Sleep, SleepDown, Dead], loop: true };
      default:
        return { wanted: [Stand], loop: true };
    }
  }

  // Measured speed first, the flag second. Default walk is 2.5 yards a second and default run is
  // 7.0 (`Unit.cpp` baseMoveSpeed), so the halfway mark is the honest place to split them — and a
  // unit whose speed is known contradicting its flag is a unit on a spline, where the flag is
  // absent by construction rather than false.
  const walking = pose.speed !== undefined && pose.speed > 0
    ? pose.speed < WALK_RUN_SPLIT
    : has(MOVEMENT_FLAG_WALKING);
  if (backward) return { wanted: [Walkbackwards, Walk], loop: true };
  // Strafing while also going forward is a diagonal, and the original client runs it forward.
  if (!forward && left && !right) return { wanted: walking ? [ShuffleLeft, RunLeft] : [RunLeft, ShuffleLeft], loop: true };
  if (!forward && right && !left) return { wanted: walking ? [ShuffleRight, RunRight] : [RunRight, ShuffleRight], loop: true };
  return { wanted: walking ? [Walk, Run] : [Run, Walk], loop: true };
}

/**
 * The one-shot sent by `SMSG_MOUNTSPECIAL_ANIM` belongs to the mount model, not its rider.
 * Ground and flying mounts have separate authored sequences; keep the choice in the generated
 * AnimationData table instead of baking the protocol's numeric ids into the renderer.
 */
export function mountSpecialAnimation(flying: boolean): number | undefined {
  const animation = flying ? ANIMATION_IDS.FlyMountSpecial : ANIMATION_IDS.MountSpecial;
  return typeof animation === "number" ? animation : undefined;
}

/**
 * The one-shot that belongs between two poses, if any.
 *
 * A jump is three animations in the original client and one flag on the wire, so the takeoff and
 * the landing have to be inferred from the change: the frame the character leaves the ground, and
 * the frame it arrives. Returning undefined means the crossfade alone is enough.
 */
export function poseTransition(previous: UnitPose | undefined, next: UnitPose): number | undefined {
  if (!previous || next.dead) return undefined;
  const airborne = (pose: UnitPose): boolean =>
    (pose.movementFlags & (MOVEMENT_FLAGS.falling | MOVEMENT_FLAGS.fallingFar)) !== 0;
  const swimming = (pose: UnitPose): boolean => (pose.movementFlags & MOVEMENT_FLAGS.swimming) !== 0;
  if (swimming(next) || swimming(previous)) return undefined;
  // Climbing into a saddle and dropping out of one have no clip in this build — none of the eight
  // "mount" names in `AnimationData.dbc` is a one-shot getting on — and while the character is up
  // there the mount does the moving, so the airborne test below would have a rider leap off their
  // horse every time it went over a rise.
  if (previous.mounted === true || next.mounted === true) return undefined;
  if (!airborne(previous) && airborne(next)) return JumpStart;
  if (airborne(previous) && !airborne(next)) return JumpEnd;
  if (previous.standState !== next.standState) {
    if (next.standState === UNIT_STAND_STATE_SIT) return SitGroundDown;
    if (previous.standState === UNIT_STAND_STATE_SIT) return SitGroundUp;
  }
  return undefined;
}

/**
 * What the unit is holding, as far as the wire says.
 *
 * `INVTYPE_*` from the visible-item words is what the server publishes, and it is enough to tell a
 * two-hander from a one-hander from a bow. It is not enough for two distinctions the original
 * client makes: a polearm from a sword (Attack2HL against Attack2H) and a wand from a gun both
 * need the item's subclass. The appearance gateway now carries that optional ItemSubClass; old
 * three-field payloads retain their inventory-type fallback.
 */
export type WeaponPose = "unarmed" | "oneHand" | "twoHand" | "bow" | "gun" | "thrown" | "wand";

const EQUIPMENT_SLOT_MAINHAND = 15;
const EQUIPMENT_SLOT_RANGED = 17;
const INVENTORY_TYPE_WEAPON = 13;
const INVENTORY_TYPE_RANGED = 15;
const INVENTORY_TYPE_TWO_HAND = 17;
const INVENTORY_TYPE_WEAPON_MAIN_HAND = 21;
const INVENTORY_TYPE_THROWN = 25;
const INVENTORY_TYPE_RANGED_RIGHT = 26;

// ItemSubClass values from Item.dbc. Inventory type 26 is shared by guns and wands, so it is only
// a safe fallback for old appearance payloads that predate the optional subclass field.
const SUBCLASS_BOW = 2;
const SUBCLASS_GUN = 3;
const SUBCLASS_THROWN = 16;
const SUBCLASS_CROSSBOW = 18;
const SUBCLASS_WAND = 19;

function rangedWeaponPose(item: { inventoryType: number; subClass?: number }): WeaponPose | undefined {
  switch (item.subClass) {
    case SUBCLASS_BOW: return "bow";
    case SUBCLASS_GUN: return "gun";
    case SUBCLASS_THROWN: return "thrown";
    case SUBCLASS_CROSSBOW: return "bow";
    case SUBCLASS_WAND: return "wand";
  }
  // Keep the pre-subclass wire contract working for bow/gun/thrown appearances already cached by
  // an older gateway. A known subclass always wins, especially subclass 19 (wand).
  if (item.inventoryType === INVENTORY_TYPE_THROWN) return "thrown";
  if (item.inventoryType === INVENTORY_TYPE_RANGED) return "bow";
  if (item.inventoryType === INVENTORY_TYPE_RANGED_RIGHT) return "gun";
  return undefined;
}

/** What the unit swings or shoots, from the items it is visibly wearing. */
export function weaponPose(
  attached: readonly { slot: number; inventoryType: number; subClass?: number }[] | undefined,
  purpose: "melee" | "ranged" = "melee",
): WeaponPose {
  let pose: WeaponPose = "unarmed";
  for (const item of attached ?? []) {
    if (item.slot === EQUIPMENT_SLOT_RANGED) {
      // A shot is always decided by the ranged slot. A melee swing keeps scanning because a
      // hunter with a bow on their back and a sword in hand still swings the sword.
      const ranged = rangedWeaponPose(item);
      if (purpose === "ranged" && ranged) return ranged;
      if (ranged) pose = pose === "unarmed" ? ranged : pose;
      continue;
    }
    if (purpose === "ranged") continue;
    if (item.slot !== EQUIPMENT_SLOT_MAINHAND) continue;
    if (item.inventoryType === INVENTORY_TYPE_TWO_HAND) return "twoHand";
    if (item.inventoryType === INVENTORY_TYPE_WEAPON || item.inventoryType === INVENTORY_TYPE_WEAPON_MAIN_HAND) pose = "oneHand";
  }
  return pose;
}

/** Something the packets said the unit did, over whatever pose it is otherwise holding. */
export type UnitAction = "attack" | "attackOff" | "shoot" | "precast" | "cast" | "channel" | "loot";

/** The poses that could serve one action, best first. */
export function actionAnimation(action: UnitAction, weapon: WeaponPose): number[] {
  switch (action) {
    case "attack":
      switch (weapon) {
        case "twoHand": return [Attack2H, Attack1H, AttackUnarmed];
        case "oneHand": return [Attack1H, AttackUnarmed];
        case "bow": return [AttackBow, AttackUnarmed];
        case "gun": return [AttackRifle, AttackBow, AttackUnarmed];
        case "thrown": return [AttackThrown, AttackUnarmed];
        default: return [AttackUnarmed];
      }
    case "attackOff":
      return [AttackOff, AttackUnarmed];
    case "shoot":
      switch (weapon) {
        case "bow": return [FireBow, AttackBow];
        case "gun": return [AttackRifle, FireBow, AttackBow];
        case "thrown": return [AttackThrown];
        // A wand is a spell-shaped release. It must never fall through to AttackUnarmed: that
        // turns self-heal/Auto Shot-style events into a visible melee strike.
        case "wand": return [SpellCastDirected, SpellCastOmni, SpellCast];
        default: return [];
      }
    case "precast":
      return [ReadySpellOmni, SpellPrecast, Stand];
    case "cast":
      return [SpellCastOmni, SpellCastArea, SpellCast];
    case "channel":
      return [ChannelCastOmni, SpellPrecast, ReadySpellOmni, Stand];
    case "loot":
      return [Loot, Stand];
  }
}

/** The stance a unit holds while it has a weapon out and something to point it at. */
export function readyAnimation(weapon: WeaponPose): number[] {
  switch (weapon) {
    case "twoHand": return [Ready2H, Ready1H, ReadyUnarmed];
    case "oneHand": return [Ready1H, ReadyUnarmed];
    case "bow": return [ReadyBow, ReadyUnarmed];
    case "gun": return [ReadyRifle, ReadyBow, ReadyUnarmed];
    case "thrown": return [ReadyThrown, ReadyUnarmed];
    // ReadyUnarmed is only a neutral hold fallback. Wand shoot itself has a separate spell-family
    // list and resolveActionAnimation never crosses into a melee attack.
    case "wand": return [ReadySpellDirected, ReadySpellOmni, ReadyUnarmed];
    default: return [ReadyUnarmed];
  }
}

/**
 * The animation a model can really play when asked for one it may not have.
 *
 * `AnimationData.Fallback` is the table's own visual equivalent and it is a chain: Attack2HL gives
 * way to Attack2H, then to Attack1H, then to AttackUnarmed. Walking it is what lets one set of
 * names drive a wolf, a murloc and a night elf — and it is data, so a model that surprises us is
 * handled by the same rule the original client uses rather than by another list here.
 */
export function resolveAnimation(available: ReadonlySet<number> | Map<number, unknown>, wanted: Iterable<number>): number | undefined {
  const has = (id: number): boolean => available.has(id);
  for (const start of wanted) {
    let id: number | undefined = start;
    for (let hop = 0; id !== undefined && hop < 8; hop++) {
      if (has(id)) return id;
      id = ANIMATION_FALLBACK[id];
    }
  }
  return undefined;
}

/**
 * Resolves a named unit action without allowing spell/ranged requests to cross into a melee pose.
 * Their semantically valid alternatives are listed explicitly by {@link actionAnimation}; the
 * general AnimationData fallback remains correct for actual melee, emotes and locomotion.
 */
export function resolveActionAnimation(
  available: ReadonlySet<number> | Map<number, unknown>,
  action: UnitAction,
  weapon: WeaponPose,
): number | undefined {
  const wanted = actionAnimation(action, weapon);
  if (action !== "shoot" && action !== "precast" && action !== "cast" && action !== "channel") {
    return resolveAnimation(available, wanted);
  }
  for (const animation of wanted) if (available.has(animation)) return animation;
  return undefined;
}

/** Spell-family rows whose DBC fallback is allowed to remain inside spell semantics. */
const SPELL_ACTION_ANIMATIONS = new Set<number>([
  SpellPrecast, SpellCast, SpellCastArea,
  ReadySpellDirected, ReadySpellOmni, SpellCastDirected, SpellCastOmni,
  ChannelCastDirected, ChannelCastOmni,
  FlySpellPrecast, FlySpellCast, FlySpellCastArea,
  FlyReadySpellDirected, FlyReadySpellOmni, FlySpellCastDirected, FlySpellCastOmni,
  FlyChannelCastDirected, FlyChannelCastOmni,
]);

/**
 * Resolves a SpellVisualKit-authored unit animation while stopping at the spell-family boundary.
 * For example SpellCastOmni may use SpellCastArea/SpellCast, but never AttackUnarmed.
 */
export function resolveSpellVisualAnimation(
  available: ReadonlySet<number> | Map<number, unknown>,
  wanted: Iterable<number>,
): number | undefined {
  for (const start of wanted) {
    if (!SPELL_ACTION_ANIMATIONS.has(start)) {
      const resolved = resolveAnimation(available, [start]);
      if (resolved !== undefined) return resolved;
      continue;
    }
    let animation: number | undefined = start;
    for (let hop = 0; animation !== undefined && hop < 8; hop++) {
      if (available.has(animation)) return animation;
      const fallback: number | undefined = ANIMATION_FALLBACK[animation];
      animation = fallback !== undefined && SPELL_ACTION_ANIMATIONS.has(fallback)
        ? fallback
        : undefined;
    }
  }
  return undefined;
}

/** The animation to play, out of what the model actually carries. */
export function chooseAnimation(clips: Map<number, THREE.AnimationClip>, pose: UnitPose): { animation: number; loop: boolean } | undefined {
  const { wanted, loop } = poseAnimation(pose);
  const animation = resolveAnimation(clips, wanted);
  // Dying is the one pose that is reached by falling back onto an action. A model with a corpse
  // pose holds it; one without has only the death itself, and looping that would have the body
  // die over and over, so it is played once and clamped on its last frame.
  if (animation === Death) return { animation, loop: false };
  if (animation !== undefined) return { animation, loop };
  // Rather than freeze, stand; and rather than freeze without a stand clip, play anything at all.
  const fallback = clips.has(Stand) ? Stand : clips.keys().next().value;
  return fallback === undefined ? undefined : { animation: fallback, loop: true };
}

/**
 * Whether a piece of scenery is worth giving a skeleton to.
 *
 * Every doodad in the world is built with the skinned flag off — `#wvmNode` passes a literal
 * `false` — so a model with a rig and a wing-flap in it is drawn in its bind pose and stands
 * there. That is why the birds do not fly, and it is not a missing clip: it is a missing rig.
 *
 * The test is deliberately the weakest one that means anything: bones, and something to play. A
 * narrower gate — «declares an animation other than Stand» — would exclude exactly the models
 * this is for, because a bird's flap *is* its Stand. Of 405 published WVM artifacts on this
 * dataset, 60 carry a skeleton with at least one bone; the budget above the caller is what keeps
 * that from becoming sixty mixers.
 */
export function animatesAsDoodad(skeleton: WvmSkeleton | undefined): boolean {
  return skeleton !== undefined && skeleton.parents.length > 0
    && (skeleton.animations.length > 0 || skeleton.clips.length > 0);
}

/**
 * What to do with a one-shot the packets asked for: play it, hold it, or let it go.
 *
 * The three cases are not obvious from either end. A clip that is here plays. A clip the model
 * does not claim at all is gone — nothing is coming and holding the record would leave a unit
 * waiting on a fetch that will never be made. The one in the middle is the whole of Ж5.3: the
 * model *says* it can do this and the keyframes are still in flight, and that is not a reason to
 * throw the emote away.
 *
 * Of the 165 emotes `Emotes.dbc` names, only nine resolve to an animation that travels with every
 * model. The other 156 are in the sidecar, one request away — so every one of them arrived on a
 * frame with no clip yet, and every one of them was dropped on that frame. The request goes out
 * and does not come back on the same frame, so the *next* emote was dropped too. Two per model,
 * every time, before anything could play at all.
 */
export function pendingActionFate(options: {
  /** Whether the keyframes are built and ready. */
  hasClip: boolean;
  /** Whether the model's own animation list claims the pose, keyframes or not. */
  promised: boolean;
  /** Whether this action is waiting for appearance/attached-equipment metadata to resolve. */
  metadataPending?: boolean;
  now: number;
  /** When the wait runs out. A gesture a second late is worse than one that did not happen. */
  waitUntil: number;
}): "play" | "wait" | "drop" {
  if (options.hasClip) return "play";
  if ((options.promised || options.metadataPending) && options.now < options.waitUntil) return "wait";
  return "drop";
}

/** A one-shot shoot that outlived its metadata window must not start even if its clip arrives late. */
export function pendingActionExpired(
  action: UnitAction | undefined,
  holding: boolean,
  now: number,
  waitUntil: number,
): boolean {
  return action === "shoot" && !holding && now >= waitUntil;
}

/**
 * A completed one-shot can outlive its pending action record by a frame. When translation starts,
 * the full-body clip must move to the upper layer so the base gait can take over the legs. Held
 * stances are intentionally excluded: they remain owned by the action queue until cancellation.
 */
export function shouldPromoteActionToLocomotionOverlay(
  moving: boolean,
  overlayPreservesLocomotion: boolean,
  action: UnitAction | undefined,
  loop: number | undefined,
): boolean {
  return moving && !overlayPreservesLocomotion && action !== undefined && loop === THREE.LoopOnce;
}

/** Shoot metadata may arrive after the ordinary 900 ms sidecar-animation window, but never forever. */
export const SHOOT_METADATA_WAIT = 1_500;
