import * as THREE from "three";
import { RenderBone, type RenderBoneRig } from "./RenderBone.js";
import {
  FastPoseState, createFastPoseProgram, invalidateMixerApply, multiplyFlatMatrices, type FastPoseProgram,
} from "./FastPose.js";
import { SharedPose, type PoseEngine, type PoseGlobalSource } from "./PoseEngine.js";
import type { EnvironmentModel, ModelClip, ModelSkeleton } from "../gateway/VMapModel.js";
import {
  BONE_ANY_BILLBOARD, BONE_CYLINDRICAL_BILLBOARD_X, BONE_CYLINDRICAL_BILLBOARD_Y,
  BONE_CYLINDRICAL_BILLBOARD_Z, BONE_SPHERICAL_BILLBOARD,
  type WvmSkeleton, type WvmSkeletonClip, type WvmSkeletonGlobalChannel,
} from "./Wvm.js";
import { markWvaClipSetConsumed, wvaClipSetSpan } from "./WvaAnimationDecode.js";
import { seatPoseFamily, seatPoseWanted, vehicleSeatTransition, type VehiclePassengerSeatPose } from "./VehicleSeatPose.js"; // 11.02-H
import { ANIMATION_FALLBACK, ANIMATION_IDS } from "../generated/animations.js";
import { MOVEMENT_FLAGS } from "../world/MovementProtocol.js";
import {
  UNIT_STAND_STATE_DEAD, UNIT_STAND_STATE_KNEEL, UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_SIT_CHAIR,
  UNIT_STAND_STATE_SIT_HIGH_CHAIR, UNIT_STAND_STATE_SIT_LOW_CHAIR, UNIT_STAND_STATE_SIT_MEDIUM_CHAIR,
  UNIT_STAND_STATE_SLEEP, UNIT_STAND_STATE_STAND,
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
  /** Bone tracks driven by independent global-sequence clocks rather than the active clip. */
  globalChannels: WvmSkeletonGlobalChannel[];
  /** Model height in world units, for placing the name plate. */
  height: number;
  /** Lower-body bones kept under the locomotion action while a transient upper-body action plays. */
  locomotionBones?: Uint8Array;
  /**
   * Which bones a strafe turns, resolved once per rig. `null` is "this rig has none", so the
   * resolver runs once for a model that cannot answer rather than once a frame per unit wearing it.
   */
  strafeYawBones?: StrafeYawBones | null;
  /** Per-clip upper-body variants used by locomotion-preserving transient actions. */
  overlayClips?: Map<number, THREE.AnimationClip>;
}

export interface SkinnedInstance {
  root: THREE.Object3D;
  mesh: THREE.SkinnedMesh;
  mixer: THREE.AnimationMixer;
  skeleton: RigSkeleton;
}

/** A newly activated clip binds many tracks; fixed rig names need no repeated linear scan. */
export class RigSkeleton extends THREE.Skeleton implements RenderBoneRig {
  readonly #byName: Map<string, THREE.Bone>;
  /** The flat pose, once a program has been given; see `FastPoseState`. */
  #fast: FastPoseState | undefined;
  /** The same pose computed by the crowd pose worker (`PoseEngine.ts`), once asked for. */
  #shared: SharedPose | undefined;
  /** A program the pose worker had no room for; asked again only for another program. */
  #sharedRefused: FastPoseProgram | undefined;
  /** Whichever of the two the latest flat step used. */
  #flat: FastPoseState | SharedPose | undefined;
  #fastActive = false;
  #fullPoseRequested = false;
  /** `FastPoseState.version` the palette was last built from. */
  #fastPaletteVersion = -1;
  readonly #poseRoot: THREE.Object3D;
  readonly #paletteRoot = new Float64Array(16);
  /** Bones a drawn vertex is weighted to; undefined refreshes every palette entry. */
  readonly #paletteBones: Int32Array | undefined;
  /**
   * Bones the render pass can visit. A managed bone with no drawn vertex below it is skipped by
   * that pass whatever its flags say, so freezing and thawing a pose need not touch it.
   */
  readonly #traversedBones: THREE.Bone[];
  #paletteFilled = false;
  #poseFrozen = false;
  #worldFrozen = false;
  #paletteReady = false;

  constructor(bones: THREE.Bone[], boneInverses: THREE.Matrix4[], poseRoot: THREE.Object3D,
    paletteBones?: Int32Array) {
    super(bones, boneInverses);
    this.#byName = new Map(bones.map((bone) => [bone.name, bone]));
    this.#poseRoot = poseRoot;
    this.#paletteBones = paletteBones;
    this.#traversedBones = bones.filter((bone) => !(bone instanceof RenderBone) || bone.skinBranch);
  }

  get fastPoseActive(): boolean { return this.#fastActive; }

  /** The flat pose for this rig, created for `program` on first use. */
  fastPose(program: FastPoseProgram): FastPoseState {
    if (this.#fast?.program !== program) this.#fast = new FastPoseState(program, this.bones);
    this.#useFlat(this.#fast);
    return this.#fast;
  }

  /**
   * The flat pose computed by `engine`'s worker, or undefined when this step cannot be posed there
   * (see `SharedPose.prepare`); the caller then takes `fastPose`. The first call moves the skinning
   * palette into the engine's arena, at the next render, so the worker writes it directly.
   */
  sharedPose(program: FastPoseProgram, engine: PoseEngine, mixer: THREE.AnimationMixer,
    globals?: PoseGlobalSource, durations?: Uint32Array): SharedPose | undefined {
    let shared = this.#shared;
    if (shared && (shared.program !== program || shared.engine !== engine)) {
      this.#dropShared();
      shared = undefined;
    }
    if (!shared) {
      if (this.#sharedRefused === program) return undefined;
      shared = SharedPose.create(engine, program, this.bones, this.boneInverses, this.#paletteBones);
      if (!shared) {
        this.#sharedRefused = program;
        return undefined;
      }
      this.#shared = shared;
      if (this.boneTexture !== null) {
        this.boneTexture.dispose();
        this.boneTexture = null;
      }
    }
    if (!shared.prepare(mixer, globals, durations)) return undefined;
    this.#useFlat(shared);
    return shared;
  }

  /**
   * Switches the flat pose between this thread's and the worker's. A switch mid-flat carries the
   * local transforms over, so the step after it is the one the other pose would have made.
   */
  #useFlat(next: FastPoseState | SharedPose): void {
    const previous = this.#flat;
    if (previous === next) return;
    this.#flat = next;
    this.#fastPaletteVersion = -1;
    if (previous && this.#fastActive) next.adopt(previous.local, previous.readBindings);
    else next.rereadBones();
  }

  /** Gives up the worker's pose: the palette returns to a private array first. */
  #dropShared(): void {
    const shared = this.#shared;
    if (!shared) return;
    shared.sync();
    shared.settlePalette();
    if (this.boneTexture !== null && this.boneMatrices !== null && this.boneTexture.image.data === this.boneMatrices) {
      this.boneMatrices = new Float32Array(this.boneMatrices);
      this.boneTexture.dispose();
      this.boneTexture = null;
    }
    if (this.#flat === shared) {
      if (this.#fast && this.#fastActive) this.#fast.adopt(shared.local, shared.readBindings);
      this.#flat = this.#fast;
    }
    this.#shared = undefined;
    shared.dispose();
  }

  /** The palette texture, in the pose engine's arena while the worker poses this rig. */
  override computeBoneTexture(): this {
    const shared = this.#shared;
    if (shared && !shared.unusable) {
      let size = Math.sqrt(this.bones.length * 4);
      size = Math.ceil(size / 4) * 4;
      size = Math.max(size, 4);
      const data = shared.allocatePalette(size * size * 4);
      if (data) {
        data.set(this.boneMatrices!);
        const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
        texture.needsUpdate = true;
        this.boneMatrices = data;
        this.boneTexture = texture;
        this.#fastPaletteVersion = -1;
        return this;
      }
    }
    return super.computeBoneTexture();
  }

  override dispose(): void {
    const shared = this.#shared;
    this.#shared = undefined;
    if (this.#flat === shared) this.#flat = this.#fast;
    shared?.sync();
    shared?.settlePalette();
    super.dispose();
    shared?.dispose();
  }

  /**
   * Switches between the flat pose and Three's own bones. Leaving it makes the next ordinary
   * mixer step write every bound property back to its bone, and re-derives the bone matrices from
   * that step rather than from anything frozen before the flat pose took over.
   */
  setFastPoseActive(active: boolean, mixer: THREE.AnimationMixer): void {
    if (active === this.#fastActive) return;
    if (active && !this.#flat) throw new Error("fast pose activated without a program");
    this.#fastActive = active;
    this.#fastPaletteVersion = -1;
    if (active) return;
    // Three's path writes the bone objects from here on; the flat pose reads them again next time.
    this.#fast?.rereadBones();
    this.#shared?.rereadBones();
    invalidateMixerApply(mixer);
    this.#paletteReady = false;
    this.#poseFrozen = false;
    this.#worldFrozen = false;
    for (const bone of this.#traversedBones) {
      bone.matrixAutoUpdate = true;
      if (bone instanceof RenderBone) bone.frozenMatrixBranch = false;
    }
  }

  writeFastBoneWorld(index: number, target: THREE.Matrix4, refreshRoot: boolean): boolean {
    const fast = this.#flat;
    if (!this.#fastActive || !fast) return false;
    if (refreshRoot) this.#poseRoot.updateWorldMatrix(true, false);
    return fast.boneWorld(index, this.#poseRoot.matrixWorld, target);
  }

  requestFullPose(): void {
    this.#fullPoseRequested = true;
  }

  /** Whether a reader asked for a bone the flat pose does not compute since the last call. */
  takeFullPoseRequest(): boolean {
    const requested = this.#fullPoseRequested;
    this.#fullPoseRequested = false;
    return requested;
  }

  override getBoneByName(name: string): THREE.Bone | undefined {
    const bone = this.#byName.get(name);
    // Keep ordinary Skeleton behavior for a caller that renamed a bone after instantiation.
    return bone?.name === name ? bone : super.getBoneByName(name);
  }

  /**
   * The renderer can hold a distant pose for several frames. The bones then retain their local
   * matrices; when the rig also stays in place, their world matrices and GPU palette stay valid.
   * A moving root still propagates through the bone tree before the palette is refreshed.
   */
  setPoseFrozen(frozen: boolean): void {
    // A flat pose keeps its own matrices between steps; the bone flags below belong to Three's path.
    if (this.#fastActive) return;
    if (!frozen) {
      // The caller is about to step the mixer. The previous palette cannot represent that pose;
      // a subsequent render makes it reusable again, including a one-frame frozen interval.
      this.#paletteReady = false;
      if (!this.#poseFrozen) return;
      this.#poseFrozen = false;
      this.#worldFrozen = false;
      for (const bone of this.#traversedBones) {
        bone.matrixAutoUpdate = true;
        if (bone instanceof RenderBone) bone.frozenMatrixBranch = false;
      }
      return;
    }

    if (!this.#poseFrozen) {
      this.#poseFrozen = true;
      // A bone no drawn vertex follows is skipped by the render pass, so its local matrix is not
      // kept current there; it stays automatic and an explicit reader composes it on demand.
      for (const bone of this.#traversedBones) {
        // A full tick outside the frustum may never have reached Three's scene pass. In that case
        // capture its local transform here; a rendered full tick already left matrix up to date.
        if (!this.#paletteReady) bone.updateMatrix();
        bone.matrixAutoUpdate = false;
      }
      if (!this.#paletteReady) {
        // Keep offscreen rigs cheap too: initialize world matrices once and omit bone-only branches
        // until the first render asks for a palette. update() refreshes them before that draw.
        this.#poseRoot.updateWorldMatrix(true, true);
        this.#worldFrozen = true;
        for (const bone of this.#traversedBones) {
          if (bone instanceof RenderBone) bone.frozenMatrixBranch = true;
        }
        return;
      }
    }

    if (!this.#paletteReady) return;
    // Position and orientation of a rider can change through its mount's ancestors. The actual
    // world transform, not the root's local components, decides whether the palette is reusable.
    this.#poseRoot.updateWorldMatrix(true, false);
    const stationary = this.#samePaletteRoot();
    if (stationary === this.#worldFrozen) return;
    this.#worldFrozen = stationary;
    for (const bone of this.#traversedBones) {
      if (bone instanceof RenderBone) bone.frozenMatrixBranch = stationary;
    }
  }

  #samePaletteRoot(): boolean {
    const root = this.#poseRoot.matrixWorld.elements;
    for (let index = 0; index < 16; index++) {
      if (root[index] !== this.#paletteRoot[index]) return false;
    }
    return true;
  }

  override update(): void {
    const flat = this.#flat;
    if (this.#fastActive && flat && this.boneMatrices !== null) {
      if (flat instanceof SharedPose) {
        const root = this.#poseRoot.matrixWorld.elements;
        // The worker already wrote this step's palette into the texture data, against this root.
        if (flat.version !== this.#fastPaletteVersion && flat.paletteWritten(root, this.boneMatrices)) {
          if (this.boneTexture !== null) this.boneTexture.needsUpdate = true;
          this.#paletteRoot.set(root);
          this.#fastPaletteVersion = flat.version;
          return;
        }
        // Otherwise it is the page's to write; a worker it overtook may still be writing that array.
        if (flat.version !== this.#fastPaletteVersion || !this.#samePaletteRoot()) flat.settlePalette();
      }
      this.#updateFastPalette(flat, this.boneMatrices);
      return;
    }
    if (this.#poseFrozen && this.#paletteReady && this.#samePaletteRoot()) return;
    // A transform changed after setPoseFrozen(), before Three's draw. Restore propagation here;
    // callers that read attachments also need the fresh bone matrices, not merely a fresh palette.
    if (this.#worldFrozen) {
      this.#worldFrozen = false;
      for (const bone of this.#traversedBones) {
        if (bone instanceof RenderBone) bone.frozenMatrixBranch = false;
      }
      this.#poseRoot.updateWorldMatrix(true, true);
    }
    const output = this.boneMatrices;
    // Skeleton.init normally supplies the palette; retain Three's behavior for an uninitialized
    // or externally reset skeleton rather than making assumptions about its nullable API.
    if (output === null) return super.update();
    // Entries no drawn vertex reads are written once, so the whole palette is always finite; after
    // that only the weighted bones are refreshed, since the render pass skips the others.
    const selected = this.#paletteFilled ? this.#paletteBones : undefined;
    const count = selected === undefined ? this.bones.length : selected.length;
    for (let at = 0; at < count; at++) {
      const index = selected === undefined ? at : selected[at]!;
      const matrix = this.bones[index]?.matrixWorld ?? _rigIdentity;
      const inverse = this.boneInverses[index]!;
      const bind = inverse.elements;
      const offset = index * 16;
      // M2 rest poses use only a pivot translation. The first three columns therefore pass
      // through unchanged; multiplying a complete 4x4 matrix per bone does redundant work.
      // Inspect the actual inverse each time so edited/recalculated bind poses remain valid.
      if (bind[0] === 1 && bind[5] === 1 && bind[10] === 1 && bind[15] === 1
        && bind[1] === 0 && bind[2] === 0 && bind[3] === 0 && bind[4] === 0
        && bind[6] === 0 && bind[7] === 0 && bind[8] === 0 && bind[9] === 0 && bind[11] === 0) {
        const world = matrix.elements;
        const x = bind[12]!, y = bind[13]!, z = bind[14]!;
        output[offset] = world[0]!;
        output[offset + 1] = world[1]!;
        output[offset + 2] = world[2]!;
        output[offset + 3] = world[3]!;
        output[offset + 4] = world[4]!;
        output[offset + 5] = world[5]!;
        output[offset + 6] = world[6]!;
        output[offset + 7] = world[7]!;
        output[offset + 8] = world[8]!;
        output[offset + 9] = world[9]!;
        output[offset + 10] = world[10]!;
        output[offset + 11] = world[11]!;
        output[offset + 12] = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!;
        output[offset + 13] = world[1]! * x + world[5]! * y + world[9]! * z + world[13]!;
        output[offset + 14] = world[2]! * x + world[6]! * y + world[10]! * z + world[14]!;
        output[offset + 15] = world[3]! * x + world[7]! * y + world[11]! * z + world[15]!;
      } else {
        _rigOffset.multiplyMatrices(matrix, inverse).toArray(output, offset);
      }
    }
    if (this.boneTexture !== null) this.boneTexture.needsUpdate = true;
    this.#paletteRoot.set(this.#poseRoot.matrixWorld.elements);
    this.#paletteReady = true;
    this.#paletteFilled = true;
  }

  /** The same palette as `update`, from `root × model` rather than from the bone objects. */
  #updateFastPalette(fast: FastPoseState | SharedPose, output: Float32Array): void {
    if (fast.version === this.#fastPaletteVersion && this.#samePaletteRoot()) return;
    const root = this.#poseRoot.matrixWorld.elements;
    const selected = this.#paletteBones ?? fast.program.order;
    for (let at = 0; at < selected.length; at++) {
      const index = selected[at]!;
      multiplyFlatMatrices(_rigWorld, 0, root, 0, fast.model, index * 16);
      const bind = this.boneInverses[index]!.elements;
      const offset = index * 16;
      const world = _rigWorld;
      if (bind[0] === 1 && bind[5] === 1 && bind[10] === 1 && bind[15] === 1
        && bind[1] === 0 && bind[2] === 0 && bind[3] === 0 && bind[4] === 0
        && bind[6] === 0 && bind[7] === 0 && bind[8] === 0 && bind[9] === 0 && bind[11] === 0) {
        const x = bind[12]!, y = bind[13]!, z = bind[14]!;
        output[offset] = world[0]!;
        output[offset + 1] = world[1]!;
        output[offset + 2] = world[2]!;
        output[offset + 3] = world[3]!;
        output[offset + 4] = world[4]!;
        output[offset + 5] = world[5]!;
        output[offset + 6] = world[6]!;
        output[offset + 7] = world[7]!;
        output[offset + 8] = world[8]!;
        output[offset + 9] = world[9]!;
        output[offset + 10] = world[10]!;
        output[offset + 11] = world[11]!;
        output[offset + 12] = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!;
        output[offset + 13] = world[1]! * x + world[5]! * y + world[9]! * z + world[13]!;
        output[offset + 14] = world[2]! * x + world[6]! * y + world[10]! * z + world[14]!;
        output[offset + 15] = world[3]! * x + world[7]! * y + world[11]! * z + world[15]!;
      } else {
        _rigOffset.fromArray(world).multiply(this.boneInverses[index]!).toArray(output, offset);
      }
    }
    if (this.boneTexture !== null) this.boneTexture.needsUpdate = true;
    this.#paletteRoot.set(root);
    this.#fastPaletteVersion = fast.version;
  }
}

const fastPosePrograms = new WeakMap<SkinnedTemplate, FastPoseProgram | null>();

/**
 * The bones a flat pose of this rig computes: those its drawn triangles are weighted to, the
 * bones its attachment points hang on (weapons, a rider's saddle, spell anchors), and their
 * ancestors. A geometry that cannot say which bones it draws computes every bone. Cached per
 * template, whose geometry and attachment table are fixed.
 */
export function fastPoseProgramFor(
  template: SkinnedTemplate,
  attachmentBones: readonly number[],
): FastPoseProgram | undefined {
  const cached = fastPosePrograms.get(template);
  if (cached !== undefined) return cached ?? undefined;
  const demand = skinDemandFor(template);
  const required = demand === undefined
    ? Array.from({ length: template.parents.length }, (_, bone) => bone)
    : [...demand.palette, ...attachmentBones.filter((bone) => bone >= 0 && bone < template.parents.length)];
  const program = createFastPoseProgram(template.parents, template.flags, required);
  fastPosePrograms.set(template, program ?? null);
  return program;
}

const _rigIdentity = new THREE.Matrix4();
const _rigOffset = new THREE.Matrix4();
const _rigWorld = new Float64Array(16);

/** Instances own their mixer, bone objects and Skeleton, but borrow model geometry and materials. */
const disposedSkinnedInstances = new WeakSet<SkinnedInstance>();

interface CompiledRigClip {
  clip: THREE.AnimationClip | undefined;
  overlay: THREE.AnimationClip | undefined;
}

interface SharedRigClips {
  locomotionBones: Uint8Array;
  clips: WeakMap<WvmSkeletonClip, CompiledRigClip>;
  /** The rig shape these clips were compiled against; `buildClip` reads nothing else of a rig. */
  shape: { readonly parents: Int16Array; readonly pivots: Float32Array } | undefined;
}

// A model file is decoded once and reused by many appearance builds. Compiled keyframes depend on
// a rig's parents and pivots and on nothing else, so they are shared by every skeleton of
// byte-identical shape: each appearance of one model, the same model decoded again after an
// eviction, and different models on one rig — HumanMale and both HumanMalGuard models have the
// same 228 bones and pivots, and the two guards ship byte-identical sidecars, which therefore
// compile once. Bone indices and pivots mean something else on any other rig, so nothing crosses
// shapes. Every level is weak, so evicting a decoded model or sidecar releases the compiled clips.
const sharedRigClips = new WeakMap<WvmSkeleton, SharedRigClips>();
const sharedRigShapes = new Map<string, WeakRef<SharedRigClips>[]>();
const sharedRigShapeSweep = new FinalizationRegistry<string>((key) => {
  const bucket = sharedRigShapes.get(key)?.filter((handle) => handle.deref() !== undefined);
  if (bucket && bucket.length > 0) sharedRigShapes.set(key, bucket);
  else sharedRigShapes.delete(key);
});
const templateRigClips = new WeakMap<SkinnedTemplate, SharedRigClips>();

function compiledRig(skeleton: WvmSkeleton): SharedRigClips {
  let shared = sharedRigClips.get(skeleton);
  if (!shared) {
    shared = sharedRigOfShape(skeleton.parents, skeleton.pivots);
    sharedRigClips.set(skeleton, shared);
  }
  return shared;
}

function sharedRigOfShape(parents: Int16Array, pivots: Float32Array): SharedRigClips {
  if (!ArrayBuffer.isView(parents) || !ArrayBuffer.isView(pivots)) {
    // A hand-built rig without typed arrays has no byte identity to share by.
    return { locomotionBones: locomotionBoneMask(parents, pivots), clips: new WeakMap(), shape: undefined };
  }
  const key = rigShapeKey(parents, pivots);
  const bucket = sharedRigShapes.get(key) ?? [];
  for (const handle of bucket) {
    const candidate = handle.deref();
    if (candidate?.shape && sameBytes(candidate.shape.parents, parents)
      && sameBytes(candidate.shape.pivots, pivots)) return candidate;
  }
  const shared: SharedRigClips = {
    locomotionBones: locomotionBoneMask(parents, pivots),
    clips: new WeakMap<WvmSkeletonClip, CompiledRigClip>(),
    shape: { parents: parents.slice(), pivots: pivots.slice() },
  };
  bucket.push(new WeakRef(shared));
  sharedRigShapes.set(key, bucket);
  sharedRigShapeSweep.register(shared, key);
  return shared;
}

function rigShapeKey(parents: Int16Array, pivots: Float32Array): string {
  let hash = 0x811c9dc5;
  for (const view of [parents, pivots]) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let at = 0; at < bytes.length; at++) hash = Math.imul(hash ^ bytes[at]!, 0x01000193);
  }
  return `${parents.length}:${pivots.length}:${(hash >>> 0).toString(36)}`;
}

function sameBytes(left: ArrayBufferView, right: ArrayBufferView): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false;
  return true;
}

function compiledClip(shared: SharedRigClips, source: WvmSkeletonClip,
  skeleton: { parents: Int16Array; pivots: Float32Array }): CompiledRigClip {
  let result = shared.clips.get(source);
  if (!result) {
    const clip = buildClip(source, skeleton);
    result = { clip, overlay: clip ? locomotionOverlayClip(clip, shared.locomotionBones) : undefined };
    shared.clips.set(source, result);
  }
  return result;
}

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

  const shared = compiledRig(skeleton);
  const clips = new Map<number, THREE.AnimationClip>();
  const overlayClips = new Map<number, THREE.AnimationClip>();
  for (const source of skeleton.clips) {
    const { clip, overlay } = compiledClip(shared, source, skeleton);
    if (clip) clips.set(source.animationId, clip);
    if (overlay) overlayClips.set(source.animationId, overlay);
  }
  // A rig whose whole set was held back is still a rig: the clips are one request away, and
  // refusing it here would drop the model back to a stand-in capsule it never recovers from.
  // Hand-authored/legacy fixtures predate WVG1 and legitimately omit this optional tail.
  const globalChannels = skeleton.globalChannels ?? [];
  if (clips.size === 0 && skeleton.animations.length === 0 && globalChannels.length === 0) return undefined;

  const template: SkinnedTemplate = {
    geometry, clips, animations: new Set(skeleton.animations),
    boneInverses, parents: skeleton.parents, pivots: skeleton.pivots,
    flags: skeleton.flags, billboards: billboardBones(skeleton.flags), height,
    globalChannels, locomotionBones: shared.locomotionBones, overlayClips,
  };
  templateRigClips.set(template, shared);
  return template;
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
 * Metadata for one immutable decoded WVA block. Weak ownership follows the environment cache.
 */
interface SkinnedClipSetIndex {
  span: number;
  byAnimation: Map<number, number>;
  clipAt: number;
  channelAt: number;
  channels: WvmSkeletonClip["channels"] | undefined;
  complete: boolean;
}
const skinnedClipSetIndices = new WeakMap<readonly WvmSkeletonClip[], SkinnedClipSetIndex>();

function skinnedClipSetIndex(clips: readonly WvmSkeletonClip[]): SkinnedClipSetIndex {
  let index = skinnedClipSetIndices.get(clips);
  if (!index) {
    const span = wvaClipSetSpan(clips);
    if (span === undefined) {
      index = { span: 0, byAnimation: new Map(), clipAt: 0, channelAt: 0, channels: undefined, complete: clips.length === 0 };
    } else {
      // The worker already walked every channel for this span; walking them again here would
      // build every clip's channel list before the first one is compiled.
      const byAnimation = new Map<number, number>();
      for (let at = 0; at < clips.length; at++) {
        const id = clips[at]!.animationId;
        if (!byAnimation.has(id)) byAnimation.set(id, at);
      }
      index = { span, byAnimation, clipAt: clips.length, channelAt: 0, channels: undefined, complete: true };
    }
    skinnedClipSetIndices.set(clips, index);
  }
  return index;
}

/** A clip entry and each channel cost one step; a large channel list can resume mid-clip. */
function advanceSkinnedClipSetIndex(clips: readonly WvmSkeletonClip[], index: SkinnedClipSetIndex,
  maxSteps: number, milliseconds: number, started: number, now: () => number): void {
  let steps = 0;
  while (index.clipAt < clips.length && steps < maxSteps) {
    if (index.channels === undefined) {
      const clip = clips[index.clipAt]!;
      if (!index.byAnimation.has(clip.animationId)) index.byAnimation.set(clip.animationId, index.clipAt);
      index.channels = clip.channels;
      index.channelAt = 0;
      steps++;
    } else if (index.channelAt < index.channels.length) {
      const channel = index.channels[index.channelAt++]!;
      const boneEnd = channel.bone + 1;
      if (boneEnd > index.span) index.span = boneEnd;
      steps++;
    } else {
      index.clipAt++;
      index.channels = undefined;
      continue;
    }
    if (milliseconds !== Infinity && now() - started >= milliseconds) break;
  }
  index.complete = index.clipAt === clips.length;
}

/** One past the highest bone index addressed by the decoded clip set; this API scans fully. */
export function skinnedClipsBoneSpan(clips: readonly WvmSkeletonClip[]): number {
  const index = skinnedClipSetIndex(clips);
  if (!index.complete) {
    advanceSkinnedClipSetIndex(clips, index, Infinity, Infinity, 0, () => 0);
  }
  return index.span;
}
/** One warning per template per offending span, so a refusal cannot become a per-frame log. */
const refusedClipSpans = new WeakMap<SkinnedTemplate, Set<number>>();

interface SkinnedClipMergeProgress {
  seen: Uint8Array;
  next: number;
  attempted: number;
}
/**
 * Per template, every source set it merges from — held strongly, for as long as the template
 * lives. Its compiled tracks view that set's keys anyway; holding the set too keeps its clip
 * objects, and so every compiled clip cached under them, for the next appearance of the model:
 * the environment cache hands the same set back instead of fetching and compiling it again.
 */
const skinnedClipMergeProgress =
  new WeakMap<SkinnedTemplate, Map<readonly WvmSkeletonClip[], SkinnedClipMergeProgress>>();

export interface SkinnedClipMergeOptions {
  wanted?: readonly number[];
  /** Maximum source clips to attempt after validation, including empty and duplicate clips.
   * Finite budgets also cap validation at min(1024, maxClips * 64) clip/channel steps per call.
   */
  maxClips: number;
  /** Soft wall-clock budget shared by validation and compilation; one clip may overrun it. */
  milliseconds: number;
  /** Clock injection for deterministic scheduling tests. */
  now?: () => number;
}

export interface SkinnedClipMergeResult {
  added: number;
  /** No work remains: every source entry was attempted, or the whole set was rejected. */
  complete: boolean;
}

/**
 * Merge sidecar clips into one appearance template with bounded work.
 * Wanted IDs jump ahead; a per-template, per-source cursor skips those entries later.
 */
export function mergeSkinnedClips(template: SkinnedTemplate, clips: readonly WvmSkeletonClip[],
  options: SkinnedClipMergeOptions): SkinnedClipMergeResult {
  const maxClips = options.maxClips === Infinity ? clips.length
    : Number.isFinite(options.maxClips) ? Math.max(0, Math.floor(options.maxClips)) : 0;
  const milliseconds = options.milliseconds === Infinity ? Infinity
    : Number.isFinite(options.milliseconds) ? Math.max(0, options.milliseconds) : 0;
  const now = options.now ?? (() => performance.now());
  const started = now();
  const index = skinnedClipSetIndex(clips);
  const indexWasComplete = index.complete;
  if (!index.complete && maxClips > 0 && milliseconds > 0) {
    // Validation must finish before any clip is installed: a late channel can reveal a wrong rig.
    // Bound both the number of reads and their time even when one clip has many channels.
    const maxIndexSteps = options.maxClips === Infinity && milliseconds === Infinity
      ? Infinity : Math.min(1024, Math.max(1, maxClips) * 64);
    advanceSkinnedClipSetIndex(clips, index, maxIndexSteps, milliseconds, started, now);
  }
  if (!index.complete) return { added: 0, complete: false };
  // Bone indices are meaningful only against their own rig. Refuse a wider sidecar before a
  // single track can silently pose an unrelated model.
  if (index.span > template.parents.length) {
    let refused = refusedClipSpans.get(template);
    if (!refused) {
      refused = new Set<number>();
      refusedClipSpans.set(template, refused);
    }
    if (!refused.has(index.span)) {
      refused.add(index.span);
      console.warn('Animation set spanning ' + index.span + ' bones refused by a '
        + template.parents.length + '-bone rig');
    }
    return { added: 0, complete: true };
  }

  let bySource = skinnedClipMergeProgress.get(template);
  if (!bySource) {
    bySource = new Map<readonly WvmSkeletonClip[], SkinnedClipMergeProgress>();
    skinnedClipMergeProgress.set(template, bySource);
  }
  let progress = bySource.get(clips);
  if (!progress) {
    progress = { seen: new Uint8Array(clips.length), next: 0, attempted: 0 };
    bySource.set(clips, progress);
    markWvaClipSetConsumed(clips);
  }
  if (progress.attempted === clips.length) return { added: 0, complete: true };

  if (maxClips === 0 || milliseconds === 0
    || (!indexWasComplete && milliseconds !== Infinity && now() - started >= milliseconds)) {
    return { added: 0, complete: false };
  }
  const shared = templateRigClips.get(template);
  let added = 0;
  let attempted = 0;
  let wantedAt = 0;
  while (attempted < maxClips && progress.attempted < clips.length) {
    let at: number | undefined;
    while (wantedAt < (options.wanted?.length ?? 0)) {
      const candidate = index.byAnimation.get(options.wanted![wantedAt++]!);
      if (candidate !== undefined && progress.seen[candidate] === 0) {
        at = candidate;
        break;
      }
    }
    if (at === undefined) {
      while (progress.next < clips.length && progress.seen[progress.next]) progress.next++;
      at = progress.next;
    }
    if (at >= clips.length) break;

    progress.seen[at] = 1;
    progress.attempted++;
    attempted++;
    const source = clips[at]!;
    if (!template.clips.has(source.animationId)) {
      const compiled = shared
        ? compiledClip(shared, source, template)
        : { clip: buildClip(source, template), overlay: undefined };
      if (compiled.clip) {
        template.clips.set(source.animationId, compiled.clip);
        template.animations.add(source.animationId);
        if (template.locomotionBones) {
          (template.overlayClips ??= new Map()).set(
            source.animationId, compiled.overlay
              ?? locomotionOverlayClip(compiled.clip, template.locomotionBones));
        }
        added++;
      }
    }
    if (now() - started >= milliseconds) break;
  }
  return { added, complete: progress.attempted === clips.length };
}

/** Full merge for existing callers; incremental callers use mergeSkinnedClips directly. */
export function addSkinnedClips(template: SkinnedTemplate, clips: readonly WvmSkeletonClip[]): number {
  return mergeSkinnedClips(template, clips, { maxClips: Infinity, milliseconds: Infinity }).added;
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
  /**
   * Which family the list belongs to, which decides both how it resolves and how much of it is a
   * request at all.
   *
   * `"mount"` is a rider's seat ladder, which resolves inside the seat family and nowhere else —
   * the same question as the drawing one, because a request answered by a resolution the drawing
   * pass would refuse is a request that never fires and a pose that never arrives. See
   * {@link MOUNT_SEAT_ANIMATIONS}.
   *
   * `"stealth"` goes one step further and asks about the crouch rows *only*. A stealth ladder ends
   * in the ordinary gait on purpose (that is what a rig with no crouch draws), and the gait travels
   * inside every model — so a request that considered the whole list would resolve to Walk against
   * the 21 base clips and the sidecar the crouch lives in would never be fetched. The tail is a
   * drawing preference; only the head is a request. Same rule, same reason, as
   * {@link spellVisualAnimationCandidates}.
   */
  family: AnimationRequestFamily = "any",
): boolean {
  const resolve = family === "mount" ? resolveMountedRiderAnimation
    : family === "stealth" ? resolveStealthAnimation
      : resolveAnimation;
  const asked = family === "stealth" ? wanted.filter((id) => STEALTH_ANIMATIONS.has(id)) : wanted;
  // A rig with no crouch row in its own table asks for nothing rather than for the whole sidecar.
  if (asked.length === 0) return false;
  if (resolve(template.clips, asked) !== undefined) return false;
  if (template.merged) return false;
  return resolve(template.animations, asked) !== undefined;
}

/** Which resolution rule a wanted list belongs to. See {@link needsSidecarAnimations}. */
export type AnimationRequestFamily = "any" | "mount" | "stealth";

/** The family a pose's own `poseAnimation` list belongs to, so the two can never drift apart. */
export function poseAnimationFamily(
  pose: Pick<UnitPose, "mounted" | "stealth" | "vehicleSeat"> & { readonly dead?: boolean }, // 11.02-H: vehicleSeat, dead
): AnimationRequestFamily {
  // 11.02-H: a vehicle seat's ride loop is a seat pose like the rider's (`poseAnimation`'s branch).
  if (seatPoseFamily(pose.vehicleSeat, pose.dead === true)) return "mount";
  if (pose.mounted === true) return "mount";
  return pose.stealth === true ? "stealth" : "any";
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
    flags, billboards: [], globalChannels: [], height, locomotionBones, overlayClips,
  };
}

/** The two leg branches of one rig, and the bone they both hang from. See {@link legBranches}. */
interface LegBranches {
  /** Root bone of the branch on each side; which side is which is not decided here. */
  left: number;
  right: number;
  /** Their lowest common ancestor — the pelvis on every playable rig measured here. */
  common: number;
  /** Child lists, built on the way and handed back so a caller need not walk `parents` again. */
  children: readonly number[][];
}

/**
 * Finds the lower-body branches, by rest-pivot geometry alone.
 *
 * M2 does not publish bone names in WVM, but its rest pivots do preserve one useful invariant:
 * humanoid legs have a pronounced vertical drop and bilateral lateral separation below the hip.
 * Requiring both signals avoids treating zero-pivot finger/attachment helper bones as legs. The
 * first bilateral branches are retained, rather than their common pelvis subtree: the latter also
 * contains the spine and arms on several playable rigs.
 *
 * Two things read this and they want different halves of it: {@link locomotionBoneMask} wants the
 * branches, so an upper-body action can be filtered off the legs, and {@link resolveStrafeYawBones}
 * wants `common`, because that is the bone a strafe turns the lower body about. Undefined means the
 * rig has no such pair, and both callers fail open on it — an empty mask, no procedural yaw.
 */
function legBranches(parents: Int16Array, pivots: Float32Array): LegBranches | undefined {
  const count = parents.length;
  if (count === 0 || pivots.length < count * 3) return undefined;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let bone = 0; bone < count; bone++) {
    const z = pivots[bone * 3 + 2]!;
    if (!Number.isFinite(z)) continue;
    maxZ = Math.max(maxZ, z);
  }
  // M2 character feet sit close to z=0; negative pivots are usually weapon/effect helper bones and
  // should not turn an entire root branch into the lower-body mask. Scale thresholds from the model
  // top rather than min/max so those helpers cannot distort the classification.
  if (!Number.isFinite(maxZ) || maxZ <= 0) return undefined;
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
  if (branches.length === 0) return undefined;

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
  if (pairCandidates.length === 0) return undefined;
  // Depth 1 pairs in full character rigs are usually cross-branch equipment helpers. A tiny
  // synthetic rig has no deeper pelvis node, so only fall back to them when no proper pair exists.
  const properPairs = pairCandidates.filter((pair) => pair.commonDepth >= 2);
  const pairs = properPairs.length > 0 ? properPairs : pairCandidates;
  pairs.sort((left, right) => left.commonDepth - right.commonDepth
    || left.symmetry - right.symmetry || right.z - left.z || right.span - left.span);
  const chosen = pairs[0]!;
  return { left: chosen.left.root, right: chosen.right.root, common: chosen.common, children };
}

/**
 * Which bones must remain owned by locomotion while an upper-body action plays.
 *
 * The branches are {@link legBranches}; this marks them and their ancestors. If a creature has no
 * such branch, the empty mask deliberately selects the full-body fallback.
 */
export function locomotionBoneMask(parents: Int16Array, pivots: Float32Array): Uint8Array {
  const count = parents.length;
  const mask = new Uint8Array(count);
  const found = legBranches(parents, pivots);
  if (!found) return mask;
  const { children } = found;
  const markDescendants = (root: number): void => {
    const stack = [root];
    while (stack.length > 0) {
      const bone = stack.pop()!;
      if (mask[bone]) continue;
      mask[bone] = 1;
      for (const child of children[bone]!) stack.push(child);
    }
  };
  markDescendants(found.left);
  markDescendants(found.right);
  // Keep every ancestor of the leg branches on locomotion too. The first shared node is usually
  // the pelvis, but several playable rigs put a keyed root translation above it (HumanMale's
  // SpellCastOmni and Run both key bone1). Leaving that ancestor on the upper layer moves the
  // entire lower body even though the thigh/shin tracks were filtered out.
  for (const branch of [found.left, found.right]) {
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
  if (tracks.length === clip.tracks.length) return clip;
  const overlay = new THREE.AnimationClip(`${clip.name}-locomotion-overlay`, clip.duration, tracks);
  // Filtering the legs out does not change how the pose is entered, and the overlay is the clip a
  // moving cast actually plays — dropping the blend time here would leave every mid-run cast on
  // the constant while the standing one used the authored number.
  overlay.userData = { ...clip.userData };
  return overlay;
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
  const built = new THREE.AnimationClip(`animation-${clip.animationId}`, clip.duration, tracks);
  // The file's own blend window, carried on the clip because that is the only thing every caller
  // already holds: the mixer hands out actions, not artifacts, and by the time a transition is
  // being chosen the WVM block the keys came out of is long gone. Absent for a clip that came in
  // over the legacy VMap path or out of an artifact written before A1 — `animationBlend` then
  // answers with the constants, which is what every pose used to get.
  const blendTime = "blendTime" in clip ? clip.blendTime : undefined;
  if (blendTime !== undefined && blendTime > 0) built.userData["blendTime"] = blendTime;
  // The stride's authored speed, carried the same way and for the same reason: by the time a gait
  // is being scaled the artifact is gone and all anyone holds is the action and its clip. Absent
  // for every clip that does not travel — see `WvmSkeletonClip.movingSpeed`.
  const movingSpeed = "movingSpeed" in clip ? clip.movingSpeed : undefined;
  if (movingSpeed !== undefined && Number.isFinite(movingSpeed) && movingSpeed !== 0) {
    built.userData["movingSpeed"] = Math.abs(movingSpeed);
  }
  return built;
}

/** Which bones the drawn triangles are weighted to, and which bones lead down to one of those. */
export interface SkinDemand {
  /** 1 where the bone itself or any bone below it moves a drawn vertex. */
  readonly branch: Uint8Array;
  /** Bones a drawn vertex has a non-zero weight on, ascending: the palette entries a draw reads. */
  readonly palette: Int32Array;
}

const skinDemands = new WeakMap<SkinnedTemplate, SkinDemand | null>();

function attributeReader(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute):
  (vertex: number, component: number) => number {
  if ((attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
    return (vertex, component) => attribute.getComponent(vertex, component);
  }
  const array = attribute.array;
  const size = attribute.itemSize;
  return (vertex, component) => array[vertex * size + component]!;
}

/**
 * The skin weights of the triangles a rig's geometry actually draws.
 *
 * A character rig carries every bone its file names (HumanMale has 228), while the geosets one
 * appearance draws are weighted to about a hundred of them; the rest drive other geosets, weapon
 * and effect helpers, and faces nobody is wearing. Undefined means the geometry cannot say (no
 * index or skin attributes, or a bone index beyond the rig), and every bone is then demanded.
 */
export function skinDemandFor(template: SkinnedTemplate): SkinDemand | undefined {
  const cached = skinDemands.get(template);
  if (cached !== undefined) return cached ?? undefined;
  const demand = computeSkinDemand(template.geometry, template.parents);
  skinDemands.set(template, demand ?? null);
  return demand;
}

function computeSkinDemand(geometry: THREE.BufferGeometry, parents: Int16Array): SkinDemand | undefined {
  const index = geometry.index;
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  if (!index || !skinIndex || !skinWeight || skinIndex.itemSize !== 4 || skinWeight.itemSize !== 4
    || skinIndex.count !== skinWeight.count) return undefined;
  const boneCount = parents.length;
  const indices = index.array;
  const boneOf = attributeReader(skinIndex);
  const weightOf = attributeReader(skinWeight);
  const used = new Uint8Array(boneCount);
  const seen = new Uint8Array(skinIndex.count);
  const ranges = geometry.groups.length > 0
    ? geometry.groups
    : [{ start: geometry.drawRange.start, count: geometry.drawRange.count }];
  for (const range of ranges) {
    const end = Math.min(indices.length, range.start + range.count);
    for (let at = Math.max(0, range.start); at < end; at++) {
      const vertex = indices[at]!;
      if (vertex >= seen.length) return undefined;
      if (seen[vertex] === 1) continue;
      seen[vertex] = 1;
      for (let component = 0; component < 4; component++) {
        if (!(weightOf(vertex, component) > 0)) continue;
        const bone = boneOf(vertex, component);
        if (!(bone >= 0 && bone < boneCount)) return undefined;
        used[bone] = 1;
      }
    }
  }
  const branch = new Uint8Array(boneCount);
  const palette: number[] = [];
  for (let bone = 0; bone < boneCount; bone++) {
    if (used[bone] !== 1) continue;
    palette.push(bone);
    // Up to the first ancestor already marked; parents need not precede children in the file.
    for (let at = bone; at >= 0 && at < boneCount && branch[at] !== 1; at = parents[at]!) branch[at] = 1;
  }
  return { branch, palette: Int32Array.from(palette) };
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
  const demand = skinDemandFor(template);
  for (let index = 0; index < template.parents.length; index++) {
    const bone = new RenderBone();
    bone.name = `bone${index}`;
    bone.skinBranch = demand === undefined || demand.branch[index] === 1;
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
  // The rest-pose sphere, handed over rather than left null. three sorts every drawn object by its
  // sphere's centre, and a `SkinnedMesh` with no sphere computes one on its first draw by skinning
  // every vertex on the CPU (`SkinnedMesh.computeBoundingSphere` → `applyBoneTransform`): measured
  // 3.9 ms for HumanMale's 16,267 vertices, on the one frame the unit appears. A gear change builds
  // four of them at once — the unit and its three portraits — which was ~16 ms of the equip hitch,
  // and every NPC, mount and target portrait paid it too. Nothing here raycasts a unit and culling
  // is off, so the sphere only orders the draw; the rest pose places its centre well enough for
  // that. A copy per instance, because three writes into a sphere it recomputes.
  if (template.geometry.boundingSphere === null) template.geometry.computeBoundingSphere();
  if (template.geometry.boundingSphere) mesh.boundingSphere = template.geometry.boundingSphere.clone();
  root.add(mesh);
  // An identity bind matrix keeps the bone matrices relative to this root, so the unit can be
  // moved and turned freely afterwards.
  const skeleton = new RigSkeleton(bones, template.boneInverses, root, demand?.palette);
  for (let index = 0; index < bones.length; index++) {
    const bone = bones[index]!;
    if (bone instanceof RenderBone) { bone.rig = skeleton; bone.rigIndex = index; }
  }
  mesh.bind(skeleton, new THREE.Matrix4());
  // The root resolves its own bone names, which is the whole of defect M1.1.
  //
  // Every rig in this client names its bones by index — `bone0`, `bone1` — because the clips name
  // their tracks the same way, so two different models both have a `bone7`. `PropertyBinding` looks
  // a track's node up once, when the action is created, and `findNode` asks `root.skeleton` first
  // and otherwise walks the *entire* subtree by name and takes the first match
  // (`three/src/animation/PropertyBinding.js`). `#seatRider` parents the rider's whole rig inside
  // one of the mount's bones — so with a bare Group as the mixer root, the horse's own mixer found
  // the rider's `bone{n}` for every bone of its that sits after the saddle in depth-first order.
  // Measured on a four-bone pair: the mount's `bone2` track bound to the *rider's* `bone2`, leaving
  // the mount's leg in its bind pose while the character's leg played the hoof keyframes. That is
  // the owner's report, exactly: "instead of the horse's front hooves, the character's legs".
  //
  // Handing the root the instance's own `Skeleton` makes every lookup exact and confined to this
  // rig. A name it does not carry still falls through to the subtree walk, which is why
  // `addSkinnedClips` refuses a clip set wider than the rig: the two guards close the same hole
  // from both ends.
  (root as THREE.Object3D & { skeleton?: THREE.Skeleton }).skeleton = mesh.skeleton;
  return { root, mesh, mixer: new THREE.AnimationMixer(root), skeleton };
}

const _globalBoneQuaternionA = new THREE.Quaternion();
const _globalBoneQuaternionB = new THREE.Quaternion();
/** One sampled global channel: x, y, z (and w for a rotation), written by `sampleGlobalChannel`. */
const _globalSample = new Float64Array(4);
// The key window `globalBoneKeyWindow` found: left key, right key and the mix between them.
let _globalLeft = 0;
let _globalRight = 0;
let _globalMix = 0;

/**
 * Samples one global channel at `worldMs` into `_globalSample`, in the form the bone takes it:
 * a normalized rotation, a scale, or a translation already offset from the rest pivot. False when
 * the channel has no keys.
 */
function sampleGlobalChannel(
  template: SkinnedTemplate,
  channel: SkinnedTemplate["globalChannels"][number],
  globalSequences: Uint32Array,
  worldMs: number,
): boolean {
  if (channel.times.length === 0) return false;
  const duration = globalSequences[channel.globalSequence] ?? 0;
  const clockMs = duration > 0
    ? ((worldMs % duration) + duration) % duration
    : Math.max(0, worldMs);
  globalBoneKeyWindow(channel.times, clockMs / 1000, channel.interpolation);
  const left = _globalLeft, right = _globalRight, mix = _globalMix;
  if (channel.kind === 1) {
    _globalBoneQuaternionA.fromArray(channel.values, left * 4).normalize();
    if (right !== left) {
      _globalBoneQuaternionB.fromArray(channel.values, right * 4).normalize();
      _globalBoneQuaternionA.slerp(_globalBoneQuaternionB, mix).normalize();
    }
    _globalSample[0] = _globalBoneQuaternionA.x;
    _globalSample[1] = _globalBoneQuaternionA.y;
    _globalSample[2] = _globalBoneQuaternionA.z;
    _globalSample[3] = _globalBoneQuaternionA.w;
    return true;
  }
  const x = globalBoneValue(channel.values, left, right, mix, 0);
  const y = globalBoneValue(channel.values, left, right, mix, 1);
  const z = globalBoneValue(channel.values, left, right, mix, 2);
  if (channel.kind === 2) {
    _globalSample[0] = x; _globalSample[1] = y; _globalSample[2] = z;
    return true;
  }
  // Translation keys are offsets from the bone's rest pivot, as ordinary clip channels are.
  const parent = template.parents[channel.bone]!;
  _globalSample[0] = template.pivots[channel.bone * 3]!
    - (parent >= 0 ? template.pivots[parent * 3]! : 0) + x;
  _globalSample[1] = template.pivots[channel.bone * 3 + 1]!
    - (parent >= 0 ? template.pivots[parent * 3 + 1]! : 0) + y;
  _globalSample[2] = template.pivots[channel.bone * 3 + 2]!
    - (parent >= 0 ? template.pivots[parent * 3 + 2]! : 0) + z;
  return true;
}

/**
 * `applyGlobalSequenceBones` for a flat pose: the same values, written into its local transforms
 * (see `FastPoseState.local`) instead of the bone objects, and only for the bones it computes.
 * Called between `FastPoseState.advance` and `compose`, where the bone objects' turn would be.
 */
export function writeGlobalSequenceLocals(
  template: SkinnedTemplate,
  globalSequences: Uint32Array,
  worldMs: number,
  fast: FastPoseState,
): void {
  const evaluated = fast.program.evaluated;
  const local = fast.local;
  for (const channel of template.globalChannels) {
    if (evaluated[channel.bone] !== 1 || !sampleGlobalChannel(template, channel, globalSequences, worldMs)) continue;
    const offset = channel.bone * 10 + (channel.kind === 0 ? 0 : channel.kind === 1 ? 3 : 7);
    local[offset] = _globalSample[0]!;
    local[offset + 1] = _globalSample[1]!;
    local[offset + 2] = _globalSample[2]!;
    if (channel.kind === 1) local[offset + 3] = _globalSample[3]!;
  }
}

/**
 * Applies the bone channels that run on M2 global sequences after the active clip has posed the
 * rig. A model may have only these channels: both Holy Light hand flourishes do, and their ribbons
 * hang below three translated global bones. Treating such a model as static collapses the trails
 * onto its two additive cards — the visibly flat circles this path exists to fix.
 */
export function applyGlobalSequenceBones(
  instance: SkinnedInstance,
  template: SkinnedTemplate,
  globalSequences: Uint32Array,
  worldMs: number,
): void {
  if (template.globalChannels.length === 0) return;
  for (const channel of template.globalChannels) {
    const bone = instance.skeleton.bones[channel.bone];
    if (!bone || !sampleGlobalChannel(template, channel, globalSequences, worldMs)) continue;
    if (channel.kind === 1) bone.quaternion.set(_globalSample[0]!, _globalSample[1]!, _globalSample[2]!, _globalSample[3]!);
    else if (channel.kind === 2) bone.scale.set(_globalSample[0]!, _globalSample[1]!, _globalSample[2]!);
    else bone.position.set(_globalSample[0]!, _globalSample[1]!, _globalSample[2]!);
  }
}

/** Sets `_globalLeft`, `_globalRight` and `_globalMix`; module state rather than a tuple per channel. */
function globalBoneKeyWindow(times: Float32Array, time: number, interpolation: number): void {
  const last = times.length - 1;
  _globalMix = 0;
  if (last <= 0 || time <= times[0]!) {
    _globalLeft = _globalRight = 0;
    return;
  }
  if (time >= times[last]!) {
    _globalLeft = _globalRight = last;
    return;
  }
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (times[middle]! <= time) low = middle;
    else high = middle;
  }
  _globalLeft = low;
  if (interpolation === 0) {
    _globalRight = low;
    return;
  }
  _globalRight = high;
  const span = times[high]! - times[low]!;
  _globalMix = span > 0 ? (time - times[low]!) / span : 0;
}

function globalBoneValue(
  values: Float32Array,
  left: number,
  right: number,
  mix: number,
  component: number,
): number {
  const from = values[left * 3 + component] ?? 0;
  if (left === right) return from;
  const to = values[right * 3 + component] ?? from;
  return from + (to - from) * mix;
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
 * A caller rendering the rig later in the frame may defer the final full subtree update, but
 * must refresh any explicit world-matrix readers (such as spell attachments) before using them.
 */
export function applyBillboardBones(
  instance: SkinnedInstance,
  template: SkinnedTemplate,
  camera: THREE.Object3D,
  updateWorldMatrices = true,
): void {
  if (template.billboards.length === 0) return;
  // The calculation reads only billboard bones and their parents. Update those paths before
  // changing any billboard rotations, including ancestors outside this rig (a rider's saddle).
  // Unrelated bones and attachments are updated after the billboard rotations, either by the
  // final pass below or by the caller's subsequent scene render.
  for (const index of template.billboards) {
    instance.skeleton.bones[index]?.updateWorldMatrix(true, false);
  }
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
  if (updateWorldMatrices) instance.root.updateWorldMatrix(false, true);
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
  /**
   * Which kind of seat the rider occupies, when anything knows.
   *
   * The three values are the three seat poses every playable rig carries, measured over the 22
   * character models this client ships: 91 Mount, 484 ReclinedMount and 500 ReclinedMountPassenger
   * on all 22, and 320/485/501 — the flying twins — on none of them.
   *
   * Nothing sets it to anything but "upright" today, and that is a statement about the wire rather
   * than an omission. A mount here is `UNIT_FIELD_MOUNTDISPLAYID`, which `Unit::Mount` writes on
   * its own with no seat beside it, so an ordinary rider is always the driver of an upright seat.
   * The reclined and passenger poses belong to *vehicles*, where the seat is a
   * `VehicleSeatEntry` — a row this client does not read, reached through `MovementInfo.transport`
   * (`WorldObjectState.transport.seat`) rather than through the mount field at all, and rendered
   * as a second unit rather than as a mount under this one. So the ladder is written and waiting,
   * and what would have to arrive first is the seat's own DBC row.
   */
  mountSeat?: "upright" | "reclined" | "reclinedPassenger";
  /**
   * 11.02-H: the vehicle seat the unit sits in, once the vehicle tables are here — the row's ride
   * loop for the whole body, the one-shot on taking it and HIDE_PASSENGER (`VehicleSeatPose.ts`,
   * Wow.exe 0x00747b20/0x007485b0). The seat row above arrived this way; `mountSeat` stays the
   * mount's. Absent off a vehicle, on a ship, a lift or a mount, and without the tables.
   */
  vehicleSeat?: VehiclePassengerSeatPose | undefined;
  /**
   * The unit is sneaking, so its ground locomotion is the crouched ladder.
   *
   * The same flag that fades it (`unitAppearance` in `world/Fields.ts`), and deliberately only the
   * stealth half of it: an invisible mage walks normally and a ghost has no crouch at all. Ground
   * states only — see {@link stealthGroundAnimations} for why swimming and flight are untouched.
   */
  stealth?: boolean;
  /** `UNIT_FIELD_BYTES_1` byte 0: standing, sitting, kneeling. */
  standState: number;
  /**
   * `UNIT_FIELD_BYTES_1` byte 3, the core's `AnimTier`: 0 ground, 1 swim, 2 hover, 3 fly,
   * 4 submerged. Absent when nothing read it. See {@link hoversOnFlightTier}.
   */
  animationTier?: number;
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

export type AnimationTransition = "crossfade" | "fade" | "stop" | "none";

/**
 * Decide how a new clip should replace the previous one.
 *
 * A stopped one-shot is still enabled in THREE.AnimationMixer until it is explicitly stopped, so
 * it must not be left at weight 1 while the next clip starts. Only a live predecessor is suitable
 * as a cross-fade *source*, because `crossFadeFrom` ties the two actions' clocks together and a
 * finished action has no clock left to tie.
 *
 * What it was not suitable for is `stop()`, which is what this used to answer. Every completed
 * one-shot in this renderer is `LoopOnce` + `clampWhenFinished`, so it holds its last authored
 * frame at weight 1 — and stopping it drops that frame to nothing on the same tick the next pose
 * appears at weight 1. That single-frame jump is the pop the owner reports after a cast, a
 * landing and every training-dummy reaction. "fade" keeps the clamped pose in the mixer and takes
 * its weight down over the blend window while the new pose comes up, which is a cross-fade in
 * everything but the time coupling: two independent weight ramps, no shared clock.
 */
export function animationTransition(previousRunning: boolean, differentAnimation: boolean): AnimationTransition {
  if (!differentAnimation) return "none";
  return previousRunning ? "crossfade" : "fade";
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
/**
 * What an authored blend time is allowed to be, in seconds.
 *
 * The file is trusted, not obeyed: this client's own range is 10 ms (one NightElfFemale sequence)
 * to 350 ms (Murloc, NightElfFemale), and a custom module can put any u16 in the slot. A blend
 * longer than the clip it is entering would hold two poses at once for the whole animation.
 */
const MIN_AUTHORED_BLEND = 0.01;
const MAX_AUTHORED_BLEND = 0.5;

export interface AnimationBlendProfile {
  duration: number;
  warp: boolean;
}

/**
 * How long the hand-off between two poses takes.
 *
 * `blendTime` is the incoming clip's own `M2Sequence.blendTime` in seconds, read off the artifact
 * (`clip.userData.blendTime`), and it wins when the file carries one: 150 ms is the ordinary
 * HumanMale answer, but NightElfFemale stands up over 300 ms and a wolf enters one of its poses in
 * 50, and the two constants below flattened all of that into 180/120. The constants remain the
 * answer for a clip with no authored number — a legacy VMap clip, an artifact from before the
 * clip header carried one, or one of the 26 HumanMale sequences whose blend time is a real zero.
 */
export function animationBlend(previousLoop: boolean, nextLoop: boolean, blendTime?: number): AnimationBlendProfile {
  if (blendTime !== undefined && Number.isFinite(blendTime) && blendTime >= MIN_AUTHORED_BLEND) {
    return { duration: Math.min(MAX_AUTHORED_BLEND, blendTime), warp: false };
  }
  return previousLoop && nextLoop
    ? { duration: LOOP_ANIMATION_BLEND, warp: false }
    : { duration: ACTION_ANIMATION_BLEND, warp: false };
}

/** The authored blend window a built clip carries, or undefined when the artifact had none. */
export function clipBlendTime(clip: THREE.AnimationClip | undefined): number | undefined {
  const value = clip?.userData["blendTime"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** How long a newly visible unit takes to fade in, in ms. Long enough to read, short enough to never hide gameplay. */
export const SPAWN_FADE_WINDOW_MS = 400;

/**
 * What fraction of a fresh unit is painted yet.
 *
 * Distant streaming delivers dozens of units in one frame, and an instant full-opacity appearance
 * reads as a pop. The fade starts when the unit first becomes visible — not when its record is
 * created, which for streamed content is whole seconds earlier — and a unit returning from
 * frustum culling or a settled one both read 1: only the first appearance eases in.
 */
export function spawnFadeFactor(admittedAt: number | undefined, now: number): number {
  if (admittedAt === undefined || !Number.isFinite(admittedAt) || !Number.isFinite(now)) return 1;
  const elapsed = now - admittedAt;
  if (elapsed <= 0) return 0;
  if (elapsed >= SPAWN_FADE_WINDOW_MS) return 1;
  return elapsed / SPAWN_FADE_WINDOW_MS;
}

/**
 * The ground speed this stride was authored for, in yards a second, as a magnitude.
 *
 * Undefined for everything that does not travel, which is most of a rig: RidingHorse carries a
 * number on three of its 43 sequences (Walk 2.5, Run 6.9444, Walkbackwards −2.5) and a real zero
 * on the other forty.
 */
export function clipMovingSpeed(clip: THREE.AnimationClip | undefined): number | undefined {
  const value = clip?.userData["movingSpeed"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Authored stride speed for a locomotion gait, borrowing Walk/Run when the gait names none.
 *
 * ShuffleLeft/Right are authored as standstill sidesteps (`movingSpeed` 0 on every playable rig
 * measured) — replaying that rate at travel speed is the skate. Walk and Run carry the model's
 * real stride rates, so a gait without its own number borrows its tempo's ordinary gait: below
 * the walk/run split the walk, at and above it the run. `undefined` when neither the gait nor
 * the fallback names a positive speed, and the caller then plays the authored rate.
 */
export function locomotionAuthoredSpeed(
  clips: ReadonlyMap<number, THREE.AnimationClip> | undefined,
  animation: number,
  actualSpeed: number | undefined,
): number | undefined {
  return clipMovingSpeed(clips?.get(animation))
    ?? clipMovingSpeed(clips?.get(actualSpeed !== undefined && actualSpeed < WALK_RUN_SPLIT ? Walk : Run));
}

/** Bounds of the presentational unit stride replay: slower than a crawl and faster than a sprint. */
export const UNIT_GAIT_MIN_TIME_SCALE = 0.5;
export const UNIT_GAIT_MAX_TIME_SCALE = 2.0;
/** Steps per unit rate, the same twentieths the mount scale rounds to for benchmark stability. */
const UNIT_GAIT_TIME_SCALE_STEPS = 20;
/**
 * Replays a unit's stride at the speed it is really travelling, like `mountGaitTimeScale`.
 *
 * The mount bounds (0.6–1.6) are that reference's own feel for horses; a unit's gaits span walk
 * 2.5 to run 7 and beyond with buffs, so the window is wider. Quantised for the same reason:
 * the formal benchmark compares bones across runs, and a continuous rate would move them with
 * the frame time.
 */
export function unitGaitTimeScale(actualSpeed: number | undefined, authoredSpeed: number | undefined): number {
  if (actualSpeed === undefined || authoredSpeed === undefined) return 1;
  if (!Number.isFinite(actualSpeed) || !Number.isFinite(authoredSpeed)) return 1;
  if (authoredSpeed <= 0 || actualSpeed <= 0) return 1;
  const ratio = Math.min(UNIT_GAIT_MAX_TIME_SCALE, Math.max(UNIT_GAIT_MIN_TIME_SCALE, actualSpeed / authoredSpeed));
  return Math.round(ratio * UNIT_GAIT_TIME_SCALE_STEPS) / UNIT_GAIT_TIME_SCALE_STEPS;
}

/** Distance no stride covers in one frame: teleports and update snaps, as on the glide path. */
export const STRIDE_SNAP_YARDS = 25;

/**
 * Travel speed off two node positions and the frame time between them.
 *
 * Both arguments are seconds-based — yards covered over `mixer.update`'s own clock — because a
 * milliseconds clock divided once more reads a walk as a sprint: 7 yards over 16 ms is 437 when
 * the divisor is treated as seconds, and every gait then saturates its upper bound. `undefined`
 * for a first frame, a stalled clock, garbage input and teleports; the caller replays the
 * authored rate instead.
 */
export function measuredTravelSpeed(distanceYards: number, elapsedSeconds: number): number | undefined {
  if (!(elapsedSeconds > 0)) return undefined;
  if (!Number.isFinite(distanceYards) || distanceYards < 0 || distanceYards > STRIDE_SNAP_YARDS) return undefined;
  return distanceYards / elapsedSeconds;
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
 * A finished one-shot is already clamped on its last keyframe, and three.js's `crossFadeFrom`
 * synchronises the two actions' clocks — which a stopped action does not have. That is why it is
 * still excluded here. It is *not* a reason to remove the pose from the mixer: see
 * {@link shouldFadeOutPreviousAnimation}.
 */
export function shouldCrossFadeAnimation(previousRunning: boolean, differentAnimation: boolean): boolean {
  return animationTransition(previousRunning, differentAnimation) === "crossfade";
}

/**
 * Whether the previous pose should be faded out beside the new one rather than cut.
 *
 * This is the half that used to be `stop()`. The clamped last frame stays in the mixer at falling
 * weight while the incoming clip rises from zero, so a completed cast, landing or reaction leaves
 * over the same window it would have arrived in, instead of vanishing between two frames.
 */
export function shouldFadeOutPreviousAnimation(previousRunning: boolean, differentAnimation: boolean): boolean {
  return animationTransition(previousRunning, differentAnimation) === "fade";
}

/**
 * Nothing asks for a hard stop through the policy any more.
 *
 * Kept as the policy's own statement that "stop" is no longer reachable: the paths that really do
 * want a pose gone without a trace — a model being torn down, a unit rebuilt into another costume
 * — call `stop()` directly and never consult a transition.
 */
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
  //
  // A1 wrote that list as the single id 91. A2 makes it a ladder — see `mountedRiderAnimations` —
  // and the whole ladder still reaches `needsSidecarAnimations`, because every rung of it is a
  // seat pose that lives in the sidecar and none of them is a base id the fresh template already
  // resolves. That is the same precedent `spellVisualAnimationCandidates` set: what might be drawn
  // and what must be fetched are one question here.
  // 11.02-H: a vehicle seat's ride loop, by the same rule — the one id, no Stand behind it, resolved
  // inside the seat family (`poseAnimationFamily`). A seat that names no loop falls through.
  const seatWanted = seatPoseWanted(pose.vehicleSeat);
  if (seatWanted !== undefined) return { wanted: seatWanted, loop: true };
  if (pose.mounted) return { wanted: mountedRiderAnimations(pose), loop: true };

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
  // Hover without flight plays the flying tier only on a unit the server put on it; everything
  // else hovering walks and stands on its ground clips (see `hoversOnFlightTier`).
  if (hoversOnFlightTier(pose)) {
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
        // The crouch is a standing pose and nothing else: a rogue who sits down is sitting, which
        // is why this is the one arm of the switch that asks.
        return {
          wanted: pose.stealth === true ? animationLadder("StealthStand", "Stand") : [Stand],
          loop: true,
        };
    }
  }

  // Measured speed first, the flag second. Default walk is 2.5 yards a second and default run is
  // 7.0 (`Unit.cpp` baseMoveSpeed), so the halfway mark is the honest place to split them — and a
  // unit whose speed is known contradicting its flag is a unit on a spline, where the flag is
  // absent by construction rather than false.
  const walking = pose.speed !== undefined && pose.speed > 0
    ? pose.speed < WALK_RUN_SPLIT
    : has(MOVEMENT_FLAG_WALKING);
  if (pose.stealth === true) {
    return { wanted: stealthGroundAnimations({ walking, backward, left, right, forward }), loop: true };
  }
  if (backward) return { wanted: [Walkbackwards, Walk], loop: true };
  // Strafing while also going forward is a diagonal, and the original client runs it forward. Both
  // halves of that are now measured rather than asserted.
  //
  // *The reference client.* `LocomotionFSM::resolve` has no ground strafe arm at all — its WALK and
  // RUN states answer with plain Walk/Run and only SWIM branches on `anyStrafeLeft` — and
  // `anim_capability_probe.cpp:80-83` says why in as many words: "strafing (pure or diagonal)
  // reuses plain Walk/Run and the renderer's torso-bone rotation for the visual angle". Its
  // `anyStrafeLeft` is `strafeLeft && !strafeRight && !movingBackward`, which is the same three
  // exclusions as the three arms above: backward wins, and two strafes cancel into the forward
  // answer. This client keeps the authored sidestep for a *pure* strafe, which the reference gave
  // up rather than a decision it made — the clips are there and they are what the original plays.
  //
  // *The clean corpus* (`F:/CircleClean`, read through `tools/m2.mjs`). Not one playable rig
  // carries RunLeft (93) or RunRight (92): HumanMale, HumanFemale, OrcMale, OrcFemale,
  // NightElfFemale, TaurenMale, GnomeFemale and DruidCat all carry ShuffleLeft (11) and
  // ShuffleRight (12) — 500 ms, `movingSpeed` 0 on every one of them — and none of the eight
  // carries 92/93. Horse.m2 is the same: 11 and 12, no 92/93, no MountRunLeft (373). So the
  // walk/run inversion below is a preference a custom rig could honour and a distinction this
  // dataset never makes; every one of the four arms resolves to the same 500 ms shuffle. Neither
  // 11 nor 12 has a `Fallback` row in AnimationData, and both are in `BASE_ANIMATIONS`, so the
  // sidestep travels inside the model and a strafe never waits on the sidecar.
  // Neither shuffle nor run-sideways carries a `Fallback` row in AnimationData, so a rig
  // without the sidestep would fall all the way to Stand and glide sideways. The ordinary gait
  // behind them is the honest answer for such a rig: legs moving beat legs still.
  if (!forward && left && !right) {
    return { wanted: walking ? [ShuffleLeft, RunLeft, Walk] : [RunLeft, ShuffleLeft, Run, Walk], loop: true };
  }
  if (!forward && right && !left) {
    return { wanted: walking ? [ShuffleRight, RunRight, Walk] : [RunRight, ShuffleRight, Run, Walk], loop: true };
  }
  return { wanted: walking ? [Walk, Run] : [Run, Walk], loop: true };
}

/**
 * The travelling clips, and only those.
 *
 * The set a {@link commitLocomotion} window is allowed to hold one member of in place of another.
 * It is deliberately the *gaits* and not every looping pose: Stand, SwimIdle, Hover, a seat, a
 * corpse and the airborne loop are all outside it, so stopping, standing up, mounting, dying and
 * leaving the ground are never delayed by a frame. What is inside it is exactly what the ground and
 * water arms of {@link poseAnimation} can name, which is what a player changes by pressing a
 * direction key.
 */
const LOCOMOTION_GAITS: ReadonlySet<number> = new Set<number>(
  [Walk, Run, Walkbackwards, ShuffleLeft, ShuffleRight, RunLeft, RunRight,
    Swim, SwimLeft, SwimRight, SwimBackwards,
    ANIMATION_IDS["StealthWalk"], ANIMATION_IDS["StealthRun"]]
    .filter((id): id is number => typeof id === "number"),
);

/** Whether an animation is one of the travelling gaits a commit window may hold. See {@link LOCOMOTION_GAITS}. */
export function isLocomotionGait(animation: number | undefined): animation is number {
  return animation !== undefined && LOCOMOTION_GAITS.has(animation);
}

/**
 * How long a freshly started gait owns the mixer before another gait may replace it, in ms.
 *
 * 150 ms, and it is the same 150 ms the files author: measured over the eight playable rigs above,
 * Walk, Run, Walkbackwards, ShuffleLeft and ShuffleRight all carry `M2Sequence.blendTime` 150 on
 * every one of them, so a gait change is a 150 ms cross-fade and this window is exactly long enough
 * for that cross-fade to finish. The reference client's own guard against the same flicker is the
 * comparable `LocomotionFSM::kGraceSec = 0.12f`.
 *
 * Not a setting. A knob here would be a knob on how the character feels rather than on what it
 * looks like, and the number is not a preference: it is the length of the blend it protects.
 */
export const LOCOMOTION_COMMIT_WINDOW = 150;

export interface LocomotionCommit {
  /** The animation to actually play this frame. */
  animation: number;
  /** When the gait playing after this frame may next be replaced, in the caller's clock. */
  committedUntil: number;
}

/**
 * Holds a gait for the length of its own blend before letting the next one in.
 *
 * The owner's report is that strafes do not blend properly, and this is the mechanism. Three.js
 * schedules a fade from a *fixed* start weight, not from the weight the action currently has:
 * `AnimationAction.fadeOut` is `_scheduleFading(duration, 1, 0)` and `reset()` calls `stopFading()`,
 * which drops the incoming action back to its base weight of 1. So a second gait change landing
 * inside the first one's cross-fade does not continue it — it *snaps*. Run → ShuffleLeft at t=0,
 * flags back to Run at t=75 ms: the shuffle is at weight 0.5 and the run at 0.5, and the frame the
 * second change is made the shuffle is put back to 1.0 and the run to 0.0 before the new blend
 * starts. The pose jumps toward the clip being left. That is the double-blend, and circle-strafing
 * — tapping a strafe key while running — reproduces it on every tap.
 *
 * The window opens when a gait *starts*, so the first change is never delayed: pressing a strafe
 * key answers on the same frame it always did. Only a second change inside the following 150 ms
 * waits, and it waits at most that long, because the pose pass runs every frame and takes the
 * pending answer the moment the window closes. Anything that is not gait-to-gait — starting to
 * move, stopping, jumping, mounting, dying — is passed straight through.
 */
export function commitLocomotion(
  playing: number | undefined,
  wanted: number,
  committedUntil: number,
  now: number,
): LocomotionCommit {
  const incoming = isLocomotionGait(wanted);
  // Nothing to decide: the pose pass asks for the same clip every frame it is not changing.
  if (playing === wanted) return { animation: wanted, committedUntil };
  // A gait replacing a gait is the only change worth holding, and only while the window is open.
  if (isLocomotionGait(playing) && incoming && now < committedUntil) {
    return { animation: playing, committedUntil };
  }
  // A gait that is starting owns the mixer for its blend; anything else closes the window, so a
  // unit that stops, sits or dies cannot carry a stale deadline into its next stride.
  return { animation: wanted, committedUntil: incoming ? now + LOCOMOTION_COMMIT_WINDOW : 0 };
}

/** Whether the movement word says the unit is off the ground under its own arc. */
function isAirborne(pose: UnitPose): boolean {
  return (pose.movementFlags & (MOVEMENT_FLAGS.falling | MOVEMENT_FLAGS.fallingFar)) !== 0;
}

/**
 * Whether a hovering, gravity-free unit that is not flying should take the flying-tier poses.
 *
 * Only when its `AnimTier` says hover (2) or fly (3). The owner's report of 2026-09-28 — "the
 * character sometimes swam instead of running or walking" in Gundrak — was this branch applied to
 * everything with the HOVER bit: a priest bot's Levitate (spell 1706: auras 105 feather fall, 106
 * hover, 104 water walk) raised it on the player for 91 s, the ladder asked for Fly then Run, and
 * `resolveAnimation` walks the whole DBC fallback chain of a rung before trying the next — Fly(135)
 * falls back to Swim(42), which HumanMale has, so Run was never reached. 19 of the 20 playable
 * models have no Fly clip at all; OrcMale is the only one.
 *
 * The tier is the core's own word for it (`UnitDefines.h` `AnimTier`: "Hover — plays flying tier
 * animations or falls back to ground tier animations"). `Creature::SetHover` and
 * `Creature::SetDisableGravity` move a creature onto the hover or fly tier; `Unit::SetHover` — the
 * player's — leaves the tier alone, so a levitating player stays on the ground tier and runs, as
 * the reference client (wowee) plays it. A unit whose tier nobody read is treated the same way.
 */
export function hoversOnFlightTier(pose: UnitPose): boolean {
  if ((pose.movementFlags & (MOVEMENT_FLAGS.hover | MOVEMENT_FLAGS.disableGravity)) === 0) return false;
  return pose.animationTier === ANIM_TIER_HOVER || pose.animationTier === ANIM_TIER_FLY;
}

/** `AnimTier::Hover` and `AnimTier::Fly` (`UnitDefines.h`), byte 3 of `UNIT_FIELD_BYTES_1`. */
const ANIM_TIER_HOVER = 2;
const ANIM_TIER_FLY = 3;

/**
 * The authored sidestep clips. While one of these plays the legs already travel sideways.
 *
 * The set matters because it is the difference between this client and the reference one. wowee has
 * no ground strafe clip at all — `anim_capability_probe.cpp:80-83` says so — so every strafe there
 * is plain Walk/Run plus the full turn. Here `poseAnimation` keeps the authored sidestep for a pure
 * strafe (`ShuffleLeft`/`ShuffleRight` on all eight playable rigs of the clean corpus), and turning
 * the legs a further quarter on top of a clip that already faces that way would overshoot by 90°.
 */
const SIDESTEP_ANIMATIONS: ReadonlySet<number> = new Set<number>(
  [ShuffleLeft, ShuffleRight, RunLeft, RunRight, SwimLeft, SwimRight]
    .filter((id): id is number => typeof id === "number"),
);

/** A forward diagonal: one strafe key with the forward key, so travel is 45° off the facing. */
export const STRAFE_YAW_DIAGONAL = Math.PI / 4;
/** A pure strafe on a rig with no sidestep clip: travel is a quarter turn off the facing. */
export const STRAFE_YAW_PURE = Math.PI / 2;

/**
 * How fast the lower body turns toward the travel direction, in radians a second.
 *
 * A quarter turn inside one {@link LOCOMOTION_COMMIT_WINDOW} — the 150 ms that is the authored
 * `blendTime` of every gait on all eight playable rigs — so the legs finish turning exactly as the
 * gait they are turning under finishes its cross-fade, and the ±45° diagonal is reached in 75 ms.
 *
 * The reference client does not smooth this at all: `renderer.cpp:1613-1653` recomputes the delta
 * from the current keys every frame and writes it straight in. That is defensible for the one model
 * a local player drives at frame rate, and wrong for the twenty around it: a remote unit's flags
 * arrive with its movement packets, several frames apart, so an unsmoothed port would snap the legs
 * of everyone else in view. The bound is the whole of the difference.
 */
export const STRAFE_YAW_RATE = STRAFE_YAW_PURE / (LOCOMOTION_COMMIT_WINDOW / 1000);

/** A frame longer than this is a stall, not a frame; the turn is allowed to finish across it. */
const STRAFE_YAW_MAX_STEP_SECONDS = 0.25;

/**
 * How far the lower body should be turned off the unit's facing, in radians, positive to its left.
 *
 * The original turns the legs into the direction of travel and leaves the torso on the facing, and
 * the reference client is explicit about the shape: while moving and strafing it puts the *model* on
 * `getTravelYaw()` and counter-rotates the SpineLow key bone by `facingYaw - travelYaw`
 * (`renderer.cpp:1613-1653`, `character_renderer.cpp:2332-2336`). This is the same decomposition
 * seen from the other end — the model stays on the server's facing, which the name plate, the camera
 * pivot and every targeting test read, and the *lower* body is turned instead. The two produce the
 * same legs and the same torso.
 *
 * The table, and where each row comes from:
 *
 * | keys                    | target | why                                                        |
 * |-------------------------|--------|------------------------------------------------------------|
 * | forward, or nothing     | 0      | travel is the facing                                        |
 * | forward + strafe        | ±45°   | `travelYaw_ = atan2(forward ± right)`, `camera_controller.cpp:2562` |
 * | strafe, sidestep clip   | 0      | the authored shuffle already faces that way                  |
 * | strafe, no such clip    | ±90°   | what the reference gets for the same keys                   |
 * | backward, with or without a strafe | 0 | `activeStrafe` excludes it (`renderer.cpp:1611-1612`) |
 * | both strafes            | 0      | they cancel, and so does `travelYaw_`                        |
 *
 * Ground locomotion only. Swimming, flight, hover and a fall each have their own directional clips
 * or no ground under them, and a mounted rider is sitting: its legs are in the saddle pose and
 * belong to the seat, not to the travel. The mount itself is deliberately not turned either — the
 * reference client has a single character instance and no separate mount rig to take a ruling from,
 * and turning the animal off `unit.node`'s server orientation would move the seat the rider hangs
 * from. Whether the horse should lean into a strafe is the owner's eye to settle.
 */
export function strafeYawTarget(pose: UnitPose, animation: number | undefined): number {
  if (pose.dead || pose.mounted === true) return 0;
  const flags = pose.movementFlags;
  const has = (flag: number): boolean => (flags & flag) !== 0;
  if (has(MOVEMENT_FLAGS.swimming) || isUnitFlying(flags, pose.flight === true)
    || hoversOnFlightTier(pose) || isAirborne(pose)) return 0;
  const left = has(MOVEMENT_FLAGS.strafeLeft);
  const right = has(MOVEMENT_FLAGS.strafeRight);
  // Neither key, or both: the reference client's movement vector cancels to the forward one.
  if (left === right) return 0;
  if (has(MOVEMENT_FLAGS.backward)) return 0;
  // M2 space is Z-up and faces +X, so +Y is the model's left and a positive turn about +Z takes
  // its forward toward that left — which is where a unit strafing left is going.
  const sign = left ? 1 : -1;
  if (has(MOVEMENT_FLAGS.forward)) return sign * STRAFE_YAW_DIAGONAL;
  return animation !== undefined && SIDESTEP_ANIMATIONS.has(animation) ? 0 : sign * STRAFE_YAW_PURE;
}

/**
 * Moves the current turn toward its target at a bounded rate, so a key change never snaps.
 *
 * The shortest way round is not needed: both ends are inside ±90°, so the plain difference is
 * already the short arc. A non-finite carry-over — nothing has been stored yet — takes the target.
 */
export function stepStrafeYaw(current: number, target: number, seconds: number): number {
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(seconds) || seconds <= 0) return current;
  const step = STRAFE_YAW_RATE * Math.min(seconds, STRAFE_YAW_MAX_STEP_SECONDS);
  const delta = target - current;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

/** The bones a strafe turns, resolved from the rig itself. See {@link resolveStrafeYawBones}. */
export interface StrafeYawBones {
  /** The bone both leg branches hang from: turning it turns the legs about the body's own axis. */
  pelvis: number;
  /** Its children that carry no leg — the spine — turned back so the torso keeps the facing. */
  torso: readonly number[];
}

/**
 * Which bones a strafe turns on this rig, or undefined when the rig cannot answer.
 *
 * WVM carries no bone names and no `keyBoneId` table — `decodeSkeleton` reads parents, flags and
 * pivots and nothing else (`Wvm.ts:674-688`) — so the reference client's "the bone whose keyBoneId
 * is 4" cannot be asked here. The rig's own geometry answers instead, through the same
 * {@link legBranches} the locomotion overlay already trusts: the pelvis is the lowest common
 * ancestor of the two leg branches, and the torso is whatever else hangs off it.
 *
 * Measured through the running gateway over every rig this dataset serves as a playable body — all
 * twenty `Character\` models — and five creature rigs beside them. Nineteen of the twenty answer
 * bone 2, whose parent is bone 1 and whose *sibling* is the spine: the torso is not a descendant of
 * the pelvis at all, so turning the pelvis leaves the upper body exactly where the clip put it and
 * `torso` comes back empty on every one of them. ScourgeFemale is the twentieth and finds no leg
 * pair — the same blind spot {@link locomotionBoneMask} already has on that rig — and fails open.
 * What does hang off the pelvis is belt, tabard and skirt helpers, three to eight per rig and none
 * of them reaching higher than the pelvis itself; those ride with the hips, which is what they do in
 * the reference client too, where the whole model turns and only the spine is put back.
 *
 * Fail-open, in four places, because a wrong bone here is a body bent in half:
 *
 * 1. No bilateral leg pair, which is most creature rigs.
 * 2. A pelvis that *is* the root bone — Horse answers bone 0. Turning the root is turning the whole
 *    model, and which way the model faces belongs to the server's orientation, not to this.
 * 3. A pelvis whose rest pivot is off the body's own vertical axis. The legs swing about the line
 *    through that pivot, and the reference client swings them about the model origin, so the two
 *    agree only while the pivot is near it. Measured as a fraction of model height, the nineteen
 *    bipeds run 0.0014…0.0719 (GnomeFemale is the far end; every lateral offset is ≤ 0.0005) and
 *    the quadrupeds' hind hips are 0.0957 (DruidCat), 0.2241 (DruidBear) and 0.2530 (Wolf). The
 *    threshold below sits in that gap, which is the whole reason it can be one number.
 * 4. A non-leg child of the pelvis that climbs above it — a rig that does put the spine under the
 *    pelvis — and is not itself on the axis. Such a child is turned back by the same angle about
 *    its own pivot, which restores its orientation exactly and its position only while both pivots
 *    are on the axis being turned about. The reference client's counter-rotation has the identical
 *    property and the identical reason it is invisible.
 */
export function resolveStrafeYawBones(
  parents: Int16Array, pivots: Float32Array,
): StrafeYawBones | undefined {
  const found = legBranches(parents, pivots);
  if (!found) return undefined;
  const pelvis = found.common;
  if (pelvis < 0 || pelvis >= parents.length) return undefined;
  if (parents[pelvis]! < 0) return undefined;
  let maxZ = 0;
  for (let bone = 0; bone < parents.length; bone++) {
    const z = pivots[bone * 3 + 2]!;
    if (Number.isFinite(z) && z > maxZ) maxZ = z;
  }
  if (maxZ <= 0) return undefined;
  // Eight per cent of the model's own height: above every biped measured (0.0719) and below every
  // quadruped (0.0957). Horizontal distance from the model's axis, both axes at once, because the
  // turn is about a vertical line and either offset moves it off the body.
  const axisRadius = maxZ * 0.08;
  const centred = (bone: number): boolean =>
    Math.hypot(pivots[bone * 3]!, pivots[bone * 3 + 1]!) <= axisRadius;
  if (!centred(pelvis)) return undefined;

  const inSubtree = (root: number, wanted: number): boolean => {
    for (let bone = wanted; bone >= 0 && bone < parents.length; bone = parents[bone]!) {
      if (bone === root) return true;
    }
    return false;
  };
  const reachesAbove = (root: number, height: number): boolean => {
    const stack = [root];
    while (stack.length > 0) {
      const bone = stack.pop()!;
      if (pivots[bone * 3 + 2]! > height) return true;
      for (const child of found.children[bone] ?? []) stack.push(child);
    }
    return false;
  };
  // A tenth of the model's height above the pelvis: enough that a belt helper a centimetre higher
  // than the hip is not mistaken for a spine, and far below where any real torso chain reaches.
  const torsoHeight = pivots[pelvis * 3 + 2]! + maxZ * 0.1;
  const torso: number[] = [];
  for (const child of found.children[pelvis] ?? []) {
    if (inSubtree(child, found.left) || inSubtree(child, found.right)) continue;
    if (!reachesAbove(child, torsoHeight)) continue;
    if (!centred(child)) return undefined;
    torso.push(child);
  }
  return { pelvis, torso };
}

/** Resolved once per rig and remembered on the template every unit of that model shares. */
export function strafeYawBonesFor(template: SkinnedTemplate): StrafeYawBones | undefined {
  if (template.strafeYawBones === undefined) {
    template.strafeYawBones = resolveStrafeYawBones(template.parents, template.pivots) ?? null;
  }
  return template.strafeYawBones ?? undefined;
}

/** M2 space is Z-up, so the body's own axis is +Z. See {@link strafeYawTarget}. */
const STRAFE_YAW_AXIS = new THREE.Vector3(0, 0, 1);
const strafeYawTurn = new THREE.Quaternion();
const strafeYawChain = new THREE.Quaternion();
const strafeYawLocal = new THREE.Quaternion();

/**
 * The rotation of `bone`'s ancestors, in model space, as the product of their local quaternions.
 *
 * Deliberately not `getWorldQuaternion`: that needs `matrixWorld` to be current, and nothing
 * recomposes it between the mixer's update and this pass. A pelvis is two or three bones from the
 * root, so the walk is cheaper than the matrix update would be anyway.
 */
function boneChainQuaternion(bone: THREE.Object3D, root: THREE.Object3D,
  out: THREE.Quaternion): THREE.Quaternion {
  // Reused rather than allocated: 2–3 ancestors per call, one call per strafing unit per frame,
  // fully consumed synchronously with no reentrancy.
  boneChainScratch.length = 0;
  for (let node: THREE.Object3D | null = bone; node && node !== root; node = node.parent) {
    boneChainScratch.push(node);
  }
  out.identity();
  for (let index = boneChainScratch.length - 1; index >= 0; index--) {
    out.multiply(boneChainScratch[index]!.quaternion);
  }
  return out;
}

/** Scratch for {@link boneChainQuaternion}; see above for why sharing is safe. */
const boneChainScratch: THREE.Object3D[] = [];

/**
 * The un-turned pose of every bone this pass has written, so the turn cannot compound.
 *
 * The mixer writes a bone's local quaternion only while a clip *keys* that bone, and neither the
 * pelvis nor the spine is keyed by every clip — nor is anything keyed at all while a model waits for
 * its first one. Left to premultiply blindly, this pass would then turn an already-turned bone again
 * on every frame and spin the legs off the body. Per bone rather than per instance because the bones
 * are what the pass owns, and weak because they die with their unit.
 */
const strafeYawApplied = new WeakMap<THREE.Object3D,
{ clean: THREE.Quaternion; result: THREE.Quaternion }>();

/** Puts the un-turned pose back when nothing overwrote last frame's turn. */
function restoreYawedBone(bone: THREE.Object3D | undefined): void {
  if (!bone) return;
  const state = strafeYawApplied.get(bone);
  // Exact equality, and it is exact: `result` was copied out of this quaternion after the write, so
  // it is bit-identical unless something else has written since. What the mixer writes is the clip's
  // pose, which differs from a turned one by a real rotation.
  if (state && bone.quaternion.equals(state.result)) bone.quaternion.copy(state.clean);
}

/** Turns one bone by an already-parent-framed rotation and remembers both sides of it. */
function turnYawedBone(bone: THREE.Object3D | undefined, local: THREE.Quaternion): void {
  if (!bone) return;
  let state = strafeYawApplied.get(bone);
  if (!state) {
    state = { clean: new THREE.Quaternion(), result: new THREE.Quaternion() };
    strafeYawApplied.set(bone, state);
  }
  state.clean.copy(bone.quaternion);
  bone.quaternion.premultiply(local);
  state.result.copy(bone.quaternion);
}

/**
 * Turns the lower body toward the travel direction, over whatever the mixer just posed.
 *
 * Called after `mixer.update` and before `applyBillboardBones`, in the same post-mixer hook and for
 * the same reason: this is a correction on top of the clip's pose, and it is re-derived from that
 * pose every frame rather than added to what it left behind.
 *
 * The turn is about the model's own vertical axis through the pelvis pivot, and a rotation in model
 * space is not a rotation in the pelvis's parent's frame — the parent is itself being animated. So
 * the axis is carried into that frame first, `q⁻¹·R·q`, and the result pre-multiplied onto the
 * bone's local quaternion, which rotates the whole subtree about the bone's own pivot and moves the
 * pivot not at all. The torso children are turned back by the inverse, in the pelvis's frame as it
 * now stands, so the upper body ends up exactly where the clip put it.
 */
export function applyStrafeYaw(
  instance: SkinnedInstance, bones: StrafeYawBones, radians: number,
): void {
  const pelvis = instance.skeleton.bones[bones.pelvis];
  if (!pelvis) return;
  // Before anything is decided, and on every call including the ones that turn nothing: a unit that
  // stops strafing has to be given its clip's own pose back.
  restoreYawedBone(pelvis);
  for (const bone of bones.torso) restoreYawedBone(instance.skeleton.bones[bone]);
  if (radians === 0 || !Number.isFinite(radians)) {
    strafeYawApplied.delete(pelvis);
    for (const bone of bones.torso) {
      const object = instance.skeleton.bones[bone];
      if (object) strafeYawApplied.delete(object);
    }
    return;
  }

  strafeYawTurn.setFromAxisAngle(STRAFE_YAW_AXIS, radians);
  const above = boneChainQuaternion(pelvis.parent ?? instance.root, instance.root, strafeYawChain);
  strafeYawLocal.copy(above).invert().multiply(strafeYawTurn).multiply(above);
  turnYawedBone(pelvis, strafeYawLocal);
  if (bones.torso.length === 0) return;
  // The pelvis's frame *after* its own turn, which is the frame its children live in.
  const inside = strafeYawChain.multiply(pelvis.quaternion);
  strafeYawLocal.copy(inside).invert().multiply(strafeYawTurn.invert()).multiply(inside);
  for (const bone of bones.torso) turnYawedBone(instance.skeleton.bones[bone], strafeYawLocal);
}

/**
 * The seat poses, and the family a seat request is not allowed to leave.
 *
 * `AnimationData.Fallback` is right about most things and wrong about this one: it sends
 * FlyMount (320) to FlyStand (229), which is a *flying creature's idle* and not a rider's seat, and
 * from there into the FlyClose/FlyOpen pair. A rider resolved down that chain would sit in the
 * saddle doing a gryphon's hover. So a seat request walks the chain only while it stays inside
 * these six ids, exactly as a spell request stays inside `SPELL_ACTION_ANIMATIONS`.
 *
 * On this client's data the boundary changes nothing and is a safety property: measured over the
 * 22 playable rigs, all 22 carry 91/484/500 and not one carries 320/485/501 or any of
 * 229/375/376/377. It exists so a module that adds a flying seat pose, or a creature rig that has
 * FlyStand and is ridden, cannot quietly put the rider in the wrong animation.
 */
const MOUNT_SEAT_ANIMATIONS: ReadonlySet<number> = new Set<number>(
  [
    ANIMATION_IDS.Mount, ANIMATION_IDS["FlyMount"],
    ANIMATION_IDS["ReclinedMount"], ANIMATION_IDS["FlyReclinedMount"],
    ANIMATION_IDS["ReclinedMountPassenger"], ANIMATION_IDS["FlyReclinedMountPassenger"],
  ].filter((id): id is number => typeof id === "number"),
);

/**
 * The crouch rows, and the family a stealth request is not allowed to leave.
 *
 * The boundary is load-bearing here in a way it was only protective for seats, because
 * `AnimationData.Fallback` walks straight out of this family in one hop: **StealthWalk (119) →
 * Walk (4)** and **StealthRun (223) → StealthWalk → Walk**, measured on this build's table.
 * Walk travels inside every model, so an unbounded request for a crouch resolves to Walk against
 * the 21 base clips and `needsSidecarAnimations` answers "already have it" — the sidecar the crouch
 * really lives in would never be asked for. StealthStand (120) has no fallback row at all.
 *
 * Measured over five playable rigs: HumanMale, NightElfFemale, OrcMale, GnomeFemale and TaurenMale
 * each carry 119, 120 and 223, all three held back in the sidecar (`0119-00`, `0120-00`, `0223-00`),
 * and **none of the five carries any of 348/349/452**, the flying twins. DruidCat carries none of
 * the six, which is why every ladder below ends in the ordinary gait rather than in a crouch.
 */
const STEALTH_ANIMATIONS: ReadonlySet<number> = new Set<number>(
  ["StealthStand", "StealthWalk", "StealthRun", "FlyStealthStand", "FlyStealthWalk", "FlyStealthRun"]
    .map((name) => ANIMATION_IDS[name])
    .filter((id): id is number => typeof id === "number"),
);

/**
 * The crouched ground ladder, best first, ending in the gait the unit would have walked anyway.
 *
 * Only the three standing rows are used. The flying twins exist in `AnimationData` and on no rig
 * this client ships, and a druid in flight form is not sneaking anyway — swimming and flight keep
 * their own ladders untouched, which is also what stops a stealthed swimmer from crouching
 * underwater.
 *
 * There is no StealthWalkBackwards and no crouched strafe in the table, so backwards and sideways
 * movement asks for the crouched walk and then falls through to the ordinary answer for that
 * direction. That fall-through is only reachable through {@link resolveStealthAnimation}: the plain
 * resolver would take StealthWalk to Walk by the DBC chain and a rig with no crouch would face
 * forwards while walking backwards.
 */
export function stealthGroundAnimations(movement: {
  walking: boolean; backward: boolean; left: boolean; right: boolean; forward: boolean;
}): number[] {
  const { walking, backward, left, right, forward } = movement;
  if (backward) return animationLadder("StealthWalk", "Walkbackwards", "Walk");
  // The ordinary gait closes each ladder for the same reason as the unconcealed strafe arms: a
  // rig without the sidestep must step, not glide.
  if (!forward && left && !right) {
    return walking
      ? animationLadder("StealthWalk", "ShuffleLeft", "RunLeft", "Walk")
      : animationLadder("StealthWalk", "RunLeft", "ShuffleLeft", "Run", "Walk");
  }
  if (!forward && right && !left) {
    return walking
      ? animationLadder("StealthWalk", "ShuffleRight", "RunRight", "Walk")
      : animationLadder("StealthWalk", "RunRight", "ShuffleRight", "Run", "Walk");
  }
  // Both crouch gaits before either ordinary one: a rig with only StealthWalk should creep at the
  // wrong tempo rather than break into a full run while the server says the unit is sneaking.
  return walking
    ? animationLadder("StealthWalk", "StealthRun", "Walk", "Run")
    : animationLadder("StealthRun", "StealthWalk", "Run", "Walk");
}

/**
 * Resolves a crouch request without letting `AnimationData` walk it back out into the ordinary
 * gait, then answers the rest of the ladder the ordinary way.
 *
 * Two questions in one list, exactly as the seat ladder has: the crouch rows are a request that
 * must reach the sidecar, and the tail behind them is what to draw when the rig has no crouch. The
 * tail is tried only after every crouch row has failed, so a rig that carries one never falls past
 * it.
 */
export function resolveStealthAnimation(
  available: ReadonlySet<number> | Map<number, unknown>,
  wanted: Iterable<number>,
): number | undefined {
  const tail: number[] = [];
  for (const start of wanted) {
    if (!STEALTH_ANIMATIONS.has(start)) {
      tail.push(start);
      continue;
    }
    let animation: number | undefined = start;
    for (let hop = 0; animation !== undefined && hop < 8; hop++) {
      if (available.has(animation)) return animation;
      const fallback: number | undefined = ANIMATION_FALLBACK[animation];
      animation = fallback !== undefined && STEALTH_ANIMATIONS.has(fallback) ? fallback : undefined;
    }
  }
  return resolveAnimation(available, tail);
}

/** Appends the ids this build's AnimationData actually names, in the order given. */
function animationLadder(...names: readonly string[]): number[] {
  const ladder: number[] = [];
  for (const name of names) {
    const id = ANIMATION_IDS[name];
    if (typeof id === "number" && !ladder.includes(id)) ladder.push(id);
  }
  return ladder;
}

/**
 * The seat poses a rider should try, best first.
 *
 * Ordered by what the names mean rather than by number. The flying twin of a seat comes first when
 * the mount is in the air, because that is the only thing that distinguishes 320 from 91 and 485
 * from 484; the reclined seat outranks the upright one when the seat is reclined, because a
 * reclined rider drawn upright is sitting through the vehicle; and the passenger pose outranks the
 * driver's for a passenger, because the driver's has the reins in it. Every ladder ends at 91,
 * which all 22 playable rigs carry, so the tail is always answerable.
 *
 * Deliberately not ending at Stand: the tail of this list is what `#requestAnimations` is allowed
 * to fetch, and Stand travels inside every model, so a Stand written here would resolve on the
 * spot and the sidecar would never be asked — the A1 defect, in a new place. Standing in the
 * saddle while 91 is downloading is `chooseAnimation`'s own last resort.
 */
export function mountedRiderAnimations(
  pose: Pick<UnitPose, "flight" | "mountSeat" | "movementFlags">,
): number[] {
  // The same predicate the rest of this file flies by: the movement word is authoritative and a
  // spline can carry its own flying bit while the word is absent. A rider on a taxi has the second
  // and a player on a flying mount the first.
  const flying = isUnitFlying(pose.movementFlags, pose.flight === true);
  switch (pose.mountSeat) {
    case "reclinedPassenger":
      return flying
        ? animationLadder("FlyReclinedMountPassenger", "ReclinedMountPassenger", "FlyReclinedMount", "ReclinedMount", "Mount")
        : animationLadder("ReclinedMountPassenger", "ReclinedMount", "Mount");
    case "reclined":
      return flying
        ? animationLadder("FlyReclinedMount", "ReclinedMount", "FlyMount", "Mount")
        : animationLadder("ReclinedMount", "Mount");
    default:
      return flying ? animationLadder("FlyMount", "Mount") : animationLadder("Mount");
  }
}

/**
 * Resolves a seat request without letting it out of the seat family. See {@link MOUNT_SEAT_ANIMATIONS}.
 */
export function resolveMountedRiderAnimation(
  available: ReadonlySet<number> | Map<number, unknown>,
  wanted: Iterable<number>,
): number | undefined {
  for (const start of wanted) {
    let animation: number | undefined = start;
    for (let hop = 0; animation !== undefined && hop < 8; hop++) {
      if (available.has(animation)) return animation;
      const fallback: number | undefined = ANIMATION_FALLBACK[animation];
      animation = fallback !== undefined && MOUNT_SEAT_ANIMATIONS.has(fallback) ? fallback : undefined;
    }
  }
  return undefined;
}

/**
 * The pose the *mount* is in, derived from the rider's movement and from nothing else about them.
 *
 * The horse walks, swims, flies and jumps; the character sits. Everything the rider is doing that
 * is not travel has to be taken off the pose before it reaches the mount, and until now only one
 * of the three was: `#animateUnit` cleared `mounted` (or the horse would have tried to sit on
 * itself) and passed the rest through. So a rider sitting on the ground — `standState` still
 * `SIT` on the frame the mount goes up, and any `/sit` while mounted — put the horse into
 * SitGround, and a dead rider played the horse's Death. Neither is a state a mount can be in: the
 * mount is an aura and `AuraEffect::HandleAuraMounted` dismounts on removal, so a corpse in a
 * saddle is a frame of the renderer's own making, and the renderer simply must not animate the
 * horse dying because its rider did.
 *
 * `available` is the mount's clip map, and it is what makes the airborne case fail open. A rider
 * going over a rise raises `falling`, and a mount rig with no airborne clip at all — measured:
 * Gryphon carries none of 37/38/39/40 and not even Fall's own SwimIdle fallback — would resolve
 * nothing, drop to `chooseAnimation`'s Stand, and stop flapping in mid-air. Clearing the airborne
 * flags for a rig that cannot answer them keeps the gait it was already playing.
 */
export function mountPose(rider: UnitPose, available?: ReadonlySet<number> | Map<number, unknown>): UnitPose {
  const pose: UnitPose = {
    ...rider,
    mounted: false,
    dead: false,
    // A crouch is the rider's, never the animal's: `SPELL_AURA_MOD_STEALTH` and the CREEP bit are
    // written on the unit that carries the aura, and the mount under it is a display id with no
    // state of its own. The same sanitising as the stand state and death, and it also keeps the
    // mount's request out of the stealth family, where a horse would ask for rows no mount rig has.
    stealth: false,
    standState: UNIT_STAND_STATE_STAND,
  };
  if (!isAirborne(pose) || !available) return pose;
  if (resolveAnimation(available, poseAnimation(pose).wanted) !== undefined) return pose;
  return { ...pose, movementFlags: pose.movementFlags & ~(MOVEMENT_FLAGS.falling | MOVEMENT_FLAGS.fallingFar) };
}

/**
 * The one-shot that belongs between two *mount* poses.
 *
 * The mount has never had one. `poseTransition` refuses outright the moment either side is
 * mounted, and rightly so for the rider — there is no clip for climbing into a saddle, and a
 * character that played JumpStart every time its horse went over a rise would be leaping out of
 * the seat. But the horse underneath is doing exactly what an unmounted unit does, and it has the
 * clips for it: measured, RidingHorse carries JumpStart 833 ms, Jump 667 ms, JumpEnd 1100 ms and
 * Fall 667 ms; NetherDrake carries JumpStart and Jump and no landing; Gryphon carries none of the
 * four. So this is `poseTransition`'s airborne half and only that half — no sit/stand one-shots,
 * because `mountPose` has already fixed the stand state to STAND and a mount has no stand state of
 * its own to change.
 *
 * Both arguments are mount poses (`mountPose` output), not rider poses. Flight is refused because
 * a flying mount is airborne for the whole flight and its takeoff is not a jump; swimming for the
 * same reason `poseTransition` refuses it, on either side of the change.
 */
export function mountPoseTransition(previous: UnitPose | undefined, next: UnitPose): number | undefined {
  if (!previous) return undefined;
  const swimming = (pose: UnitPose): boolean => (pose.movementFlags & MOVEMENT_FLAGS.swimming) !== 0;
  if (swimming(next) || swimming(previous)) return undefined;
  if (isUnitFlying(next.movementFlags, next.flight === true)
    || isUnitFlying(previous.movementFlags, previous.flight === true)) return undefined;
  if (!isAirborne(previous) && isAirborne(next)) return JumpStart;
  if (isAirborne(previous) && !isAirborne(next)) return JumpEnd;
  return undefined;
}

/**
 * How fast a mount's stride may be replayed, against the speed its author built it for.
 *
 * The ratio is the honest number and the clamp is the honest limit: a stride played at three times
 * its authored rate is a blur, and one played at a third is a moonwalk, so the answer stays within
 * a range where the legs still read as legs. The bounds are the reference client's own feel rather
 * than a measurement — there is no such column in any DBC — and they are stated here once instead
 * of being spread across the renderer.
 *
 * Quantised to twentieths and not lerped, deliberately. A lerp would move the rate by an amount
 * that depends on how long the frame was, which makes the same replay produce different bones on a
 * different machine — this client has a formal benchmark that compares exactly that. Rounding to a
 * step instead means the rate changes only when the speed really has, it changes by a step the eye
 * cannot pick out (5% of the stride rate), and it is a pure function of the two speeds with no
 * memory at all.
 */
export const MOUNT_GAIT_MIN_TIME_SCALE = 0.6;
export const MOUNT_GAIT_MAX_TIME_SCALE = 1.6;
/** Steps per unit rate, so the rounding is done in integers and 0.6 comes back as exactly 0.6. */
const MOUNT_GAIT_TIME_SCALE_STEPS = 20;

export function mountGaitTimeScale(actualSpeed: number | undefined, authoredSpeed: number | undefined): number {
  if (actualSpeed === undefined || authoredSpeed === undefined) return 1;
  if (!Number.isFinite(actualSpeed) || !Number.isFinite(authoredSpeed)) return 1;
  const authored = Math.abs(authoredSpeed);
  const actual = Math.abs(actualSpeed);
  if (authored <= 0 || actual <= 0) return 1;
  const ratio = Math.min(MOUNT_GAIT_MAX_TIME_SCALE, Math.max(MOUNT_GAIT_MIN_TIME_SCALE, actual / authored));
  return Math.round(ratio * MOUNT_GAIT_TIME_SCALE_STEPS) / MOUNT_GAIT_TIME_SCALE_STEPS;
}

/**
 * How fast this unit is really travelling, in yards a second, when anything says.
 *
 * Three sources, in the order of how much they know. A spline says it outright — length over
 * duration — and it is the only one that is true of a creature nobody is driving. Otherwise the
 * server's own rate for the movement the unit is performing: the nine `SMSG_SPLINE_SET_*` /
 * `MSG_MOVE_SET_*` values are absolute yards a second (`Unit.cpp:9244` multiplies before sending),
 * so no base speed has to be known here. `runSpeed` is the create block's copy of one of them and
 * is the last word.
 *
 * The player's *own* character is the honest gap. Its speed changes arrive as the
 * `SMSG_FORCE_*_SPEED_CHANGE` family, which `WorldClient` acknowledges and stores in its own
 * `speeds` map rather than on the object — so `object.speeds` is empty for self and `runSpeed`
 * still holds the value the create block brought. Every other rider on screen is answered
 * correctly, because their changes come in by relay and land on the object.
 */
export function unitTravelSpeed(
  pose: UnitPose,
  speeds: ReadonlyMap<string, number> | undefined,
  runSpeed: number | undefined,
): number | undefined {
  if (pose.speed !== undefined && pose.speed > 0) return pose.speed;
  const flags = pose.movementFlags;
  const backward = (flags & MOVEMENT_FLAGS.backward) !== 0;
  const named = (flags & MOVEMENT_FLAGS.swimming) !== 0 ? (backward ? "swimBack" : "swim")
    : isUnitFlying(flags, pose.flight === true) ? (backward ? "flightBack" : "flight")
      : backward ? "runBack"
        : (flags & MOVEMENT_FLAG_WALKING) !== 0 ? "walk" : "run";
  const speed = speeds?.get(named) ?? (named === "run" ? runSpeed : undefined);
  return speed !== undefined && Number.isFinite(speed) && speed > 0 ? speed : undefined;
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
  // 11.02-H: in or out of a vehicle seat, the only one-shot is the seat's own start on taking it
  // (RideAnimStart / RideUpperAnimStart, Wow.exe 0x00747b20) — the vehicle does any jumping.
  const seatTransition = vehicleSeatTransition(previous.vehicleSeat, next.vehicleSeat);
  if (seatTransition !== false) return seatTransition;
  const airborne = isAirborne;
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
 * Where a spell animation goes when the table's own chain runs off the end of a playable rig.
 *
 * `AnimationData.Fallback` walks *downhill*, towards the generic, and it walks out of the family
 * almost at once: SpellCastArea (33) gives way to SpellCast (32), SpellCast to AttackUnarmed (16)
 * — which the boundary above correctly refuses — and SpellPrecast (31) to nothing at all. That is
 * serviceable for a creature, whose kits name those three because they *are* the old
 * undifferentiated cast poses, and it is useless for a player character, because a playable rig
 * carries none of 31/32/33. Measured on HumanMale's 241 sequences: no 31, no 32, no 33, and
 * 51/52/53/54/124/125 all present. So every SpellVisualKit row naming one of the three resolves to
 * nothing on every character in the game, and the unit simply stands there while the effect plays
 * — which is the "flat casts" the owner reports.
 *
 * The promotion is the missing uphill step, and it is a fixed table rather than data because the
 * DBC has no column for it: 31 (a generic precast) is what a rig calls ReadySpellOmni/Directed,
 * 32 and 33 (the cast itself, undirected and at a place) are SpellCastOmni/Directed, and the two
 * channel poses stand in for each other. Consulted only after the DBC chain has failed, so no
 * model that can answer a kit the authored way is ever moved off it, and every entry is still
 * filtered through what the template actually carries.
 */
const SPELL_ANIMATION_PROMOTION: ReadonlyMap<number, readonly number[]> = new Map([
  [SpellPrecast, [ReadySpellOmni, ReadySpellDirected]],
  [SpellCast, [SpellCastOmni, SpellCastDirected]],
  [SpellCastArea, [SpellCastOmni, SpellCastDirected]],
  [ChannelCastDirected, [ChannelCastOmni, SpellCastDirected, ReadySpellDirected]],
  [ChannelCastOmni, [ChannelCastDirected, SpellCastOmni, ReadySpellOmni]],
  // The flying twins, for a rig that has them: a druid in flight form and every winged creature
  // that carries the 260/280/353 block instead of the standing one.
  [FlySpellPrecast, [FlyReadySpellOmni, FlyReadySpellDirected, ReadySpellOmni]],
  [FlySpellCast, [FlySpellCastOmni, FlySpellCastDirected, SpellCastOmni]],
  [FlySpellCastArea, [FlySpellCastOmni, FlySpellCastDirected, SpellCastOmni]],
  [FlyChannelCastDirected, [FlyChannelCastOmni, FlySpellCastDirected, ChannelCastDirected]],
  [FlyChannelCastOmni, [FlyChannelCastDirected, FlySpellCastOmni, ChannelCastOmni]],
]);

/**
 * Resolves a SpellVisualKit-authored unit animation while stopping at the spell-family boundary.
 * For example SpellCastOmni may use SpellCastArea/SpellCast, but never AttackUnarmed.
 *
 * Anim id 0 is deliberately not part of any of this: 327 kits name it, it is not a spell-family
 * row, and it goes through the general resolver to Stand exactly as before.
 */
export function resolveSpellVisualAnimation(
  available: ReadonlySet<number> | Map<number, unknown>,
  wanted: Iterable<number>,
): number | undefined {
  const requested: number[] = [];
  for (const start of wanted) {
    requested.push(start);
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
  // Only now, and in the order the kit asked in: standing there is the alternative.
  for (const start of requested) {
    for (const promoted of SPELL_ANIMATION_PROMOTION.get(start) ?? []) {
      if (available.has(promoted)) return promoted;
    }
  }
  return undefined;
}

/**
 * Every id a spell kit's request could end up playing, so the pose can actually be fetched.
 *
 * Deliberately flat and deliberately not what {@link resolveSpellVisualAnimation} walks: that one
 * has to try the whole DBC chain of every wanted id before any promotion, or a creature would be
 * moved off the pose its kit names. This is the other question — "which keyframes might this
 * request need?" — and the answer to it is a set, which is exactly what `needsSidecarAnimations`
 * wants. Without it a character whose sidecar has not been fetched yet would be *promised* a
 * promoted cast (its animation table claims 52) that nothing would ever ask the gateway for, and
 * the pending action would sit out its whole wait window and then be dropped.
 */
export function spellVisualAnimationCandidates(wanted: Iterable<number>): number[] {
  const candidates: number[] = [];
  for (const start of wanted) if (!candidates.includes(start)) candidates.push(start);
  for (const start of [...candidates]) {
    for (const promoted of SPELL_ANIMATION_PROMOTION.get(start) ?? []) {
      if (!candidates.includes(promoted)) candidates.push(promoted);
    }
  }
  return candidates;
}

/** The animation to play, out of what the model actually carries. */
export function chooseAnimation(clips: Map<number, THREE.AnimationClip>, pose: UnitPose): { animation: number; loop: boolean } | undefined {
  const { wanted, loop } = poseAnimation(pose);
  // A seat request stays in the seat family and a crouch request in the crouch family until its
  // own rows are exhausted; everything else walks the DBC chain as it always has. Drawing and
  // fetching ask the same question of the same list — `poseAnimationFamily`.
  const family = poseAnimationFamily(pose);
  const animation = family === "mount"
    ? resolveMountedRiderAnimation(clips, wanted)
    : family === "stealth" ? resolveStealthAnimation(clips, wanted)
      : resolveAnimation(clips, wanted);
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
    && (skeleton.animations.length > 0 || skeleton.clips.length > 0
      || (skeleton.globalChannels?.length ?? 0) > 0);
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
  /**
   * Whether this rig's sidecar is queued, on the wire, or resident but still compiling.
   *
   * The ordinary 900 ms wait is sized for the 21 clips that travel inside a model, not for the
   * thing actually being waited for. Measured on this machine's gateway, HumanMale's sidecar is
   * 9,833,124 bytes and costs 36.0 ms to fetch plus 46.7 ms to decode into 182 clips once the
   * artifact is published — but the *first* request for one publishes it, the model beside it
   * measured 508.6 ms cold, and there are two animation lanes for every rig on screen. So the
   * ordinary window is enough on a warm localhost and is not a guarantee anywhere else, and an
   * action dropped while its own download is in progress is the one failure with no upside.
   * A decoded sidecar also needs bounded clip compilation over later frames. The same deadline
   * covers that pending work; it is used only while fetch or compilation is active.
   */
  sidecarInFlight?: boolean;
  now: number;
  /** When the wait runs out. A gesture a second late is worse than one that did not happen. */
  waitUntil: number;
  /** The bounded larger deadline for an active sidecar fetch or clip compilation. */
  sidecarWaitUntil?: number;
}): "play" | "wait" | "drop" {
  if (options.hasClip) return "play";
  if ((options.promised || options.metadataPending) && options.now < options.waitUntil) return "wait";
  // Only for a pose the model itself claims: a sidecar in flight says nothing about an animation
  // this rig does not have, and waiting for it would be waiting for something that is not coming.
  if (options.sidecarInFlight === true && options.promised
    && options.sidecarWaitUntil !== undefined && options.now < options.sidecarWaitUntil) return "wait";
  return "drop";
}

/**
 * How long an action may wait while its promised keyframes are fetched or compiled.
 *
 * Three seconds is the outer edge of a reaction, not a comfortable margin: an action that has not
 * played by then is a surprise rather than a response, and it is still a bound — it applies only
 * while the request is really outstanding, and `pendingActionExpired` retires a stale shoot at its
 * own window regardless.
 */
export const ACTION_SIDECAR_WAIT = 3_000;

/** A one-shot shoot that outlived its metadata window must not start even if its clip arrives late. */
export function pendingActionExpired(
  action: UnitAction | undefined,
  holding: boolean,
  now: number,
  waitUntil: number,
): boolean {
  return action === "shoot" && !holding && now >= waitUntil;
}

/** Shoot metadata may arrive after the ordinary 900 ms sidecar-animation window, but never forever. */
export const SHOOT_METADATA_WAIT = 1_500;
