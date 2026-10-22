import { loadWmoRelief, type WmoReliefAnswer } from "./WmoReliefLoad.js";

/**
 * 22.10 (7.47 stage 2): building-texture relief off the drawing thread. One worker for this thread
 * (the page, or the render worker), started on first use; it fetches the texture itself, so nothing
 * but a URL crosses over. Where there is no `Worker` or it fails to load, the same function runs
 * inline. At most {@link WMO_RELIEF_IN_FLIGHT} textures are in flight at once, so a city arriving
 * with two hundred materials queues instead of opening two hundred requests; a texture costs about
 * 3 ms of worker time (256² read, 128² map), 25 ms for the rare 1024².
 */

export interface WmoReliefRequest {
  readonly id: number;
  readonly url: string;
}

export type WmoReliefResponse =
  | ({ readonly id: number; readonly error?: undefined } & WmoReliefAnswer)
  | { readonly id: number; readonly error: string };

export const WMO_RELIEF_IN_FLIGHT = 4;

interface ReliefWorker {
  onmessage: ((event: MessageEvent<WmoReliefResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: WmoReliefRequest, transfer: Transferable[]): void;
  terminate(): void;
}

interface Job {
  readonly url: string;
  readonly resolve: (answer: WmoReliefAnswer) => void;
  readonly reject: (reason: unknown) => void;
}

let worker: ReliefWorker | undefined;
let broken = false;
let nextId = 1;
const running = new Map<number, Job>();
const queued: Job[] = [];

function workerOrUndefined(): ReliefWorker | undefined {
  if (worker || broken) return worker;
  if (typeof Worker === "undefined") {
    broken = true;
    return undefined;
  }
  try {
    worker = new Worker(new URL("./WmoRelief.worker.ts", import.meta.url), {
      type: "module", name: "wmo-relief",
    }) as unknown as ReliefWorker;
  } catch {
    broken = true;
    return undefined;
  }
  worker.onmessage = ({ data }) => {
    const job = running.get(data.id);
    if (!job) return;
    running.delete(data.id);
    if (data.error !== undefined) job.reject(new Error(data.error));
    else job.resolve(data.relief ? { relief: data.relief, side: data.side, contrast: data.contrast } : { side: 0, contrast: data.contrast });
    pump();
  };
  worker.onerror = () => {
    // A worker that cannot load: its jobs and every later one run inline.
    broken = true;
    worker?.terminate();
    worker = undefined;
    const pending = [...running.values()];
    running.clear();
    for (const job of pending) queued.unshift(job);
    pump();
  };
  return worker;
}

function pump(): void {
  while (running.size < WMO_RELIEF_IN_FLIGHT && queued.length > 0) {
    const job = queued.shift()!;
    const id = nextId++;
    running.set(id, job);
    const target = workerOrUndefined();
    if (!target) {
      setTimeout(() => {
        loadWmoRelief(job.url).then(job.resolve, job.reject).finally(() => {
          running.delete(id);
          pump();
        });
      }, 0);
      continue;
    }
    try {
      target.postMessage({ id, url: job.url }, []);
    } catch (error) {
      running.delete(id);
      job.reject(error);
    }
  }
}

/** 22.10 (7.47 stage 2): the relief of the texture at `url` (absolute), derived in the relief worker. */
export function deriveWmoReliefAsync(url: string): Promise<WmoReliefAnswer> {
  return new Promise((resolve, reject) => {
    queued.push({ url, resolve, reject });
    pump();
  });
}

/** 22.10 (7.47 stage 2): derivations waiting or running (diagnostics). */
export function wmoReliefJobsPending(): number {
  return running.size + queued.length;
}
