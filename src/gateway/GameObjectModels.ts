// 11.01 slice A2: which collision model a game object's display id stands for.
//
// The core collides with a game object (a ship's deck, a lift's floor, a dungeon door) through
// `GameObjectModel`, and that class finds its geometry by display id in `vmaps/GameObjectModels.dtree`
// (`LoadGameObjectModelList`, common/Collision/Models/GameObjectModel.cpp:44-95; written by
// `TileAssembler::exportGameobjectModels`, common/Collision/Maps/TileAssembler.cpp:363-428):
//
//   char[8] VMAP_MAGIC ("VMAP_4.8", VMapDefinitions.h:27)
//   until the end of the file:
//     u32 displayId, u8 isWmo, u32 nameLength, char[nameLength] name, 3×f32 low, 3×f32 high
//
// The name is the model's file in `vmaps/` (a WMO's collision is `<name>.vmo` beside it), and
// `GET /collision/model/<name>` already serves that geometry — this file only adds the table that
// turns a display id into the name and the box. The box is in the model's own space: the extractor
// takes it over every group vertex of the raw model (TileAssembler.cpp:397-408).
//
// What the core skips, this skips too: a record with a NaN corner (`isNaN`, GameObjectModel.cpp:85)
// and a model with a zero box (`initialize`, :112-116 — it loads no collision for it). A second
// record for a display id already read is ignored, as `unordered_map::emplace` ignores it — also
// after a zero-box or nameless first record, which the core keeps and then refuses; only a NaN
// record is never kept, so the id stays free for a later one.

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { CatalogCache } from "./CatalogRoutes.js";
import { originAllowed } from "./UpgradeGuard.js";

export const GAME_OBJECT_MODELS_VERSION = 1;
export const GAME_OBJECT_MODELS_PATHNAME = "/vmap/gobject-models";
/** `VMAP::GAMEOBJECT_MODELS`. */
export const GAME_OBJECT_MODELS_FILE = "GameObjectModels.dtree";
/** Display ids one request may name; a dungeon's doors and lifts are a few dozen. */
export const GAME_OBJECT_MODELS_MAX_IDS = 256;

const MAGIC = "VMAP_4.8";
/** `char buff[500]` in the reader: a longer name ends the read as corrupted. */
const MAX_NAME_LENGTH = 500;

export interface GameObjectModelEntry {
  readonly displayId: number;
  /** The file name in `vmaps/`, as `/collision/model/<name>` takes it. */
  readonly name: string;
  readonly isWmo: boolean;
  /** Model-space box: low x, y, z, then high x, y, z. */
  readonly bounds: readonly [number, number, number, number, number, number];
}

/** `LoadGameObjectModelList` over the file's bytes. A truncated tail ends the list, as it does there. */
export function parseGameObjectModels(payload: Uint8Array): Map<number, GameObjectModelEntry> {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (payload.byteLength < 8 || new TextDecoder().decode(payload.subarray(0, 8)) !== MAGIC) {
    throw new Error(`${GAME_OBJECT_MODELS_FILE} has the wrong header`);
  }
  const decoder = new TextDecoder("latin1");
  const models = new Map<number, GameObjectModelEntry>();
  /** Ids the core holds a record for that gives no collision (zero box, no name): they stay taken. */
  const claimed = new Set<number>();
  let offset = 8;
  while (offset + 4 <= payload.byteLength) {
    const displayId = view.getUint32(offset, true);
    if (offset + 9 > payload.byteLength) break;
    const isWmo = view.getUint8(offset + 4) !== 0;
    const nameLength = view.getUint32(offset + 5, true);
    offset += 9;
    if (nameLength >= MAX_NAME_LENGTH || offset + nameLength + 24 > payload.byteLength) break;
    // The extractor writes the length without a terminator; a stray one is not part of the file name.
    const name = decoder.decode(payload.subarray(offset, offset + nameLength)).replace(/\0+$/, "");
    offset += nameLength;
    const bounds: number[] = [];
    for (let axis = 0; axis < 6; axis++, offset += 4) bounds.push(view.getFloat32(offset, true));
    // Never emplaced (:85-88): a later record for the id is still read.
    if (bounds.some(Number.isNaN)) continue;
    if (models.has(displayId) || claimed.has(displayId)) continue;
    // Emplaced, then refused by `initialize` (:112-116 zero box, :118-121 no file): the id is taken.
    if (name.length === 0 || bounds.every((value) => value === 0)) {
      claimed.add(displayId);
      continue;
    }
    models.set(displayId, {
      displayId,
      name,
      isWmo,
      bounds: bounds as unknown as GameObjectModelEntry["bounds"],
    });
  }
  return models;
}

export async function loadGameObjectModels(vmapsDirectory: string): Promise<Map<number, GameObjectModelEntry>> {
  return parseGameObjectModels(new Uint8Array(await readFile(join(vmapsDirectory, GAME_OBJECT_MODELS_FILE))));
}

/**
 * The answer for some display ids. An id missing from `models` has no collision model in the core
 * (not in the file, a NaN or zero box) — the browser keeps that as "solid nowhere", not as a failure.
 */
export function gameObjectModelsFor(
  table: ReadonlyMap<number, GameObjectModelEntry>,
  ids: readonly number[],
): { version: number; models: GameObjectModelEntry[] } {
  const models: GameObjectModelEntry[] = [];
  for (const id of ids) {
    const entry = table.get(id);
    if (entry) models.push(entry);
  }
  return { version: GAME_OBJECT_MODELS_VERSION, models };
}

/** Comma-separated display ids, each a positive u32, at most `GAME_OBJECT_MODELS_MAX_IDS`; else undefined. */
export function parseDisplayIds(value: string | null): number[] | undefined {
  if (value === null || value.length === 0 || value.length > GAME_OBJECT_MODELS_MAX_IDS * 11) return undefined;
  const parts = value.split(",");
  if (parts.length > GAME_OBJECT_MODELS_MAX_IDS) return undefined;
  const ids = new Set<number>();
  for (const part of parts) {
    if (!/^\d{1,10}$/.test(part)) return undefined;
    const id = Number(part);
    if (id < 1 || id > 0xffff_ffff) return undefined;
    ids.add(id);
  }
  return [...ids];
}

export interface GameObjectModelRouteOptions {
  readonly vmapsDirectory?: string | undefined;
  readonly allowedOrigins: readonly string[];
}

/** The parsed table per catalog memo: `DatasetIndexes.reset()` drops the memo map and this with it. */
const TABLES = new WeakMap<CatalogCache, Promise<Map<number, GameObjectModelEntry>>>();

/**
 * Answers `GET /vmap/gobject-models?v=1&ids=…` — the catalog-route block (CatalogRoutes.ts): 403 for
 * a foreign Origin, 400 for another `?v=` or a bad id list, 200 JSON never cached (a rebuilt dataset
 * resets the memo), 500 with the memo dropped on a failed read so the next request reads the disk.
 * False without a vmaps directory or for another path, leaving the request to the rest of the gateway.
 */
export async function serveGameObjectModelsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  cache: CatalogCache,
  options: GameObjectModelRouteOptions,
): Promise<boolean> {
  if (request.method !== "GET" || !options.vmapsDirectory || url.pathname !== GAME_OBJECT_MODELS_PATHNAME) return false;
  const origin = request.headers.origin;
  if (!originAllowed(origin, options.allowedOrigins)) {
    response.writeHead(403).end();
    return true;
  }
  const ids = parseDisplayIds(url.searchParams.get("ids"));
  if (url.searchParams.get("v") !== String(GAME_OBJECT_MODELS_VERSION) || !ids) {
    response.writeHead(400, { "access-control-allow-origin": origin }).end();
    return true;
  }
  let table = TABLES.get(cache);
  if (!table) {
    // Set before the first await, so two requests arriving together share one read.
    table = loadGameObjectModels(options.vmapsDirectory);
    TABLES.set(cache, table);
  }
  try {
    const data = JSON.stringify(gameObjectModelsFor(await table, ids));
    response.writeHead(200, {
      "access-control-allow-origin": origin,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(data);
  } catch {
    // Not the rejection again on the next request: the disk may have been mid-build.
    if (TABLES.get(cache) === table) TABLES.delete(cache);
    response.writeHead(500, { "access-control-allow-origin": origin }).end();
  }
  return true;
}
