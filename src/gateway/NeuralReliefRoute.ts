/**
 * 25.10 (7.47, neural maps): `GET /terrain-relief/<layer id>.bin` — a ground layer's height from a neural network
 * (tools/neural-relief.mjs, `NRH1` format), which the browser prefers over the brightness relief while
 * «Нейросетевой объём» is on (TerrainReliefNeural.ts).
 *
 * The id is the `/terrain-layer/<id>.png` id; the file name is built from the validated id only. A map older than
 * its layer PNG (the layer was republished after a patch, the map not yet rebuilt) is not served: the browser then
 * derives the relief from the layer it has. Answers: Origin refused 403; no map (or a stale one) 404 with
 * `no-store`; a hit 200, revalidated by its ETag (size and time), so a rebuilt set reaches the browser at once.
 * `NEURAL_RELIEF=0` switches the route off (bat/32 keeps it off unless `PUBLIC_NEURAL_RELIEF=1`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { originAllowed } from "./UpgradeGuard.js";

export const NEURAL_RELIEF_ROUTE = /^\/terrain-relief\/([0-9a-f]{40})\.bin$/;
/** The set's sub-directory for the ground (tools/neural-relief.mjs). */
export const NEURAL_RELIEF_TERRAIN = "terrain";

/** `NEURAL_RELIEF`: on unless it says 0/false/off/no. */
export function parseNeuralReliefEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env["NEURAL_RELIEF"]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

export interface NeuralReliefRouteOptions {
  /** NEURAL_RELIEF_DIR (default `.runtime/neural-relief`). */
  readonly directory: string;
  /** Where the layer PNGs are (`terrainLayersDirectory`): a map older than its PNG is stale. */
  readonly layersDirectory: string;
  readonly allowedOrigins: readonly string[];
}

/** Answers the request when it is this route's; false otherwise. */
export async function serveNeuralReliefRoute(
  request: IncomingMessage, response: ServerResponse, pathname: string, options: NeuralReliefRouteOptions,
): Promise<boolean> {
  const match = request.method === "GET" ? pathname.match(NEURAL_RELIEF_ROUTE) : null;
  if (!match) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  const id = match[1]!;
  const file = join(options.directory, NEURAL_RELIEF_TERRAIN, `${id}.bin`);
  try {
    const [map, layer] = await Promise.all([stat(file), stat(join(options.layersDirectory, `${id}.png`))]);
    if (map.mtimeMs < layer.mtimeMs) throw Object.assign(new Error("stale"), { code: "ENOENT" });
    const etag = `"${map.size.toString(16)}-${Math.floor(map.mtimeMs).toString(16)}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { "access-control-allow-origin": origin, etag, "cache-control": "no-cache" }).end();
      return true;
    }
    const data = await readFile(file);
    response.writeHead(200, {
      "access-control-allow-origin": origin,
      "cache-control": "no-cache",
      etag,
      "content-length": data.byteLength,
      "content-type": "application/octet-stream",
    });
    response.end(data);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    response.writeHead(missing ? 404 : 500, {
      ...(origin ? { "access-control-allow-origin": origin } : {}), "cache-control": "no-store",
    }).end();
  }
  return true;
}
