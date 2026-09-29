import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, type Writable } from "node:stream";
import type { GatewayAssetHandler } from "./Gateway.js";

const MAX_REQUEST_BYTES = 16384;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_PENDING = 64;
const MAX_ACTIVE = 2;
export const LOCAL_ASSET_ORIGIN = "http://local.assets";

interface Job { id: number; route: string; byteLimit: number; cancelled: boolean }

export interface LocalAssetReadyMetadata {
  /** Absolute directory selected after local MPQ overlays rebuilt the active DBC snapshot. */
  activeDbcDirectory?: string;
}

/** Binary responses keep large model buffers out of JSON and avoid base64 copies. */
export async function serveLocalAssets(input: Readable, output: Writable,
  assets: GatewayAssetHandler, readyMetadata: LocalAssetReadyMetadata = {}): Promise<void> {
  const jobs = new Map<number, Job>();
  const queue: Job[] = [];
  let active = 0;
  let closed = false;
  let lastId = 0;
  let pending = Buffer.alloc(0);
  let writing = Promise.resolve();
  let complete!: () => void;
  let fail!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  function stop(error?: Error): void {
    if (closed) return;
    closed = true;
    for (const job of jobs.values()) job.cancelled = true;
    jobs.clear(); queue.length = 0;
    input.off("data", consume); input.off("end", ended); input.off("error", failed);
    output.off("error", failed);
    assets.close();
    if (error) fail(error); else complete();
  }
  const failed = (error: Error): void => stop(error);
  const ended = (): void => stop(pending.length ? new Error("Incomplete local asset request") : undefined);
  function write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      output.write(bytes, (error?: Error | null) => error ? reject(error) : resolve());
    });
  }
  function send(header: object, bytes?: Uint8Array): Promise<void> {
    const next = writing.then(async () => {
      if (closed) return;
      await write(Buffer.from(JSON.stringify(header) + "\n"));
      if (bytes?.byteLength) await write(bytes);
    });
    writing = next.catch(failed);
    return next;
  }
  function dispatch(job: Job): Promise<void> {
    return new Promise((resolve) => {
      let status = 200;
      let ended = false;
      const request = Readable.from([]) as IncomingMessage;
      request.method = "GET"; request.url = "/" + job.route;
      request.headers = { origin: LOCAL_ASSET_ORIGIN };
      Object.defineProperty(request, "socket", { value: { remoteAddress: "127.0.0.1" } });
      const response = {
        headersSent: false,
        writeHead(code: number) { status = code; this.headersSent = true; return this; },
        end(body?: string | Uint8Array) {
          if (ended) return this;
          ended = true;
          const bytes = typeof body === "string" ? Buffer.from(body) : body ?? Buffer.alloc(0);
          if (job.cancelled || closed) { resolve(); return this; }
          const tooLarge = bytes.byteLength > job.byteLimit;
          void send({ id: job.id, status: tooLarge ? 413 : status,
            length: tooLarge ? 0 : bytes.byteLength }, tooLarge ? undefined : bytes).then(resolve, () => resolve());
          return this;
        },
        destroy() { status = 500; this.end(); return this; },
      };
      try { assets.handle(request, response as unknown as ServerResponse); }
      catch { response.destroy(); }
    });
  }
  function pump(): void {
    while (!closed && active < MAX_ACTIVE && queue.length) {
      const job = queue.shift()!;
      if (job.cancelled) continue;
      active++;
      void dispatch(job).finally(() => { active--; jobs.delete(job.id); pump(); });
    }
  }
  function accept(line: Buffer): void {
    let message: { id?: unknown; route?: unknown; byteLimit?: unknown; cancel?: unknown };
    try { message = JSON.parse(line.toString("utf8")) as typeof message; }
    catch { throw new Error("Invalid local asset request JSON"); }
    if (!message || typeof message !== "object") throw new Error("Invalid local asset request");
    if (message.cancel !== undefined) {
      if (!Number.isSafeInteger(message.cancel) || Number(message.cancel) <= 0) throw new Error("Invalid cancellation ID");
      const job = jobs.get(Number(message.cancel));
      if (job) { job.cancelled = true; jobs.delete(job.id); }
      return;
    }
    const { id, route, byteLimit } = message;
    // Monotonic IDs prevent late cancellation/response from targeting a newer request.
    if (!Number.isSafeInteger(id) || Number(id) <= lastId) throw new Error("Request IDs must increase");
    lastId = Number(id);
    if (typeof route !== "string" || !route || route.length > 8192 || /^[\/]/.test(route)
      || /[\\\r\n\0#]/.test(route) || !Number.isInteger(byteLimit)
      || Number(byteLimit) < 1 || Number(byteLimit) > MAX_RESPONSE_BYTES) {
      throw new Error("Invalid local asset route or byte limit");
    }
    if (jobs.size >= MAX_PENDING || queue.length >= MAX_PENDING) throw new Error("Local asset request queue is full");
    const job: Job = { id: Number(id), route, byteLimit: Number(byteLimit), cancelled: false };
    jobs.set(job.id, job); queue.push(job); pump();
  }
  function consume(chunk: Buffer | string): void {
    if (closed) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let offset = 0;
    try {
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        const end = newline < 0 ? bytes.length : newline;
        if (pending.length + end - offset > MAX_REQUEST_BYTES) throw new Error("Local asset request exceeds limit");
        pending = Buffer.concat([pending, bytes.subarray(offset, end)]);
        if (newline < 0) break;
        const line = pending; pending = Buffer.alloc(0);
        accept(line); offset = newline + 1;
      }
    } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
  }
  input.on("data", consume); input.once("end", ended); input.once("error", failed);
  output.once("error", failed);
  void send({ ready: true, protocol: 1,
    ...(readyMetadata.activeDbcDirectory
      ? { activeDbcDirectory: readyMetadata.activeDbcDirectory }
      : {}) }).catch(failed);
  await finished;
}
