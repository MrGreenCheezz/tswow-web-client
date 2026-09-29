import * as THREE from "three";
import { RigSkeleton } from "./AnimatedModel.js";

export type SubmissionPart = "matrices" | "mainSkeletons" | "mainDraws"
  | "shadowSkeletons" | "shadowDraws" | "shadowOther" | "other";
export type SubmissionDrawKind = "mainSkinned" | "mainNonSkinned" | "shadowSkinned" | "shadowNonSkinned";

export interface WorldSubmissionSnapshot {
  readonly ageMs: number;
  readonly totalMs: number;
  /** Exclusive synchronous CPU intervals, including driver waits; their sum is totalMs. */
  readonly partsMs: Readonly<Record<SubmissionPart, number>>;
  /** Exclusive subsets of mainDraws and shadowDraws; do not add these to partsMs. */
  readonly drawKindsMs: Readonly<Record<SubmissionDrawKind, number>>;
  readonly calls: Readonly<{
    mainDraws: number; shadowDraws: number; mainSkinnedDraws: number; shadowSkinnedDraws: number;
    skeletonUpdates: number; bonesUpdated: number;
    /** Main-pass submissions whose material or linked program differs from the previous one. */
    mainMaterialSwitches: number; mainProgramSwitches: number;
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
    const drawKinds: Record<SubmissionDrawKind, number> = {
      mainSkinned: 0, mainNonSkinned: 0, shadowSkinned: 0, shadowNonSkinned: 0,
    };
    const calls = {
      mainDraws: 0, shadowDraws: 0, mainSkinnedDraws: 0, shadowSkinnedDraws: 0,
      skeletonUpdates: 0, bonesUpdated: 0, mainMaterialSwitches: 0, mainProgramSwitches: 0,
    };
    let lastMaterial: THREE.Material | undefined;
    let lastProgram: unknown;
    let phase: SubmissionPart = "other";
    let activeDrawKind: SubmissionDrawKind | undefined;
    let lastAt = at;
    let shadow = false;
    let started = at;
    let ended = at;
    let failed = true;
    const restores: Array<() => void> = [];
    const clock = this.clock;
    const measure = <T>(part: SubmissionPart, work: () => T, kind?: SubmissionDrawKind): T => {
      const previous = phase;
      const previousKind = activeDrawKind;
      const begin = clock();
      const beforeMs = begin - lastAt;
      parts[previous] += beforeMs;
      if (previousKind) drawKinds[previousKind] += beforeMs;
      lastAt = begin;
      phase = part;
      activeDrawKind = kind;
      try { return work(); }
      finally {
        const end = clock();
        const elapsedMs = end - lastAt;
        parts[phase] += elapsedMs;
        if (activeDrawKind) drawKinds[activeDrawKind] += elapsedMs;
        lastAt = end;
        phase = previous;
        activeDrawKind = previousKind;
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
      // M2 rigs override update for pivot-only inverse binds. Observe both implementations only
      // while sampling; a rig delegating to Three must still count as one palette update.
      const activeSkeletons = new Set<THREE.Skeleton>();
      for (const prototype of [THREE.Skeleton.prototype, RigSkeleton.prototype]) {
        const updateSkeleton = prototype.update;
        replace(prototype, "update", function (this: THREE.Skeleton) {
          if (activeSkeletons.has(this)) return updateSkeleton.call(this);
          activeSkeletons.add(this);
          calls.skeletonUpdates++;
          calls.bonesUpdated += this.bones.length;
          try { return measure(shadow ? "shadowSkeletons" : "mainSkeletons", () => updateSkeleton.call(this)); }
          finally { activeSkeletons.delete(this); }
        });
      }
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
        const skinned = (args[4] as THREE.SkinnedMesh).isSkinnedMesh;
        const kind: SubmissionDrawKind = shadow
          ? skinned ? "shadowSkinned" : "shadowNonSkinned"
          : skinned ? "mainSkinned" : "mainNonSkinned";
        const before = renderer.info.render.calls;
        try { return measure(counter, () => renderDirect.apply(this, args), kind); }
        finally {
          // A buffer submission may issue no draw or an instanced/multi draw. Count GL draws,
          // not method invocations, from Three's existing counter (no WebGL query).
          const drawn = Math.max(0, renderer.info.render.calls - before);
          calls[counter] += drawn;
          if (skinned) {
            calls[shadow ? "shadowSkinnedDraws" : "mainSkinnedDraws"] += drawn;
          }
          if (!shadow && drawn > 0) {
            // Each switch re-uploads the material's uniform list; a program switch also rebinds
            // camera and light state. Counted after the draw, once Three has chosen the program.
            const material = args[3] as THREE.Material;
            const properties = (renderer as { properties?: { get(value: object): unknown } }).properties;
            const program = (properties?.get(material) as { currentProgram?: unknown } | undefined)?.currentProgram;
            if (material !== lastMaterial) calls.mainMaterialSwitches++;
            if (program !== lastProgram) calls.mainProgramSwitches++;
            lastMaterial = material;
            lastProgram = program;
          }
        }
      });
      started = lastAt = clock();
      try {
        renderer.render(scene, camera);
        failed = false;
      } finally {
        ended = clock();
        const elapsedMs = ended - lastAt;
        parts[phase] += elapsedMs;
        if (activeDrawKind) drawKinds[activeDrawKind] += elapsedMs;
      }
    } finally {
      for (let index = restores.length - 1; index >= 0; index--) restores[index]!();
      sampling = false;
      this.#sampleAt = started;
      this.#sample = Object.freeze({
        totalMs: ended - started, partsMs: Object.freeze(parts), drawKindsMs: Object.freeze(drawKinds),
        calls: Object.freeze(calls),
        hookSetupRestoreMs: Math.max(0, this.clock() - at - (ended - started)), failed,
      });
    }
  }
}
