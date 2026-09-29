import * as THREE from "three";
import { multiplyFlatMatrices, type FastPoseProgram } from "./FastPose.js";
import {
  CTRL_BATCH, CTRL_BUSY, CTRL_FAILED, CTRL_JOBS, CTRL_PUBLISHED, CTRL_READY, CTRL_SEQ, CTRL_SLEEPING,
  CTRL_STOP, CTRL_WORDS, CTRL_WORKER_JOBS, GLOBAL_FIELDS, JOB_ACTIONS, JOB_CAMERA, JOB_CLIPS,
  JOB_DONE_MAIN, JOB_DONE_WORKER, JOB_FAILED, JOB_FLAG_CAMERA, JOB_FLAG_PALETTE, JOB_FLAGS, JOB_GLOBALS,
  JOB_IDLE, JOB_LOCAL, JOB_MAIN, JOB_NOW, JOB_PENDING, JOB_RIG, JOB_ROOT, JOB_SEQUENCES, JOB_STATE,
  JOB_TIMES, JOB_WEIGHTS, JOB_WORKER, POSE_ARENA_BYTES, POSE_JOB_CAPACITY, POSE_JOB_WORDS,
  POSE_MAX_ACTIONS, POSE_MAX_WORKERS, PROGRAM_DATA, RIG_ACTIVE, RIG_ACTIVE_COUNT, RIG_BONES,
  RIG_HEADER_WORDS, RIG_LOCAL, RIG_MODEL, RIG_ORIGINALS, RIG_PALETTE, RIG_PALETTE_COUNT,
  RIG_PALETTE_LIST, RIG_PROGRAM, RIG_TEMPLATE, ROLE_MAIN, ROLE_WORKER, TRACK_FIELDS, PoseScratch,
  computePoseJob, jobWord, poseViews, type PoseViews,
} from "./PoseEngineCore.js";

/**
 * Crowd poses on a Web Worker (PERF_STATUS «Шаг 17»).
 *
 * The main thread keeps everything about a pose that is cheap or that other code observes: the
 * mixer's clock, the actions' times, weights, fades and their events, and the decision which path
 * a rig takes. What it hands over, per posed rig per frame, is a small job — which clips at which
 * times and weights, the root and camera matrices, the clock for global sequences — and the worker
 * does the expensive part: every track of every drawn bone, the blend, the hierarchy, billboards
 * and the skinning palette, straight into the bone texture's data (`PoseEngineCore.ts`).
 *
 * Jobs are published one by one while the units are being walked, so the worker starts on the
 * first unit while the page is still on the second. Whatever reads a rig — a weapon's attachment in
 * the scene pass, an emitter, the palette upload — first completes that rig's job: already done,
 * or still waiting (the page computes it itself, the same code over the same memory), or being
 * computed right now (the page waits for it, and after `spinBudgetMs` takes it over). So a frame
 * never shows a pose from another frame, and a late or missing worker costs time, not correctness.
 *
 * Needs cross-origin isolation (SharedArrayBuffer). Without it, `pagePoseEngine()` is undefined and
 * crowds keep the main-thread flat pose (`FastPoseState`), exactly as before.
 */

/** Three r185 internals read here; the same ones `FastPoseState` reads. */
interface InternalPropertyMixer {
  binding: { node: THREE.Object3D | undefined; parsedPath: { propertyName: string } };
  buffer: Float64Array;
  valueSize: number;
  _origIndex: number;
  fastPoseSlot?: number;
  fastPoseProgram?: FastPoseProgram;
}
interface InternalAction {
  enabled: boolean;
  blendMode: THREE.AnimationBlendMode;
  _startTime: number | null;
  _clip: THREE.AnimationClip;
  _interpolants: unknown[];
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
interface IndexedBone extends THREE.Object3D { rigIndex?: number }

/** What a global-sequence table is built from; `SkinnedTemplate` satisfies it. */
export interface PoseGlobalSource {
  readonly pivots: Float32Array;
  readonly globalChannels: readonly {
    bone: number; kind: number; globalSequence: number; interpolation: number;
    times: Float32Array; values: Float32Array;
  }[];
}

export interface PoseWorkerHandle { terminate(): void }

export interface PoseEngineOptions {
  /** Worker threads to start (0 runs every job on the calling thread). */
  readonly workers?: number;
  /** Starts worker `index` over the arena; the default starts a browser module worker. */
  readonly spawn?: (sab: SharedArrayBuffer, index: number, fail: (reason: string) => void) => PoseWorkerHandle | undefined;
  /** How long the page waits for a job the worker is computing before taking it over, ms. */
  readonly spinBudgetMs?: number;
  readonly arenaBytes?: number;
}

export interface PoseEngineStats {
  /** Jobs published, and who computed them. */
  jobs: number;
  worker: number;
  /** Taken by the page before the worker reached them. */
  stolen: number;
  /** Taken over from a worker that was late. */
  overridden: number;
  /** Page time spent waiting for a job the worker was computing, and computing jobs itself, ms. */
  waitMs: number;
  mainMs: number;
  frames: number;
}

const DEFAULT_SPIN_BUDGET_MS = 0.3;
/** A worker still busy this long after the frame ended is treated as lost. */
const WORKER_IDLE_LIMIT_MS = 200;
const ALLOCATION_ALIGN_WORDS = 8;

/** First-fit allocator over the arena's words, with coalescing; 0 means out of space. */
class ArenaAllocator {
  #top: number;
  readonly #limit: number;
  /** Free blocks, sorted by address: [word, words]. */
  readonly #free: [number, number][] = [];

  constructor(start: number, limit: number) {
    this.#top = start;
    this.#limit = limit;
  }

  alloc(words: number): number {
    const size = Math.max(ALLOCATION_ALIGN_WORDS, Math.ceil(words / ALLOCATION_ALIGN_WORDS) * ALLOCATION_ALIGN_WORDS);
    for (let index = 0; index < this.#free.length; index++) {
      const block = this.#free[index]!;
      if (block[1] < size) continue;
      const word = block[0];
      if (block[1] === size) this.#free.splice(index, 1);
      else { block[0] += size; block[1] -= size; }
      return word;
    }
    if (this.#top + size > this.#limit) return 0;
    const word = this.#top;
    this.#top += size;
    return word;
  }

  free(word: number, words: number): void {
    const size = Math.max(ALLOCATION_ALIGN_WORDS, Math.ceil(words / ALLOCATION_ALIGN_WORDS) * ALLOCATION_ALIGN_WORDS);
    const free = this.#free;
    let index = 0;
    while (index < free.length && free[index]![0] < word) index++;
    free.splice(index, 0, [word, size]);
    // Merge with the next block, then with the previous one.
    const next = free[index + 1];
    if (next && word + size === next[0]) { free[index]![1] += next[1]; free.splice(index + 1, 1); }
    const previous = free[index - 1];
    if (previous && previous[0] + previous[1] === word) { previous[1] += free[index]![1]; free.splice(index, 1); }
    // A free block at the top returns to the bump region.
    const last = free[free.length - 1];
    if (last && last[0] + last[1] === this.#top) { this.#top = last[0]; free.pop(); }
  }
}

type Held = readonly [word: number, words: number];

export class PoseEngine {
  readonly views: PoseViews;
  readonly stats: PoseEngineStats = { jobs: 0, worker: 0, stolen: 0, overridden: 0, waitMs: 0, mainMs: 0, frames: 0 };
  readonly #allocator: ArenaAllocator;
  readonly #workers: PoseWorkerHandle[] = [];
  readonly #workerCount: number;
  readonly #spinBudgetMs: number;
  readonly #scratch = new PoseScratch();
  readonly #owners: (SharedPose | undefined)[] = new Array(POSE_JOB_CAPACITY).fill(undefined);
  /** 1 once the page has seen job i final this batch (so stats and owners hear it once). */
  readonly #final = new Uint8Array(POSE_JOB_CAPACITY);
  #published = 0;
  #batch = 0;
  #failure: string | undefined;
  /** Blocks released since the last safe point; freed once no worker can be reading them. */
  readonly #pendingFree: Held[] = [];
  readonly #finalizer = new FinalizationRegistry<Held>((held) => { this.#pendingFree.push(held); });
  readonly #programs = new WeakMap<FastPoseProgram, number>();
  readonly #binds = new WeakMap<readonly THREE.Matrix4[], number>();
  readonly #lists = new WeakMap<Int32Array, number>();
  readonly #globals = new WeakMap<PoseGlobalSource, number>();
  readonly #sequences = new WeakMap<Uint32Array, number>();
  readonly #clips = new WeakMap<THREE.AnimationClip, number>();
  /** Clip tracks by (bone, property) slot, for checking an action's bindings once. */
  readonly #clipSlots = new WeakMap<THREE.AnimationClip, Int32Array>();
  readonly #keyframes = new WeakMap<Float32Array, number>();

  private constructor(sab: SharedArrayBuffer, options: PoseEngineOptions) {
    this.views = poseViews(sab);
    const { i32 } = this.views;
    const jobs = CTRL_WORDS;
    i32[CTRL_JOBS] = jobs;
    for (let worker = 0; worker < POSE_MAX_WORKERS; worker++) i32[CTRL_BUSY + worker] = -1;
    this.#allocator = new ArenaAllocator(jobs + POSE_JOB_CAPACITY * POSE_JOB_WORDS, sab.byteLength / 8);
    this.#spinBudgetMs = options.spinBudgetMs ?? DEFAULT_SPIN_BUDGET_MS;
    this.#workerCount = Math.max(0, Math.min(POSE_MAX_WORKERS, options.workers ?? 1));
    const spawn = options.spawn ?? spawnBrowserPoseWorker;
    for (let index = 0; index < this.#workerCount; index++) {
      const handle = spawn(sab, index, (reason) => this.fail(reason));
      if (handle) this.#workers.push(handle);
    }
  }

  /** An engine over a fresh arena, or undefined when SharedArrayBuffer is not available here. */
  static create(options: PoseEngineOptions = {}): PoseEngine | undefined {
    if (typeof SharedArrayBuffer !== "function" || typeof Atomics !== "object") return undefined;
    let sab: SharedArrayBuffer;
    try {
      sab = new SharedArrayBuffer(options.arenaBytes ?? POSE_ARENA_BYTES);
    } catch {
      return undefined;
    }
    return new PoseEngine(sab, options);
  }

  get batch(): number { return this.#batch; }
  /** Workers that have started their loop. */
  get workersReady(): number { return Atomics.load(this.views.i32, CTRL_READY); }
  /** Jobs the workers finished (their own count, including ones the page later discarded). */
  get workerJobs(): number { return Atomics.load(this.views.i32, CTRL_WORKER_JOBS); }
  get failure(): string | undefined {
    if (this.#failure === undefined && Atomics.load(this.views.i32, CTRL_FAILED) !== 0) this.#failure = "worker job failed";
    return this.#failure;
  }
  /** Whether new rigs may be posed here; a failed engine only finishes what it has. */
  get usable(): boolean { return this.failure === undefined; }

  fail(reason: string): void {
    if (this.#failure === undefined) this.#failure = reason;
  }

  resetStats(): void {
    const stats = this.stats;
    stats.jobs = 0; stats.worker = 0; stats.stolen = 0; stats.overridden = 0;
    stats.waitMs = 0; stats.mainMs = 0; stats.frames = 0;
  }

  dispose(): void {
    this.endFrame();
    Atomics.store(this.views.i32, CTRL_STOP, 1);
    Atomics.add(this.views.i32, CTRL_SEQ, 1);
    Atomics.notify(this.views.i32, CTRL_SEQ);
    for (const worker of this.#workers) worker.terminate();
    this.#workers.length = 0;
    this.fail("disposed");
  }

  // --- Registration. Each returns a word (0 when the arena is full or the input is not supported).

  alloc(words: number): number {
    return this.#allocator.alloc(words);
  }

  /** Releases a block at the next safe point (the end of a frame). */
  release(word: number, words: number): void {
    if (word !== 0) this.#pendingFree.push([word, words]);
  }

  /**
   * Frees a block when `owner` is collected without having released it (a rig dropped without
   * `dispose`); `release` after `untrack(token)` is the ordinary way.
   */
  track(owner: object, word: number, words: number, token: object): void {
    this.#finalizer.register(owner, [word, words], token);
  }

  untrack(token: object): void {
    this.#finalizer.unregister(token);
  }

  program(program: FastPoseProgram): number {
    const cached = this.#programs.get(program);
    if (cached !== undefined) return cached;
    const bones = program.boneCount, order = program.order;
    let word = 0;
    if (program.parents.every((parent) => parent < bones)) {
      const words = Math.ceil((PROGRAM_DATA + order.length + bones * 3) / 2);
      word = this.alloc(words);
      if (word !== 0) {
        const i32 = this.views.i32, at = word * 2;
        i32[at] = bones;
        i32[at + 1] = order.length;
        const orderAt = at + PROGRAM_DATA, parentsAt = orderAt + order.length;
        const evaluatedAt = parentsAt + bones, flagsAt = evaluatedAt + bones;
        i32.set(order, orderAt);
        for (let bone = 0; bone < bones; bone++) {
          i32[parentsAt + bone] = program.parents[bone]!;
          i32[evaluatedAt + bone] = program.evaluated[bone]!;
          i32[flagsAt + bone] = program.billboardFlags[bone]!;
        }
        this.#finalizer.register(program, [word, words]);
      }
    }
    this.#programs.set(program, word);
    return word;
  }

  binds(inverses: readonly THREE.Matrix4[]): number {
    const cached = this.#binds.get(inverses);
    if (cached !== undefined) return cached;
    const words = Math.max(1, inverses.length * 16);
    const word = this.alloc(words);
    if (word !== 0) {
      const f64 = this.views.f64;
      for (let bone = 0; bone < inverses.length; bone++) f64.set(inverses[bone]!.elements, word + bone * 16);
      this.#finalizer.register(inverses, [word, words]);
    }
    this.#binds.set(inverses, word);
    return word;
  }

  list(list: Int32Array): number {
    const cached = this.#lists.get(list);
    if (cached !== undefined) return cached;
    const words = Math.max(1, Math.ceil(list.length / 2));
    const word = this.alloc(words);
    if (word !== 0) {
      this.views.i32.set(list, word * 2);
      this.#finalizer.register(list, [word, words]);
    }
    this.#lists.set(list, word);
    return word;
  }

  /** f32 index of an immutable keyframe array, shared by every clip and table naming it. */
  keyframes(array: Float32Array): number {
    const cached = this.#keyframes.get(array);
    if (cached !== undefined) return cached;
    const words = Math.max(1, Math.ceil(array.length / 2));
    const word = this.alloc(words);
    const index = word * 2;
    if (word !== 0) {
      this.views.f32.set(array, index);
      this.#finalizer.register(array, [word, words]);
    }
    this.#keyframes.set(array, index);
    return index;
  }

  /** The global-sequence table of a template, or 0 when it has no channels (or no room). */
  globals(source: PoseGlobalSource): number {
    const cached = this.#globals.get(source);
    if (cached !== undefined) return cached;
    const channels = source.globalChannels;
    let word = 0;
    if (channels.length > 0) {
      const words = 1 + channels.length * (GLOBAL_FIELDS / 2) + source.pivots.length;
      const arrays: number[] = [];
      let complete = true;
      for (const channel of channels) {
        const times = channel.times.length === 0 ? 0 : this.keyframes(channel.times);
        const values = channel.values.length === 0 ? 0 : this.keyframes(channel.values);
        if ((channel.times.length > 0 && times === 0) || (channel.values.length > 0 && values === 0)) complete = false;
        arrays.push(times, values);
      }
      word = complete ? this.alloc(words) : 0;
      if (word !== 0) {
        const { i32, f64 } = this.views;
        i32[word * 2] = channels.length;
        channels.forEach((channel, index) => {
          const field = word * 2 + 2 + index * GLOBAL_FIELDS;
          i32[field] = channel.bone;
          i32[field + 1] = channel.kind;
          i32[field + 2] = channel.globalSequence;
          i32[field + 3] = channel.interpolation;
          i32[field + 4] = arrays[index * 2]!;
          i32[field + 5] = channel.times.length;
          i32[field + 6] = arrays[index * 2 + 1]!;
          i32[field + 7] = channel.values.length;
        });
        const pivots = word + 1 + channels.length * (GLOBAL_FIELDS / 2);
        for (let index = 0; index < source.pivots.length; index++) f64[pivots + index] = source.pivots[index]!;
        this.#finalizer.register(source, [word, words]);
      } else {
        // No room: this table can never be answered here, so the rig must not come here either.
        word = -1;
      }
    }
    this.#globals.set(source, word);
    return word;
  }

  sequences(durations: Uint32Array): number {
    const cached = this.#sequences.get(durations);
    if (cached !== undefined) return cached;
    const words = 1 + durations.length;
    const word = this.alloc(words);
    if (word !== 0) {
      this.views.i32[word * 2] = durations.length;
      for (let index = 0; index < durations.length; index++) this.views.f64[word + 1 + index] = durations[index]!;
      this.#finalizer.register(durations, [word, words]);
    }
    this.#sequences.set(durations, word);
    return word;
  }

  /**
   * A clip's tracks, when every one is a linear bone position/scale or quaternion track over
   * Float32Array keys — the only kind this client builds. 0 for anything else.
   */
  clip(clip: THREE.AnimationClip): number {
    const cached = this.#clips.get(clip);
    if (cached !== undefined) return cached;
    const descriptors: number[] = [];
    const slots = new Int32Array(clip.tracks.length).fill(-1);
    let supported = true;
    clip.tracks.forEach((track, index) => {
      const match = /^bone(\d+)\.(position|quaternion|scale)$/.exec(track.name);
      if (!match) return; // Not one of the rig's bones: its binding is not a bone slot either.
      const property = match[2] === "position" ? 0 : match[2] === "quaternion" ? 1 : 2;
      const stride = track.getValueSize();
      const linear = track.getInterpolation() === THREE.InterpolateLinear;
      const typed = track.times instanceof Float32Array && track.values instanceof Float32Array;
      const kind = property === 1 ? track instanceof THREE.QuaternionKeyframeTrack : track instanceof THREE.VectorKeyframeTrack;
      if (!linear || !typed || !kind || stride !== (property === 1 ? 4 : 3)
        || track.values.length !== track.times.length * stride) { supported = false; return; }
      const times = this.keyframes(track.times as Float32Array);
      const values = this.keyframes(track.values as Float32Array);
      if (times === 0 || values === 0) { supported = false; return; }
      const bone = Number(match[1]);
      slots[index] = bone * 3 + property;
      descriptors.push(bone, property, stride, track.times.length, times, values);
    });
    let word = 0;
    if (supported) {
      const tracks = descriptors.length / TRACK_FIELDS;
      const words = 1 + Math.ceil(descriptors.length / 2);
      word = this.alloc(words);
      if (word !== 0) {
        this.views.i32[word * 2] = tracks;
        this.views.i32.set(descriptors, word * 2 + 2);
        this.#finalizer.register(clip, [word, words]);
      }
    }
    this.#clips.set(clip, word);
    this.#clipSlots.set(clip, slots);
    return word;
  }

  /** Track index → bone slot of a registered clip (-1 for tracks that are not bone slots). */
  clipSlots(clip: THREE.AnimationClip): Int32Array | undefined {
    return this.#clipSlots.get(clip);
  }

  // --- Jobs.

  /** A job slot for `owner`, filled by the caller and then published. */
  openJob(owner: SharedPose): number {
    if (this.#published >= POSE_JOB_CAPACITY) this.endFrame();
    const index = this.#published++;
    this.#owners[index] = owner;
    this.#final[index] = 0;
    Atomics.store(this.views.i32, jobWord(this.views.i32, index) * 2 + JOB_STATE, JOB_IDLE);
    return index;
  }

  publish(index: number): void {
    const i32 = this.views.i32;
    Atomics.store(i32, jobWord(i32, index) * 2 + JOB_STATE, JOB_PENDING);
    Atomics.store(i32, CTRL_PUBLISHED, index + 1);
    Atomics.add(i32, CTRL_SEQ, 1);
    if (Atomics.load(i32, CTRL_SLEEPING) > 0) Atomics.notify(i32, CTRL_SEQ);
    this.stats.jobs++;
  }

  /**
   * Makes job `index` final: done by a worker, or computed here — at once when no worker has
   * taken it, after `spinBudgetMs` when one is computing it.
   */
  complete(index: number): void {
    if (this.#final[index] === 1) return;
    this.#final[index] = 1;
    const i32 = this.views.i32;
    const state = jobWord(i32, index) * 2 + JOB_STATE;
    const owner = this.#owners[index];
    let waitingSince = -1;
    for (;;) {
      const current = Atomics.load(i32, state);
      if (current === JOB_DONE_WORKER) {
        if (waitingSince >= 0) this.stats.waitMs += performance.now() - waitingSince;
        this.stats.worker++;
        owner?.finish(index, ROLE_WORKER, false);
        return;
      }
      if (current === JOB_PENDING || current === JOB_FAILED) {
        if (Atomics.compareExchange(i32, state, current, JOB_MAIN) !== current) continue;
        if (waitingSince >= 0) this.stats.waitMs += performance.now() - waitingSince;
        this.#computeHere(index, state);
        this.stats.stolen++;
        owner?.finish(index, ROLE_MAIN, false);
        return;
      }
      if (current === JOB_WORKER) {
        const now = performance.now();
        if (waitingSince < 0) { waitingSince = now; continue; }
        if (now - waitingSince < this.#spinBudgetMs) continue;
        if (Atomics.compareExchange(i32, state, JOB_WORKER, JOB_MAIN) !== JOB_WORKER) continue;
        this.stats.waitMs += now - waitingSince;
        this.#computeHere(index, state);
        this.stats.overridden++;
        owner?.finish(index, ROLE_MAIN, true);
        return;
      }
      // Idle (opened, never published), or already made final here.
      return;
    }
  }

  #computeHere(index: number, state: number): void {
    const started = performance.now();
    computePoseJob(this.views, index, ROLE_MAIN, this.#scratch);
    Atomics.store(this.views.i32, state, JOB_DONE_MAIN);
    this.stats.mainMs += performance.now() - started;
  }

  /** Waits until no worker is computing job `index` (one the page took over), bounded. */
  waitForWorkersOff(index: number): void {
    const i32 = this.views.i32;
    const started = performance.now();
    for (let worker = 0; worker < this.#workerCount; worker++) {
      while (Atomics.load(i32, CTRL_BUSY + worker) === index) {
        if (performance.now() - started > WORKER_IDLE_LIMIT_MS) { this.fail("worker stalled"); return; }
      }
    }
  }

  /**
   * The frame's safe point: every published job final, every worker idle, released blocks freed,
   * the job table empty. Called before the units are walked and after the frame is drawn.
   */
  endFrame(): void {
    const i32 = this.views.i32;
    const published = this.#published;
    if (published > 0) {
      for (let index = 0; index < published; index++) this.complete(index);
      this.stats.frames++;
    }
    const started = performance.now();
    for (let worker = 0; worker < this.#workerCount; worker++) {
      while (Atomics.load(i32, CTRL_BUSY + worker) !== -1) {
        if (performance.now() - started > WORKER_IDLE_LIMIT_MS) { this.fail("worker stalled"); break; }
      }
    }
    if (this.#pendingFree.length > 0 && this.#failure !== "worker stalled") {
      for (const [word, words] of this.#pendingFree) this.#allocator.free(word, words);
      this.#pendingFree.length = 0;
    }
    if (published === 0) return;
    this.#owners.fill(undefined, 0, published);
    this.#published = 0;
    Atomics.store(i32, CTRL_PUBLISHED, 0);
    this.#batch = (this.#batch + 1) | 0;
    Atomics.store(i32, CTRL_BATCH, this.#batch);
    Atomics.add(i32, CTRL_SEQ, 1);
  }
}

/** The page's browser worker: a module worker running `runPoseWorker` over the arena. */
function spawnBrowserPoseWorker(sab: SharedArrayBuffer, index: number, fail: (reason: string) => void): PoseWorkerHandle | undefined {
  if (typeof Worker === "undefined") return undefined;
  const worker = new Worker(new URL("./PoseEngine.worker.ts", import.meta.url), {
    type: "module", name: `pose-engine-${index}`,
  });
  worker.onerror = (event) => fail(event.message || "pose worker failed");
  worker.onmessageerror = () => fail("pose worker message failed");
  worker.postMessage({ sab, index });
  return worker;
}

let pageEngine: PoseEngine | null | undefined;

/**
 * The page's pose engine, created on first use: only in a cross-origin isolated page with
 * SharedArrayBuffer, Atomics and Web Workers. `?poseworker=0` keeps crowds on the main thread,
 * `?poseworkers=N` (1..4) sets the worker count.
 */
export function pagePoseEngine(): PoseEngine | undefined {
  if (pageEngine !== undefined) return pageEngine ?? undefined;
  pageEngine = null;
  const scope = globalThis as { crossOriginIsolated?: boolean; location?: { search?: string } };
  if (scope.crossOriginIsolated !== true || typeof Worker === "undefined") return undefined;
  const search = scope.location?.search ?? "";
  if (/[?&]poseworker=0(?:&|$)/.test(search)) return undefined;
  const count = Number(/[?&]poseworkers=(\d)(?:&|$)/.exec(search)?.[1] ?? 1);
  try {
    pageEngine = PoseEngine.create({ workers: Math.max(1, Math.min(POSE_MAX_WORKERS, count)) }) ?? null;
  } catch {
    pageEngine = null;
  }
  return pageEngine ?? undefined;
}

/**
 * One rig's pose in the engine: the arena block the jobs read and write, and the main-thread half
 * of a pose step. Used exactly like `FastPoseState` — `advance`, `globalSequences` (in place of
 * `writeGlobalSequenceLocals`), `compose` — except that compose publishes the step instead of
 * performing it; `model`, `boneWorld` and the palette complete it first.
 */
export class SharedPose {
  readonly program: FastPoseProgram;
  readonly engine: PoseEngine;
  /** Bumped whenever a step is published, so an unchanged pose can reuse its palette. */
  version = 0;
  /** Set when this rig cannot be posed here any more (an unsupported clip, no room). */
  unusable = false;
  #disposed = false;
  readonly #bones: readonly THREE.Object3D[];
  readonly #rig: number;
  readonly #rigWords: number;
  readonly #locals: Float64Array[];
  readonly #models: Float64Array[];
  #current = 0;
  #out = ROLE_MAIN;
  #job = -1;
  #jobBatch = -1;
  #zombieJob = -1;
  #zombieBatch = -1;
  #readBindings: InternalPropertyMixer[] = [];
  #bonesRead = false;
  #slotsStale = true;
  readonly #validated = new WeakSet<InternalAction>();
  #stepClips: number[] = [];
  #stepTimes: number[] = [];
  #stepWeights: number[] = [];
  #globals = 0;
  #sequences = 0;
  #now = 0;
  #palette = 0;
  #paletteWords = 0;
  #paletteArray: Float32Array | undefined;
  /** Unregister token of the palette block's finalization entry. */
  #paletteToken: object = {};
  readonly #jobRoot = new Float64Array(16);
  #jobPalette = false;
  #jobVersion = -1;

  private constructor(engine: PoseEngine, program: FastPoseProgram, bones: readonly THREE.Object3D[],
    rig: number, rigWords: number) {
    this.engine = engine;
    this.program = program;
    this.#bones = bones;
    this.#rig = rig;
    this.#rigWords = rigWords;
    const { i32, f64 } = engine.views;
    const count = program.boneCount;
    this.#locals = [0, 1, 2].map((area) => new Float64Array(f64.buffer, i32[rig * 2 + RIG_LOCAL + area]! * 8, count * 10));
    this.#models = [0, 1].map((role) => new Float64Array(f64.buffer, i32[rig * 2 + RIG_MODEL + role]! * 8, count * 16));
  }

  /** A pose block for one rig, or undefined when the arena cannot hold it. */
  static create(engine: PoseEngine, program: FastPoseProgram, bones: readonly THREE.Object3D[],
    boneInverses: readonly THREE.Matrix4[], paletteBones: Int32Array | undefined): SharedPose | undefined {
    const count = program.boneCount;
    if (bones.length !== count || boneInverses.length !== count) return undefined;
    const programWord = engine.program(program);
    const bindWord = engine.binds(boneInverses);
    const palette = paletteBones ?? program.order;
    const listWord = engine.list(palette);
    if (programWord === 0 || bindWord === 0 || listWord === 0) return undefined;
    const activeWords = Math.ceil(count * 3 / 2);
    const originalWords = count * 12;
    const localWords = count * 10, modelWords = count * 16;
    const words = RIG_HEADER_WORDS + activeWords + originalWords + localWords * 3 + modelWords * 2;
    const rig = engine.alloc(words);
    if (rig === 0) return undefined;
    const { i32, f64 } = engine.views;
    f64.fill(0, rig, rig + words);
    const at = rig * 2;
    let next = rig + RIG_HEADER_WORDS;
    i32[at + RIG_BONES] = count;
    i32[at + RIG_PROGRAM] = programWord;
    i32[at + RIG_TEMPLATE] = bindWord;
    i32[at + RIG_PALETTE_LIST] = listWord;
    i32[at + RIG_PALETTE_COUNT] = palette.length;
    i32[at + RIG_ACTIVE_COUNT] = 0;
    i32[at + RIG_ACTIVE] = next; next += activeWords;
    i32[at + RIG_ORIGINALS] = next; next += originalWords;
    for (let area = 0; area < 3; area++) { i32[at + RIG_LOCAL + area] = next; next += localWords; }
    for (let role = 0; role < 2; role++) { i32[at + RIG_MODEL + role] = next; next += modelWords; }
    i32[at + RIG_PALETTE] = 0;
    const pose = new SharedPose(engine, program, bones, rig, words);
    engine.track(pose, rig, words, pose);
    return pose;
  }

  /** Local transforms (position 3, quaternion 4, scale 3 per bone) of the latest step. */
  get local(): Float64Array {
    this.sync();
    return this.#locals[this.#current]!;
  }

  /** Root-relative bone matrices of the latest step (column-major, 16 per bone). */
  get model(): Float64Array {
    this.sync();
    return this.#models[this.#out]!;
  }

  /** The active bindings `local` was read against, for a pose taking over from this one. */
  get readBindings(): readonly unknown[] | undefined {
    return this.#bonesRead ? this.#readBindings : undefined;
  }

  /**
   * Whether the mixer's active actions can be posed here: normal blending (the caller has checked
   * `FastPoseState.supports`), at most `POSE_MAX_ACTIONS`, clips of plain linear bone tracks, and
   * bindings that resolve to this rig's bones the way the clip names them.
   */
  prepare(mixer: THREE.AnimationMixer, globals?: PoseGlobalSource, durations?: Uint32Array): boolean {
    if (this.unusable || !this.engine.usable) return false;
    if (globals && durations) {
      const table = this.engine.globals(globals);
      if (table < 0 || (table > 0 && durations.length > 0 && this.engine.sequences(durations) === 0)) {
        this.unusable = true;
        return false;
      }
    }
    const internal = mixer as unknown as InternalMixer;
    const count = internal._nActiveActions;
    if (count > POSE_MAX_ACTIONS) return false;
    for (let index = 0; index < count; index++) {
      const action = internal._actions[index]!;
      if (this.#validated.has(action)) continue;
      const clip = action._clip;
      if (this.engine.clip(clip) === 0 || !this.#bindingsMatch(action, clip)) {
        this.unusable = true;
        return false;
      }
      this.#validated.add(action);
    }
    return true;
  }

  /**
   * `FastPoseState.advance` up to the accumulation: the mixer's clock and every action's time and
   * weight exactly as `AnimationMixer.update` would (events included), and the contributing
   * actions noted for the job. When the active bindings changed, the bones are read again and the
   * slots and original values handed to the job table.
   */
  advance(mixer: THREE.AnimationMixer, deltaTime: number): void {
    this.sync();
    const internal = mixer as unknown as InternalMixer;
    deltaTime *= internal.timeScale;
    const actions = internal._actions;
    const activeActions = internal._nActiveActions;
    const time = internal.time += deltaTime;
    const timeDirection = Math.sign(deltaTime);
    internal._accuIndex ^= 1;
    const stepClips = this.#stepClips, stepTimes = this.#stepTimes, stepWeights = this.#stepWeights;
    stepClips.length = 0; stepTimes.length = 0; stepWeights.length = 0;
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
        let clip = this.engine.clip(action._clip);
        // An action `prepare` did not see (an event listener started it mid-step) whose clip cannot
        // be posed here: this step leaves it out and the rig goes back to the main thread.
        if (clip === 0 || !this.#validated.has(action)) {
          if (clip !== 0 && this.#bindingsMatch(action, action._clip)) this.#validated.add(action);
          else { this.unusable = true; clip = 0; }
        }
        if (clip !== 0 && stepClips.length < POSE_MAX_ACTIONS) {
          stepClips.push(clip);
          stepTimes.push(clipTime);
          stepWeights.push(weight);
        } else this.unusable = true;
      }
    }
    this.#globals = 0;
    this.#sequences = 0;
    const bindings = internal._bindings;
    const changed = this.#bindingsChanged(bindings, internal._nActiveBindings);
    if (changed || !this.#bonesRead) {
      this.#bonesRead = true;
      const local = this.#locals[this.#current]!;
      const order = this.program.order;
      for (let at = 0; at < order.length; at++) {
        const bone = order[at]!;
        const object = this.#bones[bone]!;
        const offset = bone * 10;
        local[offset] = object.position.x; local[offset + 1] = object.position.y; local[offset + 2] = object.position.z;
        local[offset + 3] = object.quaternion.x; local[offset + 4] = object.quaternion.y;
        local[offset + 5] = object.quaternion.z; local[offset + 6] = object.quaternion.w;
        local[offset + 7] = object.scale.x; local[offset + 8] = object.scale.y; local[offset + 9] = object.scale.z;
      }
    }
    if (changed || this.#slotsStale) {
      this.#slotsStale = false;
      this.#writeSlots(bindings, internal._nActiveBindings);
    }
  }

  /** `writeGlobalSequenceLocals` for this step: the job applies the template's channels at `worldMs`. */
  globalSequences(source: PoseGlobalSource, durations: Uint32Array, worldMs: number): void {
    const globals = this.engine.globals(source);
    if (globals < 0) { this.unusable = true; return; }
    if (globals === 0) return;
    const sequences = this.engine.sequences(durations);
    if (sequences === 0 && durations.length > 0) { this.unusable = true; return; }
    this.#globals = globals;
    this.#sequences = sequences;
    this.#now = worldMs;
  }

  /** Publishes the step: composed against `root` where it stands now, billboards facing `camera`. */
  compose(root: THREE.Object3D, camera: THREE.Object3D | undefined): void {
    root.updateWorldMatrix(true, false);
    const engine = this.engine;
    const index = engine.openJob(this);
    const { i32, f64 } = engine.views;
    const job = jobWord(i32, index), ji = job * 2;
    const clips = this.#stepClips;
    i32[ji + JOB_RIG] = this.#rig;
    i32[ji + JOB_ACTIONS] = clips.length;
    for (let action = 0; action < clips.length; action++) {
      i32[ji + JOB_CLIPS + action] = clips[action]!;
      f64[job + JOB_TIMES + action] = this.#stepTimes[action]!;
      f64[job + JOB_WEIGHTS + action] = this.#stepWeights[action]!;
    }
    const palette = this.#palette !== 0;
    i32[ji + JOB_FLAGS] = (camera !== undefined ? JOB_FLAG_CAMERA : 0) | (palette ? JOB_FLAG_PALETTE : 0);
    i32[ji + JOB_GLOBALS] = this.#globals;
    i32[ji + JOB_SEQUENCES] = this.#sequences;
    i32[ji + JOB_LOCAL] = this.#current;
    f64[job + JOB_NOW] = this.#now;
    const rootElements = root.matrixWorld.elements;
    f64.set(rootElements, job + JOB_ROOT);
    this.#jobRoot.set(rootElements);
    if (camera !== undefined) f64.set(camera.matrixWorld.elements, job + JOB_CAMERA);
    this.version++;
    this.#jobVersion = this.version;
    this.#jobPalette = palette;
    this.#job = index;
    this.#jobBatch = engine.batch;
    engine.publish(index);
  }

  /** Completes this rig's published step, if it has one this frame. */
  sync(): void {
    if (this.#job < 0) return;
    if (this.#jobBatch === this.engine.batch) this.engine.complete(this.#job);
    this.#job = -1;
  }

  /** Called by the engine when job `index` became final. */
  finish(index: number, role: number, overtaken: boolean): void {
    if (index !== this.#job || this.#jobBatch !== this.engine.batch) return;
    this.#job = -1;
    this.#current = (this.#current + 1 + role) % 3;
    this.#out = role;
    if (overtaken) { this.#zombieJob = index; this.#zombieBatch = this.engine.batch; }
  }

  /** Writes `rootWorld × model[bone]` into `target`; false when the bone is not computed. */
  boneWorld(bone: number, rootWorld: THREE.Matrix4, target: THREE.Matrix4): boolean {
    if (this.program.evaluated[bone] !== 1) return false;
    multiplyFlatMatrices(target.elements, 0, rootWorld.elements, 0, this.model, bone * 16);
    return true;
  }

  /**
   * Whether the latest step already wrote this rig's palette into `output` against a root equal to
   * `rootElements` (what `RigSkeleton.update` would compute), so the page need not.
   */
  paletteWritten(rootElements: ArrayLike<number>, output: Float32Array): boolean {
    this.sync();
    if (!this.#jobPalette || this.#jobVersion !== this.version || output !== this.#paletteArray) return false;
    const root = this.#jobRoot;
    for (let element = 0; element < 16; element++) if (root[element] !== rootElements[element]) return false;
    return true;
  }

  /**
   * Before the page writes this rig's palette itself: a worker the page overtook this frame may
   * still be writing the same array (the same numbers, but against the step's root).
   */
  settlePalette(): void {
    if (this.#zombieJob < 0) return;
    if (this.#zombieBatch === this.engine.batch) this.engine.waitForWorkersOff(this.#zombieJob);
    this.#zombieJob = -1;
  }

  /**
   * The skinning palette's storage in the arena (the bone texture's data), so steps write it
   * directly; undefined when there is no room. Replaces any earlier one.
   */
  allocatePalette(floats: number): Float32Array | undefined {
    this.sync();
    this.settlePalette();
    this.#releasePalette();
    const words = Math.ceil(floats / 2);
    const word = this.engine.alloc(words);
    if (word === 0) return undefined;
    this.#palette = word * 2;
    this.#paletteWords = words;
    this.#paletteToken = {};
    this.engine.track(this, word, words, this.#paletteToken);
    this.#paletteArray = new Float32Array(this.engine.views.f32.buffer, word * 8, floats);
    this.#paletteArray.fill(0);
    this.engine.views.i32[this.#rig * 2 + RIG_PALETTE] = this.#palette;
    return this.#paletteArray;
  }

  /** The bone objects were written outside this pose; read them again on the next step. */
  rereadBones(): void {
    this.#bonesRead = false;
  }

  /** Continues from another flat pose of this rig (`FastPoseState.local` and its binding set). */
  adopt(local: Float64Array, readBindings: readonly unknown[] | undefined): void {
    this.sync();
    this.#locals[this.#current]!.set(local);
    if (readBindings === undefined) this.#bonesRead = false;
    else {
      this.#readBindings = readBindings.slice() as InternalPropertyMixer[];
      this.#bonesRead = true;
    }
    this.#slotsStale = true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.sync();
    this.unusable = true;
    this.#releasePalette();
    this.engine.untrack(this);
    this.engine.release(this.#rig, this.#rigWords);
  }

  #releasePalette(): void {
    if (this.#palette === 0) return;
    this.engine.views.i32[this.#rig * 2 + RIG_PALETTE] = 0;
    this.engine.untrack(this.#paletteToken);
    this.engine.release(this.#palette / 2, this.#paletteWords);
    this.#palette = 0;
    this.#paletteArray = undefined;
  }

  #bindingsChanged(bindings: readonly InternalPropertyMixer[], active: number): boolean {
    const read = this.#readBindings;
    let changed = read.length !== active;
    for (let index = 0; !changed && index < active; index++) changed = read[index] !== bindings[index];
    if (!changed) return false;
    read.length = active;
    for (let index = 0; index < active; index++) read[index] = bindings[index]!;
    return true;
  }

  /** The active bindings' slots and original values, for the jobs' `PropertyMixer.apply`. */
  #writeSlots(bindings: readonly InternalPropertyMixer[], active: number): void {
    const { i32, f64 } = this.engine.views;
    const rig = this.#rig * 2;
    const slotsAt = i32[rig + RIG_ACTIVE]! * 2;
    const originals = i32[rig + RIG_ORIGINALS]!;
    let count = 0;
    for (let index = 0; index < active; index++) {
      const binding = bindings[index]!;
      const slot = this.#slot(binding);
      if (slot < 0) continue;
      i32[slotsAt + count++] = slot;
      const stride = binding.valueSize, from = stride * binding._origIndex;
      for (let component = 0; component < stride; component++) {
        f64[originals + slot * 4 + component] = binding.buffer[from + component]!;
      }
    }
    i32[rig + RIG_ACTIVE_COUNT] = count;
  }

  /** `FastPoseState.#slot`: the bound bone's property slot, or -1 when not computed here. */
  #slot(binding: InternalPropertyMixer): number {
    if (binding.fastPoseProgram === this.program && binding.fastPoseSlot !== undefined) return binding.fastPoseSlot;
    const node = binding.binding.node as IndexedBone | undefined;
    const bone = node?.rigIndex;
    const name = binding.binding.parsedPath.propertyName;
    const property = name === "position" ? 0 : name === "quaternion" ? 1 : name === "scale" ? 2 : -1;
    const slot = bone !== undefined && property >= 0 && this.#bones[bone] === node
      && this.program.evaluated[bone] === 1 ? bone * 3 + property : -1;
    binding.fastPoseProgram = this.program;
    binding.fastPoseSlot = slot;
    return slot;
  }

  /** Whether each track of `clip` reaches the same slot through its binding as through its name. */
  #bindingsMatch(action: InternalAction, clip: THREE.AnimationClip): boolean {
    const byName = this.engine.clipSlots(clip);
    const bindings = action._propertyBindings;
    if (!byName || bindings.length !== clip.tracks.length || action._interpolants.length !== clip.tracks.length) return false;
    const evaluated = this.program.evaluated;
    for (let track = 0; track < bindings.length; track++) {
      const named = byName[track]!;
      const bone = named < 0 ? -1 : (named / 3) | 0;
      const expected = named >= 0 && bone < evaluated.length && evaluated[bone] === 1 ? named : -1;
      if (this.#slot(bindings[track]!) !== expected) return false;
    }
    return true;
  }
}
