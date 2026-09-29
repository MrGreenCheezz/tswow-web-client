import * as THREE from "three";
import { composeFlatLocal, multiplyFlatMatrices } from "./FastPose.js";
import {
  BONE_CYLINDRICAL_BILLBOARD_X, BONE_CYLINDRICAL_BILLBOARD_Y, BONE_SPHERICAL_BILLBOARD,
} from "./Wvm.js";

/**
 * The crowd pose worker's arithmetic: the part of a flat pose (`FastPoseState`) that needs no Three
 * object — track evaluation, the mixer's blending, global sequences, hierarchy composition,
 * billboards and the skinning palette — over one SharedArrayBuffer that the page and its pose
 * worker(s) both see. The same code runs on the worker and, for a job the worker has not reached
 * (or is late with), on the main thread, so either way the result is the same bytes.
 *
 * Every formula here is the one `FastPoseState`, `writeGlobalSequenceLocals` and
 * `RigSkeleton.update` use, in the same order: Three's `Interpolant.evaluate`, its linear and
 * quaternion interpolants, `PropertyMixer.accumulate`/`apply`, `Quaternion.slerpFlat`. One case is
 * approximated, see `computePoseJob`: an active binding no action drives this step.
 *
 * Addresses are 8-byte words into the arena; an i32 or f32 index is twice its word.
 */

/** Fixed, not growable: WebGL refuses a resizable view, and palettes are uploaded from here. */
export const POSE_ARENA_BYTES = 64 * 1024 * 1024;
export const POSE_MAX_WORKERS = 4;
/** Actions blended into one pose; a mixer with more active actions stays on the main thread. */
export const POSE_MAX_ACTIONS = 8;
export const POSE_JOB_CAPACITY = 256;
export const POSE_JOB_WORDS = 64;

// Control block, i32 indices from 0.
export const CTRL_SEQ = 0;
export const CTRL_PUBLISHED = 1;
export const CTRL_SLEEPING = 2;
export const CTRL_READY = 3;
export const CTRL_STOP = 4;
export const CTRL_BATCH = 5;
export const CTRL_FAILED = 6;
export const CTRL_JOBS = 7;
export const CTRL_WORKER_JOBS = 8;
/** One per worker: the job it is computing, or -1. */
export const CTRL_BUSY = 16;
export const CTRL_WORDS = 16;

// Job states.
export const JOB_IDLE = 0;
export const JOB_PENDING = 1;
export const JOB_WORKER = 2;
export const JOB_MAIN = 3;
export const JOB_DONE_WORKER = 4;
export const JOB_DONE_MAIN = 5;
export const JOB_FAILED = 6;

/** Who computes a job; also which model/local area it writes. */
export const ROLE_WORKER = 0;
export const ROLE_MAIN = 1;

// Job record: i32 fields from twice its word, f64 fields from its word.
export const JOB_STATE = 0;
export const JOB_RIG = 1;
export const JOB_ACTIONS = 2;
export const JOB_FLAGS = 3;
export const JOB_GLOBALS = 4;
export const JOB_SEQUENCES = 5;
export const JOB_LOCAL = 6;
export const JOB_SERIAL = 7;
export const JOB_CLIPS = 8;
export const JOB_NOW = 8;
export const JOB_ROOT = 9;
export const JOB_CAMERA = 25;
export const JOB_TIMES = 41;
export const JOB_WEIGHTS = 49;
export const JOB_FLAG_CAMERA = 1;
export const JOB_FLAG_PALETTE = 2;

// Rig block header, i32 from twice its word.
export const RIG_BONES = 0;
export const RIG_PROGRAM = 1;
export const RIG_TEMPLATE = 2;
export const RIG_PALETTE_LIST = 3;
export const RIG_PALETTE_COUNT = 4;
export const RIG_ACTIVE_COUNT = 5;
export const RIG_ACTIVE = 6;
export const RIG_ORIGINALS = 7;
/** Three local areas: the current one, and one each for the worker and the main thread to write. */
export const RIG_LOCAL = 8;
/** Two model areas, by role. */
export const RIG_MODEL = 11;
/** f32 index of the palette the skeleton uploads (its bone texture's data), or 0 for none. */
export const RIG_PALETTE = 13;
export const RIG_HEADER_WORDS = 8;

// Program block: i32 bone count, order count, then order, parents, evaluated and billboard flags.
export const PROGRAM_BONES = 0;
export const PROGRAM_ORDER_COUNT = 1;
export const PROGRAM_DATA = 2;

// Bind block: f64 bind inverses, 16 per bone, from its word.
// Global table: i32 count, then per channel bone, kind, sequence, interpolation, times f32 index,
// time count, values f32 index, value count (4 words each), then f64 pivots, 3 per bone.
export const GLOBAL_FIELDS = 8;
/** Word of a global table's pivots. */
export function globalPivotsWord(i32: Int32Array, table: number): number {
  return table + 1 + i32[table * 2]! * (GLOBAL_FIELDS / 2);
}
// Clip block: i32 track count, then per track bone, property, stride, key count, times f32 index,
// values f32 index.
export const TRACK_FIELDS = 6;

/** `Quaternion.slerpFlat`, typed for the flat arrays it is used with here (its types say number[]). */
const slerpFlat = THREE.Quaternion.slerpFlat as unknown as (
  dst: Float64Array, dstOffset: number, src0: Float64Array | Float32Array, srcOffset0: number,
  src1: Float64Array | Float32Array, srcOffset1: number, t: number) => void;

const PROPERTY_POSITION = 0;
const PROPERTY_QUATERNION = 1;

export interface PoseViews {
  readonly sab: SharedArrayBuffer;
  readonly i32: Int32Array;
  readonly f32: Float32Array;
  readonly f64: Float64Array;
}

export function poseViews(sab: SharedArrayBuffer): PoseViews {
  return { sab, i32: new Int32Array(sab), f32: new Float32Array(sab), f64: new Float64Array(sab) };
}

/** Per-thread working memory: the mixer's accumulators, by slot (bone * 3 + property). */
export class PoseScratch {
  accu = new Float64Array(0);
  weights = new Float64Array(0);
  /** Job serial that last wrote each slot's weight; any other serial reads as zero. */
  stamps = new Int32Array(0);
  readonly incoming = new Float64Array(4);
  serial = 0;

  ensure(slots: number): void {
    if (this.weights.length >= slots) return;
    const size = Math.max(slots, this.weights.length * 2);
    this.accu = new Float64Array(size * 4);
    this.weights = new Float64Array(size);
    this.stamps = new Int32Array(size);
  }
}

/**
 * `Interpolant.evaluate` for a linear or quaternion-linear track, into `out[0..stride)`.
 *
 * Three seeks from the interval it found last time; for ascending key times the interval, and so
 * the value, depends only on `t` (first key after `t`, or a clamped end), so this seeks from
 * scratch and gets the same numbers.
 */
export function evaluateTrack(
  f32: Float32Array, timesAt: number, valuesAt: number, keys: number, stride: number,
  quaternion: boolean, t: number, out: Float64Array,
): void {
  if (keys === 0) {
    // Three reads `values[-stride..]` here: undefined, so NaN.
    for (let component = 0; component < stride; component++) out[component] = NaN;
    return;
  }
  // First key strictly after t.
  let low = 0, high = keys;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (t < f32[timesAt + middle]!) high = middle;
    else low = middle + 1;
  }
  const i1 = low;
  if (i1 === 0 || i1 === keys) {
    // Before the first key or at/after the last: copySampleValue_.
    const offset = valuesAt + (i1 === 0 ? 0 : keys - 1) * stride;
    for (let component = 0; component < stride; component++) out[component] = f32[offset + component]!;
    return;
  }
  const t0 = f32[timesAt + i1 - 1]!, t1 = f32[timesAt + i1]!;
  if (quaternion) {
    const alpha = (t - t0) / (t1 - t0);
    const offset = valuesAt + i1 * stride;
    for (let at = offset, end = offset + stride; at !== end; at += 4) {
      slerpFlat(out, 0, f32, at - stride, f32, at, alpha);
    }
    return;
  }
  const offset1 = valuesAt + i1 * stride, offset0 = offset1 - stride;
  const weight1 = (t - t0) / (t1 - t0), weight0 = 1 - weight1;
  for (let component = 0; component < stride; component++) {
    out[component] = f32[offset0 + component]! * weight0 + f32[offset1 + component]! * weight1;
  }
}

/** Word of job `index` in the job table. */
export function jobWord(i32: Int32Array, index: number): number {
  return i32[CTRL_JOBS]! + index * POSE_JOB_WORDS;
}

/**
 * One pose step for one rig, as `FastPoseState.advance` (from the accumulation on) +
 * `writeGlobalSequenceLocals` + `compose` + `RigSkeleton.update` do it.
 *
 * The rig's current local transforms are read, never written: this role's own local area receives
 * the result, and its own model area the matrices, so a worker that is overtaken by the main thread
 * cannot disturb what the main thread writes. The palette (the skeleton's bone texture data) is the
 * one shared output; both roles write the same numbers into it from the same inputs.
 *
 * The approximation: Three mixes an active binding that no action drove this step from the value
 * that binding's accumulator held two steps ago, with weight 0 (`stale * 0 + original`, or a slerp
 * from it at t = 1). That is the original value — up to the sign of a zero, or for a quaternion its
 * sign (the same rotation, and the same matrix) or a renormalisation ulp. This writes the original.
 */
export function computePoseJob(views: PoseViews, index: number, role: number, scratch: PoseScratch): void {
  const { i32, f32, f64 } = views;
  const job = jobWord(i32, index), ji = job * 2;
  const rig = i32[ji + JOB_RIG]!, ri = rig * 2;
  const bones = i32[ri + RIG_BONES]!;
  const program = i32[ri + RIG_PROGRAM]! * 2;
  const orderCount = i32[program + PROGRAM_ORDER_COUNT]!;
  const orderAt = program + PROGRAM_DATA;
  const parentsAt = orderAt + orderCount;
  const evaluatedAt = parentsAt + bones;
  const flagsAt = evaluatedAt + bones;
  const current = i32[ji + JOB_LOCAL]!;
  const localIn = i32[ri + RIG_LOCAL + current]!;
  const local = i32[ri + RIG_LOCAL + (current + 1 + role) % 3]!;
  const model = i32[ri + RIG_MODEL + role]!;
  f64.copyWithin(local, localIn, localIn + bones * 10);

  // --- PropertyMixer.accumulate over every track of every contributing action, in mixer order.
  const slots = bones * 3;
  scratch.ensure(slots);
  const serial = scratch.serial = (scratch.serial + 1) | 0;
  const { accu, weights, stamps, incoming } = scratch;
  const actions = i32[ji + JOB_ACTIONS]!;
  for (let action = 0; action < actions; action++) {
    const clip = i32[ji + JOB_CLIPS + action]! * 2;
    const clipTime = f64[job + JOB_TIMES + action]!;
    const weight = f64[job + JOB_WEIGHTS + action]!;
    const tracks = i32[clip]!;
    for (let track = 0, field = clip + 2; track < tracks; track++, field += TRACK_FIELDS) {
      const bone = i32[field]!;
      if (bone >= bones || i32[evaluatedAt + bone] !== 1) continue;
      const property = i32[field + 1]!, stride = i32[field + 2]!;
      const quaternion = property === PROPERTY_QUATERNION;
      evaluateTrack(f32, i32[field + 4]!, i32[field + 5]!, i32[field + 3]!, stride, quaternion, clipTime, incoming);
      const slot = bone * 3 + property, at = slot * 4;
      let cumulative = stamps[slot] === serial ? weights[slot]! : 0;
      if (cumulative === 0) {
        for (let component = 0; component !== stride; ++component) accu[at + component] = incoming[component]!;
        cumulative = weight;
      } else {
        cumulative += weight;
        const mix = weight / cumulative;
        if (quaternion) slerpFlat(accu, at, accu, at, incoming, 0, mix);
        else {
          const keep = 1 - mix;
          for (let component = 0; component !== stride; ++component) {
            accu[at + component] = accu[at + component]! * keep + incoming[component]! * mix;
          }
        }
      }
      weights[slot] = cumulative;
      stamps[slot] = serial;
    }
  }

  // --- PropertyMixer.apply, minus the scene-graph write, for every active binding.
  const activeCount = i32[ri + RIG_ACTIVE_COUNT]!;
  const activeAt = i32[ri + RIG_ACTIVE]! * 2;
  const originals = i32[ri + RIG_ORIGINALS]!;
  for (let entry = 0; entry < activeCount; entry++) {
    const slot = i32[activeAt + entry]!;
    const bone = (slot / 3) | 0, property = slot - bone * 3;
    const quaternion = property === PROPERTY_QUATERNION;
    const stride = quaternion ? 4 : 3;
    const original = originals + slot * 4;
    const target = local + bone * 10 + (property === PROPERTY_POSITION ? 0 : quaternion ? 3 : 7);
    const weight = stamps[slot] === serial ? weights[slot]! : 0;
    if (weight === 0) {
      for (let component = 0; component < stride; component++) f64[target + component] = f64[original + component]!;
      continue;
    }
    const at = slot * 4;
    if (weight < 1) {
      const t = 1 - weight;
      if (quaternion) slerpFlat(accu, at, accu, at, f64, original, t);
      else {
        const keep = 1 - t;
        for (let component = 0; component !== stride; ++component) {
          accu[at + component] = accu[at + component]! * keep + f64[original + component]! * t;
        }
      }
    }
    for (let component = 0; component < stride; component++) f64[target + component] = accu[at + component]!;
  }

  // --- Global sequences have the last word over the clips (`writeGlobalSequenceLocals`).
  const globals = i32[ji + JOB_GLOBALS]!;
  if (globals !== 0) {
    writeGlobalLocals(views, globals * 2, i32[ji + JOB_SEQUENCES]!, f64[job + JOB_NOW]!,
      globalPivotsWord(i32, globals), parentsAt, evaluatedAt, bones, local);
  }

  // --- Hierarchy, parents first, and the billboards (`FastPoseState.compose`).
  const flags = i32[ji + JOB_FLAGS]!;
  const camera = (flags & JOB_FLAG_CAMERA) !== 0 ? job + JOB_CAMERA : -1;
  const root = job + JOB_ROOT;
  for (let at = 0; at < orderCount; at++) {
    const bone = i32[orderAt + at]!;
    const parent = i32[parentsAt + bone]!;
    composeFlatLocal(_localMatrix, f64, local + bone * 10);
    if (parent >= 0) multiplyFlatMatrices(f64, model + bone * 16, f64, model + parent * 16, _localMatrix, 0);
    else f64.set(_localMatrix, model + bone * 16);
    const billboard = i32[flagsAt + bone]!;
    if (billboard === 0 || camera < 0) continue;
    billboardBone(f64, bone, parent, billboard, root, camera, local, model);
  }

  // --- The palette: `RigSkeleton.update` for a flat pose, `root × model × bind inverse`.
  const palette = i32[ri + RIG_PALETTE]!;
  if ((flags & JOB_FLAG_PALETTE) !== 0 && palette !== 0) {
    const list = i32[ri + RIG_PALETTE_LIST]! * 2;
    const count = i32[ri + RIG_PALETTE_COUNT]!;
    const binds = i32[ri + RIG_TEMPLATE]!;
    const world = _rigWorld;
    for (let at = 0; at < count; at++) {
      const bone = i32[list + at]!;
      multiplyFlatMatrices(world, 0, f64, root, f64, model + bone * 16);
      const bind = binds + bone * 16;
      const offset = palette + bone * 16;
      if (f64[bind] === 1 && f64[bind + 5] === 1 && f64[bind + 10] === 1 && f64[bind + 15] === 1
        && f64[bind + 1] === 0 && f64[bind + 2] === 0 && f64[bind + 3] === 0 && f64[bind + 4] === 0
        && f64[bind + 6] === 0 && f64[bind + 7] === 0 && f64[bind + 8] === 0 && f64[bind + 9] === 0 && f64[bind + 11] === 0) {
        const x = f64[bind + 12]!, y = f64[bind + 13]!, z = f64[bind + 14]!;
        f32[offset] = world[0]!;
        f32[offset + 1] = world[1]!;
        f32[offset + 2] = world[2]!;
        f32[offset + 3] = world[3]!;
        f32[offset + 4] = world[4]!;
        f32[offset + 5] = world[5]!;
        f32[offset + 6] = world[6]!;
        f32[offset + 7] = world[7]!;
        f32[offset + 8] = world[8]!;
        f32[offset + 9] = world[9]!;
        f32[offset + 10] = world[10]!;
        f32[offset + 11] = world[11]!;
        f32[offset + 12] = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!;
        f32[offset + 13] = world[1]! * x + world[5]! * y + world[9]! * z + world[13]!;
        f32[offset + 14] = world[2]! * x + world[6]! * y + world[10]! * z + world[14]!;
        f32[offset + 15] = world[3]! * x + world[7]! * y + world[11]! * z + world[15]!;
      } else {
        _bind.fromArray(f64, bind);
        _rigOffset.fromArray(world).multiply(_bind).toArray(f32, offset);
      }
    }
  }
}

/** `writeGlobalSequenceLocals` / `sampleGlobalChannel` over the arena. */
function writeGlobalLocals(
  views: PoseViews, table: number, sequences: number, worldMs: number, pivots: number,
  parentsAt: number, evaluatedAt: number, bones: number, local: number,
): void {
  const { i32, f32, f64 } = views;
  const channels = i32[table]!;
  const sequenceCount = sequences === 0 ? 0 : i32[sequences * 2]!;
  for (let channel = 0, field = table + 2; channel < channels; channel++, field += GLOBAL_FIELDS) {
    const bone = i32[field]!;
    if (bone < 0 || bone >= bones || i32[evaluatedAt + bone] !== 1) continue;
    const keys = i32[field + 5]!;
    if (keys === 0) continue;
    const kind = i32[field + 1]!, sequence = i32[field + 2]!, interpolation = i32[field + 3]!;
    const timesAt = i32[field + 4]!, valuesAt = i32[field + 6]!, valueCount = i32[field + 7]!;
    const duration = sequence >= 0 && sequence < sequenceCount ? f64[sequences + 1 + sequence]! : 0;
    const clockMs = duration > 0 ? ((worldMs % duration) + duration) % duration : Math.max(0, worldMs);
    keyWindow(f32, timesAt, keys, clockMs / 1000, interpolation);
    const left = _left, right = _right, mix = _mix;
    const offset = local + bone * 10 + (kind === 0 ? 0 : kind === 1 ? 3 : 7);
    if (kind === 1) {
      _quaternionA.fromArray(f32, valuesAt + left * 4).normalize();
      if (right !== left) {
        _quaternionB.fromArray(f32, valuesAt + right * 4).normalize();
        _quaternionA.slerp(_quaternionB, mix).normalize();
      }
      f64[offset] = _quaternionA.x;
      f64[offset + 1] = _quaternionA.y;
      f64[offset + 2] = _quaternionA.z;
      f64[offset + 3] = _quaternionA.w;
      continue;
    }
    const x = globalValue(f32, valuesAt, valueCount, left, right, mix, 0);
    const y = globalValue(f32, valuesAt, valueCount, left, right, mix, 1);
    const z = globalValue(f32, valuesAt, valueCount, left, right, mix, 2);
    if (kind === 2) {
      f64[offset] = x; f64[offset + 1] = y; f64[offset + 2] = z;
      continue;
    }
    const parent = i32[parentsAt + bone]!;
    f64[offset] = f64[pivots + bone * 3]! - (parent >= 0 ? f64[pivots + parent * 3]! : 0) + x;
    f64[offset + 1] = f64[pivots + bone * 3 + 1]! - (parent >= 0 ? f64[pivots + parent * 3 + 1]! : 0) + y;
    f64[offset + 2] = f64[pivots + bone * 3 + 2]! - (parent >= 0 ? f64[pivots + parent * 3 + 2]! : 0) + z;
  }
}

let _left = 0;
let _right = 0;
let _mix = 0;

/** `globalBoneKeyWindow`. */
function keyWindow(f32: Float32Array, timesAt: number, keys: number, time: number, interpolation: number): void {
  const last = keys - 1;
  _mix = 0;
  if (last <= 0 || time <= f32[timesAt]!) {
    _left = _right = 0;
    return;
  }
  if (time >= f32[timesAt + last]!) {
    _left = _right = last;
    return;
  }
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (f32[timesAt + middle]! <= time) low = middle;
    else high = middle;
  }
  _left = low;
  if (interpolation === 0) {
    _right = low;
    return;
  }
  _right = high;
  const span = f32[timesAt + high]! - f32[timesAt + low]!;
  _mix = span > 0 ? (time - f32[timesAt + low]!) / span : 0;
}

/** `globalBoneValue`, with the typed array's own bounds. */
function globalValue(
  f32: Float32Array, valuesAt: number, count: number, left: number, right: number, mix: number, component: number,
): number {
  const fromIndex = left * 3 + component;
  const from = fromIndex < count ? f32[valuesAt + fromIndex]! : 0;
  if (left === right) return from;
  const toIndex = right * 3 + component;
  const to = toIndex < count ? f32[valuesAt + toIndex]! : from;
  return from + (to - from) * mix;
}

/** `FastPoseState.#billboard` over the arena. */
function billboardBone(
  f64: Float64Array, bone: number, parent: number, flags: number, root: number, camera: number,
  local: number, model: number,
): void {
  const right = _rightAxis.set(f64[camera]!, f64[camera + 1]!, f64[camera + 2]!).normalize();
  const up = _upAxis.set(f64[camera + 4]!, f64[camera + 5]!, f64[camera + 6]!).normalize();
  const axisY = _axisY.copy(up);
  const axisZ = _axisZ.copy(right).negate();
  const axisX = _axisX.crossVectors(axisY, axisZ);
  if (axisX.lengthSq() < 1e-8) return;
  axisX.normalize();
  axisY.crossVectors(axisZ, axisX).normalize();
  if ((flags & BONE_SPHERICAL_BILLBOARD) === 0) {
    const pinned = (flags & BONE_CYLINDRICAL_BILLBOARD_X) !== 0 ? 0
      : (flags & BONE_CYLINDRICAL_BILLBOARD_Y) !== 0 ? 1 : 2;
    multiplyFlatMatrices(_worldMatrix.elements, 0, f64, root, f64, model + bone * 16);
    _pinned.setFromMatrixColumn(_worldMatrix, pinned).normalize();
    const columns = _columns;
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
  const offset = local + bone * 10;
  if (parent >= 0) multiplyFlatMatrices(_worldMatrix.elements, 0, f64, root, f64, model + parent * 16);
  else _worldMatrix.fromArray(f64, root);
  _worldMatrix.decompose(_position, _parent, _scale);
  _parent.invert().multiply(_world);
  f64[offset + 3] = _parent.x; f64[offset + 4] = _parent.y;
  f64[offset + 5] = _parent.z; f64[offset + 6] = _parent.w;
  composeFlatLocal(_localMatrix, f64, offset);
  if (parent >= 0) multiplyFlatMatrices(f64, model + bone * 16, f64, model + parent * 16, _localMatrix, 0);
  else f64.set(_localMatrix, model + bone * 16);
}

const _localMatrix = new Float64Array(16);
const _rigWorld = new Float64Array(16);
const _rigOffset = new THREE.Matrix4();
const _bind = new THREE.Matrix4();
const _worldMatrix = new THREE.Matrix4();
const _rightAxis = new THREE.Vector3();
const _upAxis = new THREE.Vector3();
const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _axisZ = new THREE.Vector3();
const _columns = [_axisX, _axisY, _axisZ];
const _pinned = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _world = new THREE.Quaternion();
const _parent = new THREE.Quaternion();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quaternionA = new THREE.Quaternion();
const _quaternionB = new THREE.Quaternion();

/** How long a worker keeps polling for the next job before it sleeps, ms. */
const WORKER_SPIN_MS = 0.15;

/**
 * A pose worker's life: take published jobs in order (claiming each one; the main thread may have
 * taken it first), compute, publish the result; poll briefly, then sleep until the page bumps the
 * sequence word. Returns when the page sets the stop word.
 */
export function runPoseWorker(sab: SharedArrayBuffer, worker: number): void {
  const views = poseViews(sab);
  const { i32 } = views;
  const scratch = new PoseScratch();
  const busy = CTRL_BUSY + worker;
  Atomics.store(i32, busy, -1);
  Atomics.add(i32, CTRL_READY, 1);
  let batch = -1;
  let next = 0;
  for (;;) {
    const seq = Atomics.load(i32, CTRL_SEQ);
    if (Atomics.load(i32, CTRL_STOP) !== 0) return;
    const currentBatch = Atomics.load(i32, CTRL_BATCH);
    if (currentBatch !== batch) { batch = currentBatch; next = 0; }
    const published = Atomics.load(i32, CTRL_PUBLISHED);
    let worked = false;
    while (next < published) {
      const index = next++;
      const state = jobWord(i32, index) * 2 + JOB_STATE;
      if (Atomics.compareExchange(i32, state, JOB_PENDING, JOB_WORKER) !== JOB_PENDING) continue;
      Atomics.store(i32, busy, index);
      try {
        computePoseJob(views, index, ROLE_WORKER, scratch);
        // Fails when the main thread took the job over meanwhile; the result is then discarded.
        Atomics.compareExchange(i32, state, JOB_WORKER, JOB_DONE_WORKER);
        Atomics.add(i32, CTRL_WORKER_JOBS, 1);
      } catch {
        Atomics.compareExchange(i32, state, JOB_WORKER, JOB_FAILED);
        Atomics.store(i32, CTRL_FAILED, 1);
      }
      Atomics.store(i32, busy, -1);
      worked = true;
    }
    if (worked) continue;
    // Nothing published yet: poll a little (the next unit is usually microseconds away), then sleep.
    const until = performance.now() + WORKER_SPIN_MS;
    let changed = false;
    while (performance.now() < until) {
      if (Atomics.load(i32, CTRL_SEQ) !== seq) { changed = true; break; }
    }
    if (changed) continue;
    Atomics.add(i32, CTRL_SLEEPING, 1);
    Atomics.wait(i32, CTRL_SEQ, seq);
    Atomics.sub(i32, CTRL_SLEEPING, 1);
  }
}
