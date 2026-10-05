// 05.10-11.01: the convex volume (WMO MCVP planes) of a game object's model, by display id.
//
// Wow.exe takes a falling passenger off a transport only outside that volume (0x007618b0 →
// 0x006ec7b0, refused while 0x0077ffb0 → 0x007aea10 says «inside»). The planes live in the client's
// WMO root, which this process never opens: `readConvexVolumes` runs `tools/convex-volumes.mjs` in a
// child (GatewayConfiguration.ts), once per root per dataset memo. The display id → root path comes
// from the dataset's GameObjectDisplayInfo.dbc, the table the extractor and the renderer use.
//
// Only WMO roots are answered. An M2 transport's volume in Wow.exe is the model's box with a margin
// over the top (0x0077ffb0, flag 0x40; +1.6404 + 1/72 yd on max z, floats at 0x00a3e6f0/0x00a3e6ec),
// from a box field of the loaded model not established here — so an M2, an id without a row and a
// root the chain does not hold carry no row, and the browser keeps its older rule for them.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { CatalogCache } from "./CatalogRoutes.js";
import { parseDisplayIds } from "./GameObjectModels.js";
import { loadGameObjectDisplayMetadata, type GameObjectDisplayMetadata } from "./GameObjectMetadata.js";
import { originAllowed } from "./UpgradeGuard.js";

export const GAME_OBJECT_VOLUMES_VERSION = 1;
export const GAME_OBJECT_VOLUMES_PATHNAME = "/vmap/gobject-volumes";

/** Root path → flat planes (a, b, c, d …), `[]` for a root without MCVP, null when the chain has no such root. */
export type ConvexVolumeReader = (paths: readonly string[]) => Promise<Readonly<Record<string, readonly number[] | null>>>;

export interface GameObjectVolumeRouteOptions {
  readonly dbcDirectory?: string | undefined;
  readonly allowedOrigins: readonly string[];
  readonly readConvexVolumes?: ConvexVolumeReader | undefined;
  /** Tests: the display table without a DBC on disk. */
  readonly loadDisplays?: ((dbcDirectory: string) => Promise<ReadonlyMap<number, GameObjectDisplayMetadata>>) | undefined;
}

interface VolumeMemo {
  displays: Promise<ReadonlyMap<number, GameObjectDisplayMetadata>> | undefined;
  /** By lowercased root path. */
  readonly roots: Map<string, Promise<readonly number[] | null>>;
}

/** Per catalog memo: `DatasetIndexes.reset()` drops the map and this with it. */
const MEMOS = new WeakMap<CatalogCache, VolumeMemo>();

function cleanPlanes(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length % 4 !== 0 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  return value as number[];
}

/**
 * Answers `GET /vmap/gobject-volumes?v=1&ids=…`: 403 for a foreign Origin, 400 for another `?v=` or a
 * bad id list, 200 `{ version, volumes: [{ displayId, planes }] }` never cached, 500 with the failed
 * roots forgotten when the child fails. False without a DBC directory or a reader (no client on this
 * machine), leaving the request to the gateway's 404 — the browser then keeps its older rule.
 */
export async function serveGameObjectVolumesRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  cache: CatalogCache,
  options: GameObjectVolumeRouteOptions,
): Promise<boolean> {
  const reader = options.readConvexVolumes;
  if (request.method !== "GET" || !options.dbcDirectory || !reader || url.pathname !== GAME_OBJECT_VOLUMES_PATHNAME) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  const ids = parseDisplayIds(url.searchParams.get("ids"));
  if (url.searchParams.get("v") !== String(GAME_OBJECT_VOLUMES_VERSION) || !ids) {
    response.writeHead(400, { "access-control-allow-origin": origin }).end();
    return true;
  }
  let memo = MEMOS.get(cache);
  if (!memo) {
    memo = { displays: undefined, roots: new Map() };
    MEMOS.set(cache, memo);
  }
  const dbcDirectory = options.dbcDirectory;
  const load = options.loadDisplays ?? loadGameObjectDisplayMetadata;
  const displays = memo.displays ??= load(dbcDirectory);
  try {
    const table = await displays;
    const rows: { displayId: number; key: string }[] = [];
    const fresh: string[] = [];
    for (const id of ids) {
      const model = table.get(id)?.model;
      if (!model || !model.toLowerCase().endsWith(".wmo")) continue;
      const key = model.toLowerCase();
      rows.push({ displayId: id, key });
      if (!memo.roots.has(key) && !fresh.some((path) => path.toLowerCase() === key)) fresh.push(model);
    }
    if (fresh.length > 0) {
      // Set before the await, so a request arriving meanwhile shares this child.
      const batch = reader(fresh);
      for (const path of fresh) {
        const pending = batch.then((answer) => cleanPlanes(answer[path]));
        // Handled where it is awaited; this only keeps a second failed root from reading as unhandled.
        pending.catch(() => undefined);
        memo.roots.set(path.toLowerCase(), pending);
      }
    }
    const volumes: { displayId: number; planes: readonly number[] }[] = [];
    for (const row of rows) {
      const pending = memo.roots.get(row.key)!;
      const planes = await pending;
      if (planes) volumes.push({ displayId: row.displayId, planes });
    }
    response.writeHead(200, {
      "access-control-allow-origin": origin,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({ version: GAME_OBJECT_VOLUMES_VERSION, volumes }));
  } catch {
    // Not the rejection again next time: the child may have died, the dataset may be mid-build.
    if (memo.displays === displays) {
      await displays.then(() => undefined, () => { memo.displays = undefined; });
    }
    for (const [key, pending] of memo.roots) {
      await pending.then(() => undefined, () => { if (memo.roots.get(key) === pending) memo.roots.delete(key); });
    }
    response.writeHead(500, { "access-control-allow-origin": origin }).end();
  }
  return true;
}
