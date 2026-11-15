/**
 * 15.11 (7.09 slice B, 7.31): `GET /liquid/adt/<map>/<gridX>/<gridY>?v=1` — one tile's authored liquid
 * layers, read out of the user's own client ADT by `tools/generate-adt-liquid.mjs` (`tools/adt-liquid.mjs`
 * has the format and the Wow.exe addresses). The grid is the `.map` grid the terrain routes use: the ADT
 * is `<name>_<gridY>_<gridX>.adt`.
 *
 * Answers: Origin refused 403; a path that is not a tile, or another `v`, 400 (with CORS), which the
 * browser takes as "none" for good; a tile the client has no ADT for 404; a failed read 500, retried by
 * the browser; a hit 200 JSON. A tile with no liquid is a 200 with empty `layers`.
 */

import { join } from "node:path";

/** The `v` this gateway serves; `tools/adt-liquid.mjs` `ADT_LIQUID_VERSION` and the browser's own. */
export const ADT_LIQUID_ROUTE_VERSION = 1;

const ROUTE = /^\/liquid\/adt\/(\d{1,4})\/(\d{1,2})\/(\d{1,2})$/;

export interface AdtLiquidRequest {
  map: number;
  gridX: number;
  gridY: number;
}

/**
 * The tile a request names: `undefined` for another path (the rest of the gateway's), `null` for this
 * route's path with a wrong tile or version (400).
 */
export function adtLiquidRequest(pathname: string, version: string | null): AdtLiquidRequest | null | undefined {
  const match = pathname.match(ROUTE);
  if (!match) return pathname.startsWith("/liquid/adt/") ? null : undefined;
  const map = Number(match[1]), gridX = Number(match[2]), gridY = Number(match[3]);
  if (version !== String(ADT_LIQUID_ROUTE_VERSION) || gridX > 63 || gridY > 63) return null;
  return { map, gridX, gridY };
}

/** The published file: `<liquidDirectory>/adt/v1/<map>/<gridX>-<gridY>.json` (`adtLiquidFile` in the tool). */
export function adtLiquidFile(liquidDirectory: string, request: AdtLiquidRequest): string {
  return join(liquidDirectory, "adt", `v${ADT_LIQUID_ROUTE_VERSION}`, String(request.map), `${request.gridX}-${request.gridY}.json`);
}
