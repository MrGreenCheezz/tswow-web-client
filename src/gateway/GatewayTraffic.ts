/**
 * 25.10 (serve S5): what the gateway's HTTP routes answered — per route class, no addresses.
 *
 * Remote players load every asset through this process, and until now nothing said how many requests a
 * session made, how many bytes left the machine or which family was slow. Each answer is counted once,
 * when it finishes: its route class (`trafficRouteClass`, a closed list so a stray URL cannot grow the
 * table), its status (200, 304 or other), the bytes written for its body — after compression, since the
 * counter sits under the compressing layer (ResponseCompression.ts) — and the milliseconds from the
 * request's arrival to the last byte handed to the socket.
 *
 * Per request: one `split`, a few map lookups and two wrapped `write`/`end` calls. Nothing names the
 * caller: no address, no query, no Origin.
 *
 * `startTrafficReporter` prints one line per interval in which there was traffic (60 s by default) and
 * rewrites a JSON snapshot (totals since start plus the last interval) for the owner, by default
 * `.runtime/logs/gateway-traffic.json` (gitignored); `/gateway/traffic` answers the same snapshot to a
 * loopback caller.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";

/** Classes with two path segments (`/visual/model` → `visual-model`); every other class is the first segment. */
const TWO_SEGMENT = new Set(["visual", "client"]);
/** The closed list of classes; anything else is `other`. */
const CLASSES: ReadonlySet<string> = new Set([
  "health", "client-file", "client-interface-bundle", "client-addons", "client-patch-status",
  "dbc", "data", "terrain", "terrain-splat", "terrain-layer", "terrain-texture", "texture",
  "visual-environment", "visual-model", "visual-animations", "visual-doodads", "visual-texture", "visual-wmo-lamps",
  "visual-lit-models", "item-icon", "spell-icon", "creature-icon", "sound", "minimap", "horizon", "world-map",
  "liquid", "environment", "collision", "vmap", "modules", "gateway",
]);

/** The route class of a request path (no query). */
export function trafficRouteClass(pathname: string): string {
  const parts = pathname.split("/", 4);
  const first = parts[1] ?? "";
  const name = TWO_SEGMENT.has(first) && parts[2] ? `${first}-${parts[2]}` : first;
  return CLASSES.has(name) ? name : "other";
}

export interface TrafficCounters {
  count: number;
  /** Body bytes written (after compression). */
  bytes: number;
  status200: number;
  status304: number;
  statusOther: number;
  totalMs: number;
  maxMs: number;
}

function emptyCounters(): TrafficCounters {
  return { count: 0, bytes: 0, status200: 0, status304: 0, statusOther: 0, totalMs: 0, maxMs: 0 };
}

export interface TrafficSnapshot {
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly intervalSeconds: number | undefined;
  readonly totals: Readonly<Record<string, TrafficCounters>>;
  readonly lastInterval: Readonly<Record<string, TrafficCounters>>;
}

function byteLength(chunk: unknown, encoding: unknown): number {
  if (chunk === undefined || chunk === null || typeof chunk === "function") return 0;
  if (typeof chunk === "string") return Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return 0;
}

export class GatewayTraffic {
  readonly #now: () => number;
  readonly #startedAt = new Date();
  readonly #totals = new Map<string, TrafficCounters>();
  #interval = new Map<string, TrafficCounters>();
  #lastInterval = new Map<string, TrafficCounters>();
  #lastIntervalSeconds: number | undefined;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => performance.now());
  }

  /** Counts this answer when it finishes. Call before any route writes to `response`. */
  observe(request: IncomingMessage, response: ServerResponse): void {
    // The native client's stdio dispatcher (LocalAssetStdio.ts) hands in a bare object with no events and
    // no network behind it: nothing to count there.
    if (typeof response.once !== "function") return;
    const started = this.#now();
    const routeClass = trafficRouteClass((request.url ?? "/").split("?", 1)[0] ?? "/");
    let bytes = 0;
    const write = response.write;
    const end = response.end;
    // Counted where the bytes leave: whatever compresses above this sees its own output counted.
    response.write = function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
      bytes += byteLength(chunk, rest[0]);
      return (write as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
    } as ServerResponse["write"];
    response.end = function (this: ServerResponse, chunk?: unknown, ...rest: unknown[]) {
      bytes += byteLength(chunk, rest[0]);
      return (end as (...args: unknown[]) => ServerResponse).call(this, chunk, ...rest);
    } as ServerResponse["end"];
    let counted = false;
    const done = (): void => {
      if (counted) return;
      counted = true;
      this.record(routeClass, response.statusCode, bytes, this.#now() - started);
    };
    response.once("finish", done);
    // A socket that went away mid-answer still costs what it was sent.
    response.once("close", done);
  }

  record(routeClass: string, status: number, bytes: number, ms: number): void {
    for (const table of [this.#totals, this.#interval]) {
      let counters = table.get(routeClass);
      if (!counters) table.set(routeClass, counters = emptyCounters());
      counters.count++;
      counters.bytes += bytes;
      if (status === 200) counters.status200++;
      else if (status === 304) counters.status304++;
      else counters.statusOther++;
      counters.totalMs += ms;
      if (ms > counters.maxMs) counters.maxMs = ms;
    }
  }

  /** Ends the current interval: returns its counters (empty when nothing was answered) and starts a new one. */
  rollInterval(seconds: number): ReadonlyMap<string, TrafficCounters> {
    const finished = this.#interval;
    this.#interval = new Map();
    if (finished.size > 0) {
      this.#lastInterval = finished;
      this.#lastIntervalSeconds = seconds;
    }
    return finished;
  }

  snapshot(): TrafficSnapshot {
    const plain = (table: ReadonlyMap<string, TrafficCounters>) => Object.fromEntries(
      [...table].sort((left, right) => right[1].bytes - left[1].bytes).map(([name, value]) => [name, { ...value,
        totalMs: Math.round(value.totalMs), maxMs: Math.round(value.maxMs) }]));
    return {
      startedAt: this.#startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      intervalSeconds: this.#lastIntervalSeconds,
      totals: plain(this.#totals),
      lastInterval: plain(this.#lastInterval),
    };
  }
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** One line for an interval: the classes by bytes, `class n×/bytes (304 k, err e, max m ms)`; undefined when idle. */
export function formatTrafficLine(interval: ReadonlyMap<string, TrafficCounters>, seconds: number): string | undefined {
  if (interval.size === 0) return undefined;
  let count = 0;
  let bytes = 0;
  const parts: string[] = [];
  for (const [name, value] of [...interval].sort((left, right) => right[1].bytes - left[1].bytes)) {
    count += value.count;
    bytes += value.bytes;
    const notes = [
      ...(value.status304 > 0 ? [`304 ${value.status304}`] : []),
      ...(value.statusOther > 0 ? [`err ${value.statusOther}`] : []),
      `max ${Math.round(value.maxMs)} ms`,
    ];
    parts.push(`${name} ${value.count}×/${megabytes(value.bytes)} (${notes.join(", ")})`);
  }
  return `Gateway traffic, ${seconds} s: ${count} requests, ${megabytes(bytes)} — ${parts.join("; ")}`;
}

export interface TrafficReporterOptions {
  readonly intervalMs?: number;
  /** The JSON snapshot rewritten after every interval with traffic; absent: no file. */
  readonly file?: string;
  readonly log?: (line: string) => void;
}

/** Prints and files the counters every `intervalMs` (default 60 s) in which something was answered. */
export function startTrafficReporter(traffic: GatewayTraffic, options: TrafficReporterOptions): { stop(): void } {
  const intervalMs = options.intervalMs ?? 60_000;
  const log = options.log ?? ((line: string) => console.log(line));
  const seconds = Math.round(intervalMs / 1000);
  let writing: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    const line = formatTrafficLine(traffic.rollInterval(seconds), seconds);
    if (line === undefined) return;
    log(line);
    if (options.file === undefined) return;
    const file = options.file;
    const body = `${JSON.stringify(traffic.snapshot(), null, 1)}\n`;
    // One write at a time, through a temporary name, so a reader never sees half a file.
    writing = writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, body);
      await rename(`${file}.tmp`, file);
    }).catch((error: unknown) => {
      console.warn(`Gateway traffic file not written: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/**
 * The reporter's settings from the environment (`.env.example`): `GATEWAY_TRAFFIC_LOG=0` switches the line
 * and the file off, `GATEWAY_TRAFFIC_INTERVAL_S` (default 60, 5..3600) sets the interval and
 * `GATEWAY_TRAFFIC_FILE` the snapshot (default `<cwd>/.runtime/logs/gateway-traffic.json`). A bad interval
 * throws, so the start fails instead of running with a value nobody chose.
 */
export function parseTrafficReportEnv(env: NodeJS.ProcessEnv, cwd: string): TrafficReporterOptions | undefined {
  if (env["GATEWAY_TRAFFIC_LOG"]?.trim() === "0") return undefined;
  const raw = env["GATEWAY_TRAFFIC_INTERVAL_S"]?.trim();
  const seconds = raw === undefined || raw === "" ? 60 : Number(raw);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
    throw new Error(`Invalid GATEWAY_TRAFFIC_INTERVAL_S: ${raw} (whole seconds, 5..3600)`);
  }
  const file = env["GATEWAY_TRAFFIC_FILE"]?.trim() || join(cwd, ".runtime", "logs", "gateway-traffic.json");
  return { intervalMs: seconds * 1000, file };
}

/** Whether a request comes from this machine's loopback (the `/gateway/traffic` answer is for the owner). */
export function loopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
