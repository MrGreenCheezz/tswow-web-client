import * as THREE from "three";
import {
  BONE_ANY_BILLBOARD, BONE_CYLINDRICAL_BILLBOARD_X, BONE_CYLINDRICAL_BILLBOARD_Y, BONE_SPHERICAL_BILLBOARD,
} from "./Wvm.js";

/**
 * A crowd rig's pose without Three's per-bone object work.
 *
 * `AnimationMixer.update` evaluates every track of every bone, writes each result into an
 * `Object3D`, and the scene pass then composes and multiplies every bone again. For an ordinary
 * NPC most of that is spent on bones nothing reads: HumanMale carries 228 and its drawn geosets
 * are weighted to about a hundred. This path keeps Three's own clock, interpolants and blending
 * arithmetic — the action time/weight updates and `PropertyMixer.accumulate` run unchanged, and
 * the `apply` step is reproduced minus the scene-graph write — but only for the bones a program
 * names, and composes their hierarchy in flat arrays in parent order, the way the reference client
 * does (`wowee/src/rendering/character_renderer.cpp`, `calculateBoneMatrices`).
 *
 * The result is each named bone's matrix relative to the rig root, in Three's own composition
 * formulas, so `root.matrixWorld × model` is the bone's world matrix.
 */

/** Which bones a fast pose computes. Fixed per rig geometry and attachment table. */
export interface FastPoseProgram {
  readonly boneCount: number;
  readonly parents: Int16Array;
  /** 1 for every bone computed; closed under ancestors. */
  readonly evaluated: Uint8Array;
  /** The computed bones, every parent before its children. */
  readonly order: Int32Array;
  /** Billboard flags per computed bone (0 elsewhere). */
  readonly billboardFlags: Uint16Array;
}

/** Property index within a bone's three animated properties. */
const POSITION = 0;
const QUATERNION = 1;
const SCALE = 2;

/**
 * The program for a rig: the bones its drawn geometry or its attachment points depend on, plus
 * their ancestors. Undefined when the rig cannot be described this way (no bones).
 */
export function createFastPoseProgram(
  parents: Int16Array,
  flags: Uint16Array,
  required: Iterable<number>,
): FastPoseProgram | undefined {
  const boneCount = parents.length;
  if (boneCount === 0) return undefined;
  const evaluated = new Uint8Array(boneCount);
  for (const bone of required) {
    for (let at = bone; at >= 0 && at < boneCount && evaluated[at] !== 1; at = parents[at]!) evaluated[at] = 1;
  }
  // Parents first, whatever order the file lists them in: depth-first from every root.
  const children: number[][] = Array.from({ length: boneCount }, () => []);
  const roots: number[] = [];
  for (let bone = 0; bone < boneCount; bone++) {
    const parent = parents[bone]!;
    if (parent >= 0 && parent < boneCount) children[parent]!.push(bone);
    else roots.push(bone);
  }
  const order: number[] = [];
  const stack = roots.reverse();
  while (stack.length > 0) {
    const bone = stack.pop()!;
    if (evaluated[bone] !== 1) continue;
    order.push(bone);
    const below = children[bone]!;
    for (let index = below.length - 1; index >= 0; index--) stack.push(below[index]!);
  }
  const billboardFlags = new Uint16Array(boneCount);
  for (const bone of order) billboardFlags[bone] = (flags[bone] ?? 0) & BONE_ANY_BILLBOARD;
  return { boneCount, parents, evaluated, order: Int32Array.from(order), billboardFlags };
}

/** The Three r185 internals this path reads; all are plain fields/methods on the prototypes. */
interface InternalPropertyMixer {
  binding: { node: THREE.Object3D | undefined; parsedPath: { propertyName: string } };
  buffer: Float64Array;
  valueSize: number;
  cumulativeWeight: number;
  cumulativeWeightAdditive: number;
  _origIndex: number;
  _mixBufferRegion(buffer: Float64Array, dstOffset: number, srcOffset: number, t: number, stride: number): void;
  accumulate(accuIndex: number, weight: number): void;
  /** This path's cache: the property slot of the bound bone, or -1 when not computed here. */
  fastPoseSlot?: number;
  fastPoseProgram?: FastPoseProgram;
}
interface InternalInterpolant { evaluate(time: number): unknown }
interface InternalAction {
  enabled: boolean;
  blendMode: THREE.AnimationBlendMode;
  _startTime: number | null;
  _interpolants: InternalInterpolant[];
  _propertyBindings: InternalPropertyMixer[];
  _updateTimeScale(time: number): number;
  _updateTime(deltaTime: number): number;
  _updateWeight(time: number): number;
}
interface InternalMixer {
  time: number;
  timeScale: number;
  _accuIndex: number;
  _actions: InternalAction[];
  _nActiveActions: number;
  _bindings: InternalPropertyMixer[];
  _nActiveBindings: number;
}

/** Bone index of a rig bone, set by the rig that owns it. */
interface IndexedBone extends THREE.Object3D { rigIndex?: number }

/** One rig's fast pose: its program and the matrices of the computed bones, relative to the root. */
export class FastPoseState {
  readonly program: FastPoseProgram;
  /** Column-major 4x4 per bone, root-relative. Rows of bones not computed are stale. */
  readonly model: Float64Array;
  /** Local position (3), quaternion (4) and scale (3) per bone. */
  readonly local: Float64Array;
  /** Bumped whenever `model` changes, so an unchanged pose can reuse its palette. */
  version = 0;
  readonly #bones: readonly THREE.Object3D[];
  // Scratch for one step: the actions that contributed and their clip times and weights.
  #stepActions: InternalAction[] = [];
  #stepTimes: number[] = [];
  #stepWeights: number[] = [];
  /** The mixer's active bindings when the bone objects were last read into `local`. */
  #readBindings: InternalPropertyMixer[] = [];
  #bonesRead = false;

  constructor(program: FastPoseProgram, bones: readonly THREE.Object3D[]) {
    this.program = program;
    this.#bones = bones;
    this.model = new Float64Array(program.boneCount * 16);
    this.local = new Float64Array(program.boneCount * 10);
  }

  /**
   * Whether the mixer's current actions can be posed here. Additive layers are blended through
   * a separate buffer this path does not reproduce, so they keep the ordinary mixer.
   */
  static supports(mixer: THREE.AnimationMixer): boolean {
    const internal = mixer as unknown as InternalMixer;
    for (let index = 0; index < internal._nActiveActions; index++) {
      if (internal._actions[index]!.blendMode !== THREE.NormalAnimationBlendMode) return false;
    }
    return true;
  }

  /**
   * Advances the mixer by `deltaTime` exactly as `AnimationMixer.update` would, leaving the
   * blended local transforms of the program's bones in `local`. The caller has checked `supports`;
   * it then writes what Three's path applies after the mixer — the global-sequence channels, see
   * `writeGlobalSequenceLocals` — and calls `compose`.
   */
  advance(mixer: THREE.AnimationMixer, deltaTime: number): void {
    const internal = mixer as unknown as InternalMixer;
    const program = this.program;
    // --- AnimationMixer.update / AnimationAction._update, minus track evaluation.
    deltaTime *= internal.timeScale;
    const actions = internal._actions;
    const activeActions = internal._nActiveActions;
    const time = internal.time += deltaTime;
    const timeDirection = Math.sign(deltaTime);
    const accuIndex = internal._accuIndex ^= 1;
    const stepActions = this.#stepActions, stepTimes = this.#stepTimes, stepWeights = this.#stepWeights;
    stepActions.length = 0; stepTimes.length = 0; stepWeights.length = 0;
    for (let index = 0; index !== activeActions; ++index) {
      const action = actions[index]!;
      if (!action.enabled) {
        action._updateWeight(time);
        continue;
      }
      let actionDelta = deltaTime;
      const startTime = action._startTime;
      if (startTime !== null) {
        const timeRunning = (time - startTime) * timeDirection;
        if (timeRunning < 0 || timeDirection === 0) actionDelta = 0;
        else {
          action._startTime = null;
          actionDelta = timeDirection * timeRunning;
        }
      }
      actionDelta *= action._updateTimeScale(time);
      const clipTime = action._updateTime(actionDelta);
      const weight = action._updateWeight(time);
      if (weight > 0) {
        stepActions.push(action);
        stepTimes.push(clipTime);
        stepWeights.push(weight);
      }
    }
    // --- The same evaluation and accumulation, for the tracks of computed bones only.
    for (let index = 0; index < stepActions.length; index++) {
      const action = stepActions[index]!;
      const clipTime = stepTimes[index]!, weight = stepWeights[index]!;
      const interpolants = action._interpolants, bindings = action._propertyBindings;
      for (let track = 0, count = interpolants.length; track !== count; ++track) {
        const binding = bindings[track]!;
        if (this.#slot(binding) < 0) continue;
        interpolants[track]!.evaluate(clipTime);
        binding.accumulate(accuIndex, weight);
      }
    }
    // --- Local transforms: the bones' own values, then what the mixer would apply to them.
    // A property no active binding drives keeps its bone object's value, and while this pose is
    // in use nothing but the mixer writes those objects: a binding that goes inactive restores its
    // original there. So they are read again only when the set of active bindings changes, or
    // after Three's own path has run (`rereadBones`); reading 150 scattered bones a frame is most
    // of what this step would otherwise cost.
    const local = this.local;
    const bones = this.#bones;
    const mixerBindings = internal._bindings;
    if (this.#bindingsChanged(mixerBindings, internal._nActiveBindings) || !this.#bonesRead) {
      this.#bonesRead = true;
      const order = program.order;
      for (let at = 0; at < order.length; at++) {
        const bone = order[at]!;
        const object = bones[bone]!;
        const offset = bone * 10;
        local[offset] = object.position.x; local[offset + 1] = object.position.y; local[offset + 2] = object.position.z;
        local[offset + 3] = object.quaternion.x; local[offset + 4] = object.quaternion.y;
        local[offset + 5] = object.quaternion.z; local[offset + 6] = object.quaternion.w;
        local[offset + 7] = object.scale.x; local[offset + 8] = object.scale.y; local[offset + 9] = object.scale.z;
      }
    }
    for (let index = 0, count = internal._nActiveBindings; index !== count; ++index) {
      const binding = mixerBindings[index]!;
      const slot = this.#slot(binding);
      if (slot < 0) continue;
      // PropertyMixer.apply, without the scene-graph write.
      const stride = binding.valueSize, buffer = binding.buffer, offset = accuIndex * stride + stride;
      const weight = binding.cumulativeWeight;
      binding.cumulativeWeight = 0;
      binding.cumulativeWeightAdditive = 0;
      if (weight < 1) binding._mixBufferRegion(buffer, offset, stride * binding._origIndex, 1 - weight, stride);
      const bone = (slot / 3) | 0, property = slot - bone * 3;
      const target = bone * 10 + (property === POSITION ? 0 : property === QUATERNION ? 3 : 7);
      for (let component = 0; component < stride; component++) local[target + component] = buffer[offset + component]!;
    }
  }

  /**
   * Composes `local` into `model`, parents first, and turns billboard bones to `camera` from where
   * `root` stands this frame.
   */
  compose(root: THREE.Object3D, camera: THREE.Object3D | undefined): void {
    this.#composeHierarchy(root, camera);
    this.version++;
  }

  /** Writes `root.matrixWorld × model[bone]` into `target`; false when the bone is not computed. */
  boneWorld(bone: number, rootWorld: THREE.Matrix4, target: THREE.Matrix4): boolean {
    if (this.program.evaluated[bone] !== 1) return false;
    multiplyInto(target.elements, 0, rootWorld.elements, 0, this.model, bone * 16);
    return true;
  }

  /** The bone objects were written outside this pose; read them again on the next step. */
  rereadBones(): void {
    this.#bonesRead = false;
  }

  /** The active bindings `local` was last read against, for a pose taking over from this one. */
  get readBindings(): readonly unknown[] | undefined {
    return this.#bonesRead ? this.#readBindings : undefined;
  }

  /**
   * Continues from another flat pose of the same rig (the crowd pose worker's, `PoseEngine.ts`):
   * its local transforms and the binding set they were read against, as if this pose had made the
   * steps itself. Undefined bindings mean that pose had not read the bones yet.
   */
  adopt(local: Float64Array, readBindings: readonly unknown[] | undefined): void {
    this.local.set(local);
    if (readBindings === undefined) { this.#bonesRead = false; return; }
    this.#readBindings = readBindings.slice() as InternalPropertyMixer[];
    this.#bonesRead = true;
  }

  /** Whether the mixer's active bindings differ from the last read, remembering the new set. */
  #bindingsChanged(bindings: readonly InternalPropertyMixer[], active: number): boolean {
    const read = this.#readBindings;
    let changed = read.length !== active;
    for (let index = 0; !changed && index < active; index++) changed = read[index] !== bindings[index];
    if (!changed) return false;
    read.length = active;
    for (let index = 0; index < active; index++) read[index] = bindings[index]!;
    return true;
  }

  #slot(binding: InternalPropertyMixer): number {
    if (binding.fastPoseProgram === this.program && binding.fastPoseSlot !== undefined) return binding.fastPoseSlot;
    const node = binding.binding.node as IndexedBone | undefined;
    const bone = node?.rigIndex;
    const name = binding.binding.parsedPath.propertyName;
    const property = name === "position" ? POSITION : name === "quaternion" ? QUATERNION : name === "scale" ? SCALE : -1;
    const slot = bone !== undefined && property >= 0 && this.#bones[bone] === node
      && this.program.evaluated[bone] === 1 ? bone * 3 + property : -1;
    binding.fastPoseProgram = this.program;
    binding.fastPoseSlot = slot;
    return slot;
  }

  #composeHierarchy(root: THREE.Object3D, camera: THREE.Object3D | undefined): void {
    const { order, parents, billboardFlags } = this.program;
    const local = this.local, model = this.model;
    let rootRefreshed = false;
    for (let at = 0; at < order.length; at++) {
      const bone = order[at]!;
      const parent = parents[bone]!;
      composeInto(_localMatrix, local, bone * 10);
      if (parent >= 0) multiplyInto(model, bone * 16, model, parent * 16, _localMatrix, 0);
      else model.set(_localMatrix, bone * 16);
      const flags = billboardFlags[bone]!;
      if (flags === 0 || camera === undefined) continue;
      if (!rootRefreshed) {
        // A billboard faces the camera in the world, so it needs where the rig stands this frame.
        root.updateWorldMatrix(true, false);
        rootRefreshed = true;
      }
      this.#billboard(bone, parent, flags, root.matrixWorld, camera);
    }
  }

  /** `applyBillboardBones` for one bone, on the flat pose; see that function for the rule. */
  #billboard(bone: number, parent: number, flags: number, rootWorld: THREE.Matrix4, camera: THREE.Object3D): void {
    const view = camera.matrixWorld.elements;
    const right = _right.set(view[0]!, view[1]!, view[2]!).normalize();
    const up = _up.set(view[4]!, view[5]!, view[6]!).normalize();
    const axisY = _axisY.copy(up);
    const axisZ = _axisZ.copy(right).negate();
    const axisX = _axisX.crossVectors(axisY, axisZ);
    if (axisX.lengthSq() < 1e-8) return;
    axisX.normalize();
    axisY.crossVectors(axisZ, axisX).normalize();
    if ((flags & BONE_SPHERICAL_BILLBOARD) === 0) {
      const pinned = (flags & BONE_CYLINDRICAL_BILLBOARD_X) !== 0 ? 0
        : (flags & BONE_CYLINDRICAL_BILLBOARD_Y) !== 0 ? 1 : 2;
      // The bone's own animated world axis, as applyBillboardBones reads it off matrixWorld.
      multiplyInto(_worldMatrix.elements, 0, rootWorld.elements, 0, this.model, bone * 16);
      _pinned.setFromMatrixColumn(_worldMatrix, pinned).normalize();
      const columns = [axisX, axisY, axisZ];
      const next = columns[(pinned + 1) % 3]!;
      const last = columns[(pinned + 2) % 3]!;
      next.addScaledVector(_pinned, -next.dot(_pinned));
      if (next.lengthSq() < 1e-8) return;
      next.normalize();
      last.crossVectors(_pinned, next);
      columns[pinned]!.copy(_pinned);
    }
    _basis.makeBasis(axisX, axisY, axisZ);
    _world.setFromRotationMatrix(_basis);
    const offset = bone * 10;
    if (parent >= 0) {
      multiplyInto(_worldMatrix.elements, 0, rootWorld.elements, 0, this.model, parent * 16);
    } else {
      _worldMatrix.copy(rootWorld);
    }
    _worldMatrix.decompose(_position, _parent, _scale);
    _parent.invert().multiply(_world);
    this.local[offset + 3] = _parent.x; this.local[offset + 4] = _parent.y;
    this.local[offset + 5] = _parent.z; this.local[offset + 6] = _parent.w;
    composeInto(_localMatrix, this.local, offset);
    if (parent >= 0) multiplyInto(this.model, bone * 16, this.model, parent * 16, _localMatrix, 0);
    else this.model.set(_localMatrix, bone * 16);
  }
}

/**
 * Makes the next ordinary `AnimationMixer.update` write every bound property to its bone again.
 *
 * `PropertyMixer.apply` skips the scene-graph write when the accumulated value equals the previous
 * frame's, and the fast path advances those buffers without writing the bones. A large finite
 * marker in both accumulation slots makes the comparison fail once; it is finite because an
 * unweighted binding mixes its original value into a slot with t = 1, i.e. `slot * 0 + original`.
 */
export function invalidateMixerApply(mixer: THREE.AnimationMixer): void {
  const internal = mixer as unknown as InternalMixer;
  for (let index = 0; index < internal._nActiveBindings; index++) {
    const binding = internal._bindings[index]!;
    const stride = binding.valueSize;
    binding.buffer[stride] = STALE_MARKER;
    binding.buffer[stride + stride] = STALE_MARKER;
  }
}
const STALE_MARKER = 1e30;

/** `Matrix4.compose`, from a local transform stored as position(3) quaternion(4) scale(3). */
function composeInto(te: Float64Array, local: Float64Array, offset: number): void {
  const x = local[offset + 3]!, y = local[offset + 4]!, z = local[offset + 5]!, w = local[offset + 6]!;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = local[offset + 7]!, sy = local[offset + 8]!, sz = local[offset + 9]!;
  te[0] = (1 - (yy + zz)) * sx; te[1] = (xy + wz) * sx; te[2] = (xz - wy) * sx; te[3] = 0;
  te[4] = (xy - wz) * sy; te[5] = (1 - (xx + zz)) * sy; te[6] = (yz + wx) * sy; te[7] = 0;
  te[8] = (xz + wy) * sz; te[9] = (yz - wx) * sz; te[10] = (1 - (xx + yy)) * sz; te[11] = 0;
  te[12] = local[offset]!; te[13] = local[offset + 1]!; te[14] = local[offset + 2]!; te[15] = 1;
}

/** `Matrix4.multiplyMatrices(a, b)` over flat column-major arrays. */
function multiplyInto(
  te: Float64Array | number[], to: number,
  ae: Float64Array | number[], ao: number,
  be: Float64Array | number[], bo: number,
): void {
  const a11 = ae[ao]!, a12 = ae[ao + 4]!, a13 = ae[ao + 8]!, a14 = ae[ao + 12]!;
  const a21 = ae[ao + 1]!, a22 = ae[ao + 5]!, a23 = ae[ao + 9]!, a24 = ae[ao + 13]!;
  const a31 = ae[ao + 2]!, a32 = ae[ao + 6]!, a33 = ae[ao + 10]!, a34 = ae[ao + 14]!;
  const a41 = ae[ao + 3]!, a42 = ae[ao + 7]!, a43 = ae[ao + 11]!, a44 = ae[ao + 15]!;
  const b11 = be[bo]!, b12 = be[bo + 4]!, b13 = be[bo + 8]!, b14 = be[bo + 12]!;
  const b21 = be[bo + 1]!, b22 = be[bo + 5]!, b23 = be[bo + 9]!, b24 = be[bo + 13]!;
  const b31 = be[bo + 2]!, b32 = be[bo + 6]!, b33 = be[bo + 10]!, b34 = be[bo + 14]!;
  const b41 = be[bo + 3]!, b42 = be[bo + 7]!, b43 = be[bo + 11]!, b44 = be[bo + 15]!;
  te[to] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
  te[to + 4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
  te[to + 8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
  te[to + 12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
  te[to + 1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
  te[to + 5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
  te[to + 9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
  te[to + 13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
  te[to + 2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
  te[to + 6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
  te[to + 10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
  te[to + 14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
  te[to + 3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
  te[to + 7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
  te[to + 11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
  te[to + 15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
}

export { multiplyInto as multiplyFlatMatrices, composeInto as composeFlatLocal };

const _localMatrix = new Float64Array(16);
const _worldMatrix = new THREE.Matrix4();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _axisZ = new THREE.Vector3();
const _pinned = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _world = new THREE.Quaternion();
const _parent = new THREE.Quaternion();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
