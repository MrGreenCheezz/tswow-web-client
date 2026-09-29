import type { EnvironmentObject } from "../gateway/VMapProtocol.js";

/** Keep each structured-clone task small even for a dense city tile. */
export const ENVIRONMENT_TILE_MESSAGE_OBJECTS = 256;

export interface EnvironmentTileDecodeRequest {
  readonly id: number;
  readonly data: ArrayBuffer;
}

export type EnvironmentTileDecodeResponse =
  | { readonly id: number; readonly offset: number; readonly objects: EnvironmentObject[] }
  | { readonly id: number; readonly done: true; readonly total: number }
  | { readonly id: number; readonly error: string };

export interface EnvironmentTileWorker {
  onmessage: ((event: MessageEvent<EnvironmentTileDecodeResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: EnvironmentTileDecodeRequest, transfer: ArrayBuffer[]): void;
  terminate(): void;
}

interface DecodeJob {
  readonly id: number;
  readonly objects: EnvironmentObject[];
  readonly resolve: (objects: EnvironmentObject[]) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
}

function createTileWorker(): EnvironmentTileWorker | undefined {
  if (typeof Worker === "undefined") return undefined;
  return new Worker(new URL("./EnvironmentTileDecode.worker.ts", import.meta.url), {
    type: "module", name: "environment-tile-decode",
  });
}

/** Parse and validate before any chunk is published to the renderer. */
export function decodeEnvironmentTile(data: ArrayBuffer): EnvironmentObject[] {
  return validateEnvironmentTile(JSON.parse(new TextDecoder().decode(data)));
}

export function validateEnvironmentTile(value: unknown): EnvironmentObject[] {
  if (!Array.isArray(value) || value.length > 10_000 || !value.every(isEnvironmentObject)) {
    throw new Error("Environment gateway returned invalid objects");
  }
  return value;
}

/** The worker sends one message per slice; the main thread never clones a whole city at once. */
export function* environmentTileChunks(objects: EnvironmentObject[]): Generator<EnvironmentObject[], void, void> {
  for (let start = 0; start < objects.length; start += ENVIRONMENT_TILE_MESSAGE_OBJECTS) {
    yield objects.slice(start, start + ENVIRONMENT_TILE_MESSAGE_OBJECTS);
  }
}

/** One worker shared by all in-flight tile responses; disposal drops work from an old world. */
export class EnvironmentTileDecodeClient {
  readonly #jobs = new Map<number, DecodeJob>();
  readonly #createWorker: () => EnvironmentTileWorker | undefined;
  readonly #workerAvailable: boolean;
  #worker: EnvironmentTileWorker | undefined;
  #nextId = 1;
  #disposed = false;

  constructor(createWorker?: () => EnvironmentTileWorker | undefined) {
    this.#createWorker = createWorker ?? createTileWorker;
    this.#workerAvailable = createWorker !== undefined || typeof Worker !== "undefined";
  }

  async decodeResponse(response: Response, signal?: AbortSignal): Promise<EnvironmentObject[]> {
    if (this.#disposed || signal?.aborted) throw abortedDecode();
    // Source tests and Node tools keep their existing Response.json() contract.
    if (!this.#workerAvailable) return validateEnvironmentTile(await response.json());
    const data = await response.arrayBuffer();
    return this.decode(data, signal);
  }

  decode(data: ArrayBuffer, signal?: AbortSignal): Promise<EnvironmentObject[]> {
    if (this.#disposed || signal?.aborted) return Promise.reject(abortedDecode());
    let worker = this.#worker;
    if (!worker) {
      try { worker = this.#createWorker(); }
      catch { /* A blocked worker must not hide the scenery. */ }
      if (!worker) {
        try { return Promise.resolve(decodeEnvironmentTile(data)); }
        catch (error) { return Promise.reject(error); }
      }
      this.#worker = worker;
      worker.onmessage = ({ data: message }) => this.#receive(message);
      worker.onerror = (event) => this.#failWorker(new Error(event.message || "Environment tile worker failed"));
      worker.onmessageerror = () => this.#failWorker(new Error("Environment tile worker response could not be read"));
    }
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const job: DecodeJob = {
        id, objects: [], resolve, reject, signal,
        abort: () => this.#cancel(id),
      };
      this.#jobs.set(id, job);
      signal?.addEventListener("abort", job.abort, { once: true });
      try { worker.postMessage({ id, data }, [data]); }
      catch (error) { this.#settle(job, undefined, error); }
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#dropWorker();
    for (const job of [...this.#jobs.values()]) this.#settle(job, undefined, abortedDecode());
  }

  #receive(message: EnvironmentTileDecodeResponse): void {
    const job = this.#jobs.get(message?.id);
    if (!job) return; // Cancelled response from an old tile.
    if ("error" in message && typeof message.error === "string") {
      this.#settle(job, undefined, new Error(message.error));
      return;
    }
    if ("objects" in message && Array.isArray(message.objects)
      && message.objects.length > 0 && message.objects.length <= ENVIRONMENT_TILE_MESSAGE_OBJECTS
      && message.offset === job.objects.length) {
      job.objects.push(...message.objects);
      return;
    }
    if ("done" in message && message.done === true && message.total === job.objects.length) {
      this.#settle(job, job.objects);
      return;
    }
    this.#failWorker(new Error("Environment tile worker returned an invalid chunk"));
  }

  #cancel(id: number): void {
    const job = this.#jobs.get(id);
    if (job) this.#settle(job, undefined, abortedDecode());
  }

  #settle(job: DecodeJob, value?: EnvironmentObject[], error?: unknown): void {
    if (this.#jobs.get(job.id) !== job) return;
    this.#jobs.delete(job.id);
    job.signal?.removeEventListener("abort", job.abort);
    if (value) job.resolve(value);
    else job.reject(error);
  }

  #failWorker(error: Error): void {
    this.#dropWorker();
    for (const job of [...this.#jobs.values()]) this.#settle(job, undefined, error);
  }

  #dropWorker(): void {
    const worker = this.#worker;
    this.#worker = undefined;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }
}

function abortedDecode(): Error {
  const error = new Error("Environment tile decode was cancelled");
  error.name = "AbortError";
  return error;
}

function isEnvironmentObject(value: unknown): value is EnvironmentObject {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  const numbers = ["id", "x", "y", "z", "rotationX", "rotationY", "rotationZ", "scale"];
  if (!numbers.every((key) => typeof object[key] === "number" && Number.isFinite(object[key]))) return false;
  if ((object.kind !== "m2" && object.kind !== "wmo") || typeof object.name !== "string") return false;
  if (object.interior !== undefined && typeof object.interior !== "boolean") return false;
  if (object.doodadSet !== undefined && (!Number.isInteger(object.doodadSet) || (object.doodadSet as number) < 0)) return false;
  if (object.tint !== undefined) {
    if (!Array.isArray(object.tint) || object.tint.length !== 4) return false;
    if (!object.tint.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) return false;
  }
  if (object.localLight !== undefined) {
    if (!Array.isArray(object.localLight) || object.localLight.length !== 4) return false;
    if (!object.localLight.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) return false;
  }
  if (object.admissionRadius !== undefined
    && (object.kind !== "m2" || typeof object.admissionRadius !== "number"
      || !Number.isFinite(object.admissionRadius) || object.admissionRadius < 0)) return false;
  const quaternion = [object.quaternionX, object.quaternionY, object.quaternionZ, object.quaternionW];
  if (quaternion.some((item) => item !== undefined) && !quaternion.every((item) => typeof item === "number" && Number.isFinite(item))) return false;
  if (object.bounds === undefined) return true;
  if (!object.bounds || typeof object.bounds !== "object") return false;
  const bounds = object.bounds as Record<string, unknown>;
  return ["minX", "minY", "minZ", "maxX", "maxY", "maxZ"]
    .every((key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]));
}
