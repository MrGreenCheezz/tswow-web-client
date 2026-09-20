import * as THREE from "three";

export type SubmissionPart = "matrices" | "mainSkeletons" | "mainDraws"
  | "shadowSkeletons" | "shadowDraws" | "shadowOther" | "other";

export interface WorldSubmissionSnapshot {
  readonly ageMs: number;
  readonly totalMs: number;
  /** Exclusive synchronous CPU intervals, including driver waits; their sum is totalMs. */
  readonly partsMs: Readonly<Record<SubmissionPart, number>>;
  readonly calls: Readonly<{
    mainDraws: number; shadowDraws: number; mainSkinnedDraws: number; shadowSkinnedDraws: number;
    skeletonUpdates: number; bonesUpdated: number;
  }>;
  readonly hookSetupRestoreMs: number;
  readonly failed: boolean;
}

/** A synchronous nested render must not install a second set of prototype hooks. */
let sampling = false;

/**
 * Opt-in diagnostic only. Samples one world submission every 500 ms, never poses a model,
 * changes a renderer setting, reads pixels, or waits for the GPU. Hooks live only inside
 * that synchronous render call and are restored even if it throws. Timing calls themselves
 * add overhead: use the decomposition to locate work, not to accept a FPS optimization.
 */
export class WorldSubmissionCapture {
  #nextAt = Number.NEGATIVE_INFINITY;
  #sample: Omit<WorldSubmissionSnapshot, "ageMs"> | undefined;
  #sampleAt = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  snapshot(): WorldSubmissionSnapshot | undefined {
    return this.#sample === undefined ? undefined
      : Object.freeze({ ...this.#sample, ageMs: Math.max(0, this.clock() - this.#sampleAt) });
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const at = this.clock();
    if (sampling || at < this.#nextAt) {
      renderer.render(scene, camera);
      return;
    }
    this.#nextAt = at + 500;
    sampling = true;
    const parts: Record<SubmissionPart, number> = {
      matrices: 0, mainSkeletons: 0, mainDraws: 0, shadowSkeletons: 0,
      shadowDraws: 0, shadowOther: 0, other: 0,
    };
    const calls = {
      mainDraws: 0, shadowDraws: 0, mainSkinnedDraws: 0, shadowSkinnedDraws: 0,
      skeletonUpdates: 0, bonesUpdated: 0,
    };
    let phase: SubmissionPart = "other";
    let lastAt = at;
    let shadow = false;
    let started = at;
    let ended = at;
    let failed = true;
    const restores: Array<() => void> = [];
    const clock = this.clock;
    const measure = <T>(part: SubmissionPart, work: () => T): T => {
      const previous = phase;
      const begin = clock();
      parts[previous] += begin - lastAt;
      lastAt = begin;
      phase = part;
      try { return work(); }
      finally {
        const end = clock();
        parts[phase] += end - lastAt;
        lastAt = end;
        phase = previous;
      }
    };
    const replace = <T extends object, K extends keyof T>(owner: T, key: K, value: T[K]): void => {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      Object.defineProperty(owner, key, { configurable: true, writable: true, value });
      restores.push(() => {
        if (descriptor) Object.defineProperty(owner, key, descriptor);
        else Reflect.deleteProperty(owner, key);
      });
    };
    try {
      const updateMatrices = scene.updateMatrixWorld;
      replace(scene, "updateMatrixWorld", function (this: THREE.Scene, force) {
        return measure("matrices", () => updateMatrices.call(this, force));
      });
      const updateSkeleton = THREE.Skeleton.prototype.update;
      replace(THREE.Skeleton.prototype, "update", function (this: THREE.Skeleton) {
        calls.skeletonUpdates++;
        calls.bonesUpdated += this.bones.length;
        return measure(shadow ? "shadowSkeletons" : "mainSkeletons", () => updateSkeleton.call(this));
      });
      const renderShadow = renderer.shadowMap.render;
      replace(renderer.shadowMap, "render", function (this: THREE.WebGLRenderer["shadowMap"], ...args) {
        const previous = shadow;
        shadow = true;
        try { return measure("shadowOther", () => renderShadow.apply(this, args)); }
        finally { shadow = previous; }
      });
      const renderDirect = renderer.renderBufferDirect;
      replace(renderer, "renderBufferDirect", function (this: THREE.WebGLRenderer, ...args) {
        const counter = shadow ? "shadowDraws" : "mainDraws";
        const before = renderer.info.render.calls;
        try { return measure(counter, () => renderDirect.apply(this, args)); }
        finally {
          // A buffer submission may issue no draw or an instanced/multi draw. Count GL draws,
          // not method invocations, from Three's existing counter (no WebGL query).
          const drawn = Math.max(0, renderer.info.render.calls - before);
          calls[counter] += drawn;
          if ((args[4] as THREE.SkinnedMesh).isSkinnedMesh) {
            calls[shadow ? "shadowSkinnedDraws" : "mainSkinnedDraws"] += drawn;
          }
        }
      });
      started = lastAt = clock();
      try {
        renderer.render(scene, camera);
        failed = false;
      } finally {
        ended = clock();
        parts[phase] += ended - lastAt;
      }
    } finally {
      for (let index = restores.length - 1; index >= 0; index--) restores[index]!();
      sampling = false;
      this.#sampleAt = started;
      this.#sample = Object.freeze({
        totalMs: ended - started, partsMs: Object.freeze(parts), calls: Object.freeze(calls),
        hookSetupRestoreMs: Math.max(0, this.clock() - at - (ended - started)), failed,
      });
    }
  }
}
