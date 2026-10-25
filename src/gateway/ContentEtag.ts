/**
 * 25.10 (serve S2): a validator for every 200 that has none, so a revalidating copy costs a 304.
 *
 * The tile routes (terrain, splat, visual environment, horizon, minimap index, icons, vmap models …)
 * sent no ETag at all: a URL without `g` or with another generation is revalidated (CachePolicy.ts
 * `tileCacheControl`), and every revalidation was a full download. This layer, the innermost of the three
 * above the routes (GatewayTraffic → ResponseCompression → this), holds a GET's 200 head that names no
 * `etag`, and when the body arrives in one `end(body)` call names it by its bytes (`contentEtag`): the
 * same after a restart, moved by any rewrite. A matching `If-None-Match` is answered 304 with the route's
 * own headers (no `content-length`, no body); otherwise the 200 goes out with the tag, and the compressing
 * layer can file its compressed copy under it.
 *
 * Left alone: other methods and statuses, a head that already has a tag (the dataset, file and content-tag
 * routes keep theirs), `no-store` answers, streamed bodies and bodies over 16 MB. The cost is one SHA-1 of
 * the body (≈1 ms per MB) on answers that were already read whole into memory.
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { contentEtag, etagMatches } from "./CachePolicy.js";
import { bodyBuffer, headerValue, withHeader } from "./ResponseCompression.js";

const MAX_TAGGED_BYTES = 16 * 1024 * 1024;

function without(headers: OutgoingHttpHeaders, name: string): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() !== name) result[key] = value;
  return result;
}

/** Gives this response's untagged 200 a content tag (see the file comment). Call once, before any route writes. */
export function installContentEtag(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "GET") return;
  const writeHead = response.writeHead;
  const write = response.write;
  const end = response.end;
  let held: { reason: string | undefined; headers: OutgoingHttpHeaders } | undefined;
  const sendHead = (status: number, reason: string | undefined, headers: OutgoingHttpHeaders): void => {
    if (reason === undefined) (writeHead as (s: number, h: OutgoingHttpHeaders) => ServerResponse).call(response, status, headers);
    else (writeHead as (s: number, r: string, h: OutgoingHttpHeaders) => ServerResponse).call(response, status, reason, headers);
  };
  const flush = (): void => {
    if (!held) return;
    const { reason, headers } = held;
    held = undefined;
    sendHead(200, reason, headers);
  };

  response.writeHead = function (this: ServerResponse, status: number, ...rest: unknown[]): ServerResponse {
    const reason = typeof rest[0] === "string" ? rest[0] : undefined;
    const raw = typeof rest[0] === "string" ? rest[1] : rest[0];
    if (status !== 200 || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return (writeHead as (...args: unknown[]) => ServerResponse).call(this, status, ...rest);
    }
    const headers = raw as OutgoingHttpHeaders;
    if (headerValue(headers, "etag") !== undefined || /\bno-store\b/i.test(headerValue(headers, "cache-control") ?? "")
      || headerValue(headers, "content-encoding") !== undefined) {
      return (writeHead as (...args: unknown[]) => ServerResponse).call(this, status, ...rest);
    }
    held = { reason, headers };
    return response;
  } as ServerResponse["writeHead"];

  response.write = function (this: ServerResponse, ...args: unknown[]): boolean {
    flush();
    return (write as (...a: unknown[]) => boolean).apply(this, args);
  } as ServerResponse["write"];

  response.end = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
    if (!held) return (end as (...a: unknown[]) => ServerResponse).apply(this, args);
    const body = bodyBuffer(args[0], args[1]);
    if (body === undefined || body.byteLength > MAX_TAGGED_BYTES) {
      flush();
      return (end as (...a: unknown[]) => ServerResponse).apply(this, args);
    }
    const { reason, headers } = held;
    held = undefined;
    const etag = contentEtag(body);
    const callback = [args[1], args[2]].find((value): value is () => void => typeof value === "function");
    if (etagMatches(request.headers["if-none-match"], etag)) {
      sendHead(304, undefined, withHeader(without(headers, "content-length"), "etag", etag));
      return (end as (cb?: () => void) => ServerResponse).call(response, callback);
    }
    sendHead(200, reason, withHeader(headers, "etag", etag));
    return (end as (b: Buffer, cb?: () => void) => ServerResponse).call(response, body, callback);
  } as ServerResponse["end"];
}
