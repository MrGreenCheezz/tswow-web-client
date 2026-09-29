import type * as THREE from "three";
import { buildWmoGroupGeometrySteps } from "./WmoGeometry.js";
import type { WmoGroupMesh, WmoModel } from "./WmoModel.js";

/** One unfinished room at a time; converted buffers never accumulate behind the camera. */
export class WmoGeometryBuild {
  #job: {
    key: string;
    source: WmoGroupMesh;
    steps: Generator<void, THREE.BufferGeometry | undefined, void>;
    wantedFrame: number;
  } | undefined;
  #frame = -1;
  #spent = 0;
  #steps = 0;

  constructor(
    private readonly milliseconds = 1.5,
    private readonly maxSteps = 128,
    private readonly clock: () => number = () => performance.now(),
    private readonly build = buildWmoGroupGeometrySteps,
  ) {}

  /** Mark demand before admission caps: a later placement may still own this room. */
  retain(key: string, source: WmoGroupMesh, frame: number): void {
    if (this.#job?.key !== key) return;
    if (this.#job.source !== source) this.clear();
    else this.#job.wantedFrame = frame;
  }

  request(key: string, model: WmoModel, index: number, frame: number): THREE.BufferGeometry | undefined {
    if (this.#frame !== frame) {
      this.#frame = frame;
      this.#spent = 0;
      this.#steps = 0;
    }
    const source = model.groups[index]?.mesh;
    if (!source) return undefined;
    this.retain(key, source, frame);
    if (this.#job && this.#job.key !== key) return undefined;
    if (this.#spent >= this.milliseconds || this.#steps >= this.maxSteps) return undefined;
    const job = this.#job ??= { key, source, steps: this.build(model, index), wantedFrame: frame };
    const started = this.clock();
    try {
      do {
        this.#steps++;
        const step = job.steps.next();
        if (step.done) {
          this.#job = undefined;
          return step.value;
        }
      } while (this.#steps < this.maxSteps && this.#spent + this.clock() - started < this.milliseconds);
    } catch (error) {
      this.clear();
      throw error;
    } finally {
      this.#spent += this.clock() - started;
    }
    return undefined;
  }

  /** Called after both environment and game-object demand have been visited. */
  finishFrame(frame: number): void {
    if (this.#job && this.#job.wantedFrame !== frame) this.clear();
  }

  clear(): void {
    const job = this.#job;
    this.#job = undefined;
    job?.steps.return(undefined);
  }
}
