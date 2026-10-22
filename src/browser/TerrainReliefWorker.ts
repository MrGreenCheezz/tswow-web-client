import { deriveTerrainRelief } from "./TerrainReliefDerive.js";

/**
 * 22.10 (7.47): the derivation of a ground texture's relief map off the drawing thread. One worker
 * for every terrain client in this thread (the page, or the render worker), started on first use;
 * where there is no `Worker` (Node, a context that refuses one) or it fails, the same pure function
 * runs inline, one layer per macrotask. A layer costs ≈ 3–5 ms of worker time (256² → 128²).
 */

export interface TerrainReliefRequest {
  readonly id: number;
  readonly pixels: Uint8ClampedArray;
  readonly size: number;
  readonly mask?: Uint8ClampedArray | undefined;
}

export type TerrainReliefResponse =
  | { readonly id: number; readonly relief: Uint8Array; readonly error?: undefined }
  | { readonly id: number; readonly error: string; readonly relief?: undefined };

interface ReliefWorker {
  onmessage: ((event: MessageEvent<TerrainReliefResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: TerrainReliefRequest, transfer: Transferable[]): void;
  terminate(): void;
}

interface Job {
  readonly resolve: (relief: Uint8Array) => void;
  readonly reject: (reason: unknown) => void;
  /** The originals (the worker got copies), for the inline fallback when the worker dies. */
  readonly pixels: Uint8ClampedArray;
  readonly size: number;
  readonly mask: Uint8ClampedArray | undefined;
}

let worker: ReliefWorker | undefined;
let broken = false;
let nextId = 1;
const jobs = new Map<number, Job>();

function createWorker(): ReliefWorker | undefined {
  if (broken || typeof Worker === "undefined") return undefined;
  try {
    return new Worker(new URL("./TerrainRelief.worker.ts", import.meta.url), {
      type: "module", name: "terrain-relief",
    }) as unknown as ReliefWorker;
  } catch {
    broken = true;
    return undefined;
  }
}

function workerOrUndefined(): ReliefWorker | undefined {
  if (worker || broken) return worker;
  worker = createWorker();
  if (!worker) return undefined;
  worker.onmessage = ({ data }) => {
    const job = jobs.get(data.id);
    if (!job) return;
    jobs.delete(data.id);
    if (data.relief) job.resolve(data.relief);
    else job.reject(new Error(data.error ?? "terrain relief failed"));
  };
  worker.onerror = () => {
    // A worker that cannot load (a bundle without it): its jobs and every later one run inline.
    broken = true;
    worker?.terminate();
    worker = undefined;
    const pending = [...jobs.values()];
    jobs.clear();
    for (const job of pending) inline(job.pixels, job.size, job.mask).then(job.resolve, job.reject);
  };
  return worker;
}

/**
 * 22.10 (7.47): the relief map of one layer (`size`² RGBA, optional mask of the same size). The
 * inputs are copied, never transferred: they are the shared decoded layers.
 */
export function deriveTerrainReliefAsync(
  pixels: Uint8ClampedArray, size: number, mask?: Uint8ClampedArray,
): Promise<Uint8Array> {
  const target = workerOrUndefined();
  if (!target) return inline(pixels, size, mask);
  const id = nextId++;
  const copy = pixels.slice();
  const maskCopy = mask?.slice();
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, pixels, size, mask });
    try {
      target.postMessage({ id, pixels: copy, size, ...(maskCopy ? { mask: maskCopy } : {}) },
        maskCopy ? [copy.buffer, maskCopy.buffer] : [copy.buffer]);
    } catch (error) {
      jobs.delete(id);
      reject(error);
    }
  });
}

function inline(pixels: Uint8ClampedArray, size: number, mask: Uint8ClampedArray | undefined): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(deriveTerrainRelief({ pixels, size, mask })); } catch (error) { reject(error); }
    }, 0);
  });
}
