/**
 * 05.10-A7b-3 (7.14, data and route): `GET /minimap/wmo?path=<WMO path>&v=1` — one building's baked
 * minimap tiles, `{ version, path, groups: { "<group>": { "<x>-<y>": "<hash>" } } }`.
 *
 * The client keeps a top-down bake of each WMO group under the same MD5 index as the ADT tiles
 * (`tools/minimap-index.mjs`, `wmoTilesOf`); `tools/generate-minimap-index.mjs --wmo` publishes all
 * 793 roots into one `wmo.json` beside the per-map indexes, and this route answers one root out of
 * it. The parsed file is memoised per process and follows the file (size and mtime), so a republished
 * index after a patch is read again without a restart. The picture of a tile is the ordinary
 * `/texture` route (`textures\Minimap\<hash>.blp`), as for the ADT minimap.
 *
 * Shape of the answers, like its siblings: Origin refused 403, a wrong `v`/`path` 400 (with CORS),
 * a building without bakes 404 with `no-store` (most of the client's 1,985 roots have none), a hit
 * 200 cached as the `/minimap/<map>` index is (`tileCacheControl`, `g=`). A gateway older than this
 * route answers 404 from its fallback, which the browser reads as "no bakes" (`WmoMinimapTiles.ts`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { originAllowed } from "./UpgradeGuard.js";

/** The answer's shape; the request names it as `?v=`. */
export const WMO_MINIMAP_ROUTE_VERSION = 1;
export const WMO_MINIMAP_ROUTE = "/minimap/wmo";
export const WMO_MINIMAP_FILE = "wmo.json";

/** md5translate's root for a WMO path (`World\` and `.wmo` dropped, lower case), or undefined. */
export function wmoMinimapKey(path: string | null | undefined): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.length > 260) return undefined;
  const lower = path.replaceAll("/", "\\").toLowerCase();
  if (!lower.endsWith(".wmo")) return undefined;
  const key = lower.replace(/^world\\/, "").slice(0, -".wmo".length);
  return key.length > 0 ? key : undefined;
}

type Groups = Record<string, Record<string, string>>;

/** The process's copy of `wmo.json`, keyed by the file it was read from. */
export interface WmoMinimapMemo {
  file?: { size: number; mtimeMs: number; roots: Record<string, Groups> } | undefined;
}

export interface WmoMinimapRouteOptions {
  readonly minimapDirectory: string;
  readonly allowedOrigins: readonly string[];
  /** Publishes `wmo.json` (once per lane key); absent: an absent file is a 404. */
  readonly generate?: (() => Promise<void>) | undefined;
  /** Drops a stale file (the dataset fingerprint), before it is read. */
  readonly ensureCurrent?: ((file: string) => Promise<void>) | undefined;
  readonly cacheControl: (requestedGeneration: string | null) => string;
}

function refuse(response: ServerResponse, status: number, origin: string | undefined, extra: Record<string, string> = {}): void {
  response.writeHead(status, { ...(origin ? { "access-control-allow-origin": origin } : {}), ...extra }).end();
}

async function loadRoots(memo: WmoMinimapMemo, file: string): Promise<Record<string, Groups>> {
  const info = await stat(file);
  const known = memo.file;
  if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.roots;
  const value = JSON.parse(await readFile(file, "utf8")) as { roots?: unknown } | null;
  const roots = value && typeof value.roots === "object" && value.roots !== null
    ? value.roots as Record<string, Groups> : {};
  memo.file = { size: info.size, mtimeMs: info.mtimeMs, roots };
  return roots;
}

/** Answers `/minimap/wmo`; false leaves every other path to the rest of the gateway. */
export async function serveWmoMinimapRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  memo: WmoMinimapMemo,
  options: WmoMinimapRouteOptions,
): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== WMO_MINIMAP_ROUTE) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  const key = wmoMinimapKey(url.searchParams.get("path"));
  if (url.searchParams.get("v") !== String(WMO_MINIMAP_ROUTE_VERSION) || key === undefined) {
    refuse(response, 400, origin);
    return true;
  }
  const file = join(options.minimapDirectory, WMO_MINIMAP_FILE);
  try {
    await options.ensureCurrent?.(file);
    let roots: Record<string, Groups>;
    try {
      roots = await loadRoots(memo, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.generate) throw error;
      await options.generate();
      roots = await loadRoots(memo, file);
    }
    const groups = Object.hasOwn(roots, key) ? roots[key] : undefined;
    if (!groups || typeof groups !== "object" || Object.keys(groups).length === 0) {
      refuse(response, 404, origin, { "cache-control": "no-store" });
      return true;
    }
    const data = Buffer.from(JSON.stringify({ version: WMO_MINIMAP_ROUTE_VERSION, path: key, groups }));
    response.writeHead(200, {
      "access-control-allow-origin": origin,
      "cache-control": options.cacheControl(url.searchParams.get("g")),
      "content-length": data.byteLength,
      "content-type": "application/json; charset=utf-8",
    });
    response.end(data);
  } catch (error) {
    refuse(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500, origin, { "cache-control": "no-store" });
  }
  return true;
}
