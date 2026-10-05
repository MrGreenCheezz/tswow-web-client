import type { EnvironmentObject } from "../gateway/VMapProtocol.js";

/** Keep each structured-clone task small even for a dense city tile. */
export const ENVIRONMENT_TILE_MESSAGE_OBJECTS = 256;

export interface EnvironmentTileDecodeRequest {
  readonly id: number;
  readonly data: ArrayBuffer;
}

export type EnvironmentTileDecodeResponse =
  | { readonly id: number; readonly offset: number; readonly objects: EnvironmentObject[] }
  // 05.10-A7b-1 (7.19): `rejected`/`truncated` — what the per-object check left out.
  | { readonly id: number; readonly done: true; readonly total: number; readonly rejected?: number; readonly truncated?: number }
  | { readonly id: number; readonly error: string };

/**
 * 05.10-A7b-1 (M-A7b-1): `?v=` of `/visual/environment` — the `visual-tile-v5` generation. The route
 * matches the path only; the version keeps a browser from reusing a v4 answer it cached before the
 * gateway restart. The client reads both: v5 adds only optional fields and `interior: false` doodads.
 */
export const VISUAL_TILE_ROUTE_VERSION = 5;

/**
 * 05.10-A7b-1 (7.19): a diagnostics line for what one tile could not carry — objects the check left
 * out, objects past the cap here, and doodads the generator's cap cut (`X-Tile-Truncated`) — or
 * undefined when nothing was lost.
 */
export function environmentTileLosses(report: EnvironmentTileDecodeResult, truncatedHeader?: string | null): string | undefined {
  const generator = truncatedHeader && /^\d{1,7}$/.test(truncatedHeader) ? Number(truncatedHeader) : 0;
  const parts: string[] = [];
  if (report.rejected > 0) parts.push(`${report.rejected} unreadable object(s) left out`);
  if (report.truncated > 0) parts.push(`${report.truncated} object(s) past ${ENVIRONMENT_TILE_OBJECT_LIMIT} cut`);
  if (generator > 0) parts.push(`${generator} WMO doodad(s) cut by the generator`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** 05.10-A7b-9 (7.18): the WMO doodads the generator cut, read from `X-Tile-Truncated` as above. */
export function environmentTileGeneratorCut(truncatedHeader?: string | null): number {
  return truncatedHeader && /^\d{1,7}$/.test(truncatedHeader) ? Number(truncatedHeader) : 0;
}

/** The visual tile's object cap; the generator stops at the same number (`generate-visual-tile.mjs`). */
export const ENVIRONMENT_TILE_OBJECT_LIMIT = 10_000;

/**
 * 05.10-A7b-1 (7.19): a decoded tile and what it could not keep. `rejected` objects failed the
 * per-object check (a field this client cannot read); `truncated` were past the object cap.
 */
export interface EnvironmentTileDecodeResult {
  readonly objects: EnvironmentObject[];
  readonly rejected: number;
  readonly truncated: number;
}

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
  readonly resolve: (result: EnvironmentTileDecodeResult) => void;
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
  return decodeEnvironmentTileReport(data).objects;
}

/** 05.10-A7b-1 (7.19): {@link decodeEnvironmentTile} with what the per-object check left out. */
export function decodeEnvironmentTileReport(data: ArrayBuffer): EnvironmentTileDecodeResult {
  return validateEnvironmentTileReport(JSON.parse(new TextDecoder().decode(data)));
}

export function validateEnvironmentTile(value: unknown): EnvironmentObject[] {
  return validateEnvironmentTileReport(value).objects;
}

/**
 * 05.10-A7b-1 (7.19): checks a tile object by object. Before, one object with a field this client
 * could not read — or one object past the cap — failed the whole tile, and the cell lost every
 * building and tree on it. Now that object is left out and counted (`rejected`), and objects past
 * {@link ENVIRONMENT_TILE_OBJECT_LIMIT} are cut and counted (`truncated`). Doodad ids carry their own
 * ordinal, so leaving one out renumbers nothing. A tile in which no object at all is readable is
 * still an error: that is a format this client does not know, not one bad record. A tile that is
 * entirely valid and within the cap is returned as it came — the usual case allocates nothing.
 */
export function validateEnvironmentTileReport(value: unknown): EnvironmentTileDecodeResult {
  if (!Array.isArray(value)) throw new Error("Environment gateway returned invalid objects");
  let kept: EnvironmentObject[] | undefined;
  let rejected = 0;
  let truncated = 0;
  for (let index = 0; index < value.length; index++) {
    const object: unknown = value[index];
    if (!isEnvironmentObject(object)) {
      // First casualty: from here on the readable objects are copied into their own list.
      kept ??= value.slice(0, index) as EnvironmentObject[];
      rejected++;
      continue;
    }
    const count = kept ? kept.length : index;
    if (count >= ENVIRONMENT_TILE_OBJECT_LIMIT) {
      kept ??= value.slice(0, index) as EnvironmentObject[];
      truncated++;
      continue;
    }
    kept?.push(object);
  }
  if (rejected > 0 && rejected === value.length) throw new Error("Environment gateway returned invalid objects");
  return { objects: kept ?? (value as EnvironmentObject[]), rejected, truncated };
}

/**
 * The worker's answer to one request, as the messages it posts: the objects in bounded slices, then
 * `done` with the counts (05.10-A7b-1), or one `error`. `EnvironmentTileDecode.worker.ts` posts them.
 */
export function* environmentTileDecodeMessages(request: EnvironmentTileDecodeRequest): Generator<EnvironmentTileDecodeResponse, void, void> {
  let report: EnvironmentTileDecodeResult;
  try {
    report = decodeEnvironmentTileReport(request.data);
  } catch (error) {
    yield { id: request.id, error: error instanceof Error ? error.message : String(error) };
    return;
  }
  let offset = 0;
  for (const chunk of environmentTileChunks(report.objects)) {
    yield { id: request.id, offset, objects: chunk };
    offset += chunk.length;
  }
  yield { id: request.id, done: true, total: report.objects.length, rejected: report.rejected, truncated: report.truncated };
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
    return (await this.decodeResponseReport(response, signal)).objects;
  }

  /** 05.10-A7b-1 (7.19): {@link decodeResponse} with what the per-object check left out. */
  async decodeResponseReport(response: Response, signal?: AbortSignal): Promise<EnvironmentTileDecodeResult> {
    if (this.#disposed || signal?.aborted) throw abortedDecode();
    // Source tests and Node tools keep their existing Response.json() contract.
    if (!this.#workerAvailable) return validateEnvironmentTileReport(await response.json());
    const data = await response.arrayBuffer();
    return this.decodeReport(data, signal);
  }

  async decode(data: ArrayBuffer, signal?: AbortSignal): Promise<EnvironmentObject[]> {
    return (await this.decodeReport(data, signal)).objects;
  }

  /** 05.10-A7b-1 (7.19): {@link decode} with what the per-object check left out. */
  decodeReport(data: ArrayBuffer, signal?: AbortSignal): Promise<EnvironmentTileDecodeResult> {
    if (this.#disposed || signal?.aborted) return Promise.reject(abortedDecode());
    let worker = this.#worker;
    if (!worker) {
      try { worker = this.#createWorker(); }
      catch { /* A blocked worker must not hide the scenery. */ }
      if (!worker) {
        try { return Promise.resolve(decodeEnvironmentTileReport(data)); }
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
      // 05.10-A7b-1 (7.19): an older worker script sends no counts.
      this.#settle(job, { objects: job.objects, rejected: count(message.rejected), truncated: count(message.truncated) });
      return;
    }
    this.#failWorker(new Error("Environment tile worker returned an invalid chunk"));
  }

  #cancel(id: number): void {
    const job = this.#jobs.get(id);
    if (job) this.#settle(job, undefined, abortedDecode());
  }

  #settle(job: DecodeJob, value?: EnvironmentTileDecodeResult, error?: unknown): void {
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

function unsignedInteger(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/** A worker-reported count: a non-negative integer, else 0. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
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
  // 05.10-A7b-1 (7.13): a WMO placement's WMOAreaTable key — MOHD.wmoID (u32) and MODF.nameSet (u16).
  if (object.wmoId !== undefined && (object.kind !== "wmo" || !unsignedInteger(object.wmoId, 0xffff_ffff))) return false;
  if (object.nameSet !== undefined && (object.kind !== "wmo" || !unsignedInteger(object.nameSet, 0xffff))) return false;
  const quaternion = [object.quaternionX, object.quaternionY, object.quaternionZ, object.quaternionW];
  if (quaternion.some((item) => item !== undefined) && !quaternion.every((item) => typeof item === "number" && Number.isFinite(item))) return false;
  if (object.bounds === undefined) return true;
  if (!object.bounds || typeof object.bounds !== "object") return false;
  const bounds = object.bounds as Record<string, unknown>;
  return ["minX", "minY", "minZ", "maxX", "maxY", "maxZ"]
    .every((key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]));
}
