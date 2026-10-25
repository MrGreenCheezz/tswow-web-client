/**
 * 25.10 (serve S1): brotli or gzip for the gateway's compressible answers, in one place under every route.
 *
 * Remote players fetch every interface file, table, tile and model through this process, and until now
 * only `/dbc/declined-words` was ever compressed. Measured on this machine's caches (gzip 6 / brotli 4,
 * compressed size as a share of the original; scratch script, samples of up to 12 MB a family):
 *
 * | family                         | gzip 6 | br 4 | gzip ms/MB | br ms/MB |
 * | ------------------------------ | ------ | ---- | ---------- | -------- |
 * | interface `.lua` / `.xml`      | 15 %   | 16 % | 12.7       | 13.8     |
 * | `.ttf` fonts                   | 56 %   | 54 % | 21.7       | 16.7     |
 * | visual tile `.json`            | 16 %   | 15 % | 10.0       | 7.4      |
 * | terrain `.map`                 | 57 %   | 56 % | 12.8       | 9.2      |
 * | splat `cover.bin`              | 29 %   | 30 % | 19.1       | 19.1     |
 * | visual model `.bin` / `.anim`  | 50-59 %| 48 % | 14-17      | 13       |
 * | wmo doodads `.json`            | 20 %   | 18 % | 12.2       | 8.7      |
 * | horizon `.wdl`                 | 30 %   | 28 % | 12.2       | 10.4     |
 * | `items.json` / `creatures.json`| 24 %   | 22 % | 27         | 11       |
 * | PNG textures, icons, splat PNG | 98-100 %| 98-100 %| —      | —        |
 * | `.mp3` / `.wav`                | 99 % / 85 % | — | —         | —        |
 *
 * So: brotli at quality 4 when the caller offers it (it is as fast as gzip 6 and a little smaller;
 * Chromium offers it over HTTPS only, so a player on plain http gets gzip), else gzip at level 6. Images
 * and audio are never tried (their types are outside `compressibleType`); an `application/octet-stream`
 * or text body that does not come out at least 15 % smaller is sent as it was, and that verdict is
 * cached like a compressed body. Bodies under 1 KB or over 16 MB are sent as they are.
 *
 * Compression runs on libuv's thread pool (async zlib), never on the request thread. A compressed body
 * is cached (64 MB, oldest first) when the answer carries an ETag, keyed by encoding, URL and ETag, so a
 * repeated answer is not compressed again; concurrent requests for the same key share one run.
 *
 * HTTP: only a GET answered 200 in one `end(body)` call is compressed; a streamed body, a HEAD, any
 * other status or an answer that already names a `content-encoding` passes through untouched.
 * `Content-Encoding` and the compressed `Content-Length` are set, `Vary` gains `Accept-Encoding` (keeping
 * `Origin`), and a strong ETag becomes weak (`W/`): the same tag over two different byte sequences may
 * not stay strong (RFC 9110 §8.8.1), while `If-None-Match` compares weakly (CachePolicy.ts `etagMatches`),
 * so the browser's 304 keeps working. `fetch()` in the browser and in Electron decodes transparently, and
 * the client's bounded readers (Terrain.ts, CharacterAtlas.ts) count decoded bytes and compare a declared
 * `Content-Length` against an upper limit only, which the compressed length never exceeds.
 */

import zlib from "node:zlib";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

export type ContentEncoding = "br" | "gzip";

export const MIN_COMPRESS_BYTES = 1024;
export const MAX_COMPRESS_BYTES = 16 * 1024 * 1024;
/** A body has to come out at least this much smaller, or it is sent as it was. */
export const MIN_SAVING = 0.15;
export const MAX_COMPRESSED_CACHE_BYTES = 64 * 1024 * 1024;
const BROTLI_QUALITY = 4;
const GZIP_LEVEL = 6;

/** The encoding to answer with: brotli, then gzip, from an `Accept-Encoding` list (q=0 refuses). */
export function chooseEncoding(header: string | string[] | undefined): ContentEncoding | undefined {
  if (header === undefined) return undefined;
  const offered = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(",") : header).split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="));
    const value = q === undefined ? 1 : Number(q.slice(2));
    offered.set(name, Number.isFinite(value) ? value : 0);
  }
  const star = offered.get("*");
  for (const encoding of ["br", "gzip"] as const) {
    if ((offered.get(encoding) ?? star ?? 0) > 0) return encoding;
  }
  return undefined;
}

/** Whether answers of this type are worth trying: text, JSON, XML, fonts, and opaque binaries (tiles, models). */
export function compressibleType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return type.startsWith("text/") || type === "application/json" || type === "application/javascript"
    || type === "application/xml" || type === "image/svg+xml" || type === "application/octet-stream"
    || type === "application/wasm" || type === "font/ttf" || type === "font/otf";
}

/** Marks a body that did not shrink enough: the next request for it is sent as it is without trying. */
const IDENTITY = Symbol("identity");
type CacheEntry = Buffer | typeof IDENTITY;

/** Compressed bodies by key, bounded in bytes; least recently used go first. */
export class CompressionCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #limit: number;
  #bytes = 0;

  constructor(limit = MAX_COMPRESSED_CACHE_BYTES) {
    this.#limit = limit;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get(key: string): CacheEntry | undefined {
    const hit = this.#entries.get(key);
    if (hit === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, hit);
    return hit;
  }

  set(key: string, entry: CacheEntry): void {
    const size = entry === IDENTITY ? 0 : entry.byteLength;
    if (size > this.#limit) return;
    const old = this.#entries.get(key);
    if (old !== undefined && old !== IDENTITY) this.#bytes -= old.byteLength;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#bytes += size;
    for (const [oldest, value] of this.#entries) {
      if (this.#bytes <= this.#limit && this.#entries.size <= 100_000) break;
      this.#entries.delete(oldest);
      if (value !== IDENTITY) this.#bytes -= value.byteLength;
    }
  }
}

export interface CompressionStats {
  /** Bodies compressed (a run, not a cache hit). */
  compressed: number;
  /** Answers served from the cache (compressed or the cached "does not shrink" verdict). */
  cacheHits: number;
  /** Bodies tried that did not shrink by `MIN_SAVING`. */
  incompressible: number;
  /** Source and compressed bytes of the runs. */
  sourceBytes: number;
  outputBytes: number;
}

export interface ResponseCompression {
  readonly cache: CompressionCache;
  readonly stats: CompressionStats;
  readonly inFlight: Map<string, Promise<CacheEntry>>;
}

export function createResponseCompression(cacheBytes = MAX_COMPRESSED_CACHE_BYTES): ResponseCompression {
  return {
    cache: new CompressionCache(cacheBytes),
    stats: { compressed: 0, cacheHits: 0, incompressible: 0, sourceBytes: 0, outputBytes: 0 },
    inFlight: new Map(),
  };
}

function compressBody(encoding: ContentEncoding, body: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer): void => (error ? reject(error) : resolve(result));
    if (encoding === "br") {
      zlib.brotliCompress(body, { params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
      } }, done);
    } else {
      zlib.gzip(body, { level: GZIP_LEVEL }, done);
    }
  });
}

/** One header's value from a header object, whatever its spelling. */
function headerKey(headers: OutgoingHttpHeaders, name: string): string | undefined {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name) return key;
  return undefined;
}

export function headerValue(headers: OutgoingHttpHeaders, name: string): string | undefined {
  const key = headerKey(headers, name);
  if (key === undefined) return undefined;
  const value = headers[key];
  return value === undefined ? undefined : Array.isArray(value) ? value.join(", ") : String(value);
}

/** `headers` with `name` set (replacing any spelling of it). */
export function withHeader(headers: OutgoingHttpHeaders, name: string, value: string | number): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [key, existing] of Object.entries(headers)) if (key.toLowerCase() !== name) result[key] = existing;
  result[name] = value;
  return result;
}

function withVary(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const vary = headerValue(headers, "vary");
  if (vary === undefined) return withHeader(headers, "vary", "Accept-Encoding");
  if (vary.split(",").some((part) => ["accept-encoding", "*"].includes(part.trim().toLowerCase()))) return headers;
  return withHeader(headers, "vary", `${vary}, Accept-Encoding`);
}

export function bodyBuffer(chunk: unknown, encoding: unknown): Buffer | undefined {
  if (typeof chunk === "string") return Buffer.from(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return undefined;
}

/**
 * Makes this response compress its body when it can (see the file comment). Call once per request,
 * before any route writes; a no-op for anything but GET.
 */
export function installCompression(request: IncomingMessage, response: ServerResponse, compression: ResponseCompression): void {
  if (request.method !== "GET") return;
  const encoding = chooseEncoding(request.headers["accept-encoding"]);
  const writeHead = response.writeHead;
  const write = response.write;
  const end = response.end;
  const callWriteHead = (status: number, reason: string | undefined, headers: OutgoingHttpHeaders): void => {
    if (reason === undefined) (writeHead as (s: number, h: OutgoingHttpHeaders) => ServerResponse).call(response, status, headers);
    else (writeHead as (s: number, r: string, h: OutgoingHttpHeaders) => ServerResponse).call(response, status, reason, headers);
  };
  /** A 200 whose head waits for its body, so the head can name the encoding. */
  let held: { status: number; reason: string | undefined; headers: OutgoingHttpHeaders } | undefined;
  let finishing = false;

  const flushHeld = (): void => {
    if (!held) return;
    const { status, reason, headers } = held;
    held = undefined;
    callWriteHead(status, reason, headers);
  };

  response.writeHead = function (this: ServerResponse, status: number, ...rest: unknown[]): ServerResponse {
    if (finishing) return response;
    const reason = typeof rest[0] === "string" ? rest[0] : undefined;
    const raw = typeof rest[0] === "string" ? rest[1] : rest[0];
    if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
      return (writeHead as (...args: unknown[]) => ServerResponse).call(this, status, ...rest);
    }
    let headers = (raw ?? {}) as OutgoingHttpHeaders;
    if (status === 304) {
      // The browser revalidates with the weak tag a compressed 200 carried: the 304 names it the same way,
      // so the stored copy keeps the tag it was filed under.
      const etag = headerValue(headers, "etag");
      const asked = request.headers["if-none-match"];
      if (etag !== undefined && !etag.startsWith("W/") && asked !== undefined
        && (Array.isArray(asked) ? asked.join(",") : asked).split(",").some((value) => value.trim() === `W/${etag}`)) {
        headers = withHeader(headers, "etag", `W/${etag}`);
      }
    }
    const compressible = compressibleType(headerValue(headers, "content-type"))
      && headerValue(headers, "content-encoding") === undefined;
    if (!compressible || (status !== 200 && status !== 304)) {
      callWriteHead(status, reason, headers);
      return response;
    }
    // Whatever this caller is sent, another caller of the same URL may be sent the other encoding.
    const varied = withVary(headers);
    if (status !== 200 || encoding === undefined) {
      callWriteHead(status, reason, varied);
      return response;
    }
    held = { status, reason, headers: varied };
    return response;
  } as ServerResponse["writeHead"];

  response.write = function (this: ServerResponse, ...args: unknown[]): boolean {
    // A streamed body is sent as it is: the held head goes out unchanged first.
    flushHeld();
    return (write as (...a: unknown[]) => boolean).apply(this, args);
  } as ServerResponse["write"];

  response.end = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
    if (finishing) return response;
    if (!held || encoding === undefined) {
      flushHeld();
      return (end as (...a: unknown[]) => ServerResponse).apply(this, args);
    }
    const [chunk, second, third] = args;
    const callback = [second, third].find((value): value is () => void => typeof value === "function");
    const body = bodyBuffer(chunk, second);
    if (body === undefined || body.byteLength < MIN_COMPRESS_BYTES || body.byteLength > MAX_COMPRESS_BYTES) {
      flushHeld();
      return (end as (...a: unknown[]) => ServerResponse).apply(this, args);
    }
    const { status, reason, headers } = held;
    held = undefined;
    finishing = true;
    const sendIdentity = (): void => {
      callWriteHead(status, reason, withHeader(headers, "content-length", body.byteLength));
      (end as (b: Buffer, cb?: () => void) => ServerResponse).call(response, body, callback);
    };
    const sendCompressed = (compressed: Buffer): void => {
      let out = withHeader(withHeader(headers, "content-encoding", encoding), "content-length", compressed.byteLength);
      const etag = headerValue(out, "etag");
      if (etag !== undefined && !etag.startsWith("W/")) out = withHeader(out, "etag", `W/${etag}`);
      callWriteHead(status, reason, out);
      (end as (b: Buffer, cb?: () => void) => ServerResponse).call(response, compressed, callback);
    };
    const send = (entry: CacheEntry): void => {
      if (response.destroyed) return;
      if (entry === IDENTITY) sendIdentity();
      else sendCompressed(entry);
    };
    const etag = headerValue(headers, "etag");
    const key = etag === undefined ? undefined : `${encoding}\0${request.url ?? ""}\0${etag}`;
    const cached = key === undefined ? undefined : compression.cache.get(key);
    if (cached !== undefined) {
      compression.stats.cacheHits++;
      send(cached);
      return response;
    }
    let run = key === undefined ? undefined : compression.inFlight.get(key);
    if (!run) {
      run = compressBody(encoding, body).then((compressed): CacheEntry => {
        compression.stats.compressed++;
        compression.stats.sourceBytes += body.byteLength;
        compression.stats.outputBytes += compressed.byteLength;
        if (compressed.byteLength > body.byteLength * (1 - MIN_SAVING)) {
          compression.stats.incompressible++;
          return IDENTITY;
        }
        return compressed;
      });
      if (key !== undefined) {
        const pending = run;
        compression.inFlight.set(key, pending);
        void pending.then((entry) => compression.cache.set(key, entry), () => undefined)
          .finally(() => { if (compression.inFlight.get(key) === pending) compression.inFlight.delete(key); });
      }
    }
    run.then(send, () => { if (!response.destroyed) sendIdentity(); });
    return response;
  } as ServerResponse["end"];
}
