// The models one visual tile places, as their own small file beside the tile (10.22).
//
// `data/visual-tiles/<map>/<x>-<y>.json` is every placement of the tile — 2.4–3.0 MB for a city
// cell, 83 % of it WMO furniture — and its stamp names the ADT, the WMOs and the outdoor M2s, not
// the furniture. The gateway's preloader wants only "which models does this tile need", and parsing
// the whole tile on the gateway's main thread to learn it would cost the very requests it is meant
// to speed up. So `publishVisualTile` writes `<x>-<y>.models.json` beside the tile, with the tile's
// own stamp: the distinct `name` of every object, interior or not, in the order they first appear.
//
// A tile published before this file existed has no list; the `tile-models` job of the tile worker
// derives it from the tile once (`publishTileModels`) and answers it, so the parse never happens in
// the gateway. "No file" means "not published yet", as for every member of a family without a
// version (М-A7b-1).

import { copyFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stampSidecar, writeFileAtomic } from "./source-stamp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The distinct model paths of a tile's objects, in first-appearance order, original spelling. */
export function tileModelNames(objects) {
  const seen = new Set();
  const names = [];
  for (const object of objects) {
    const name = typeof object?.name === "string" ? object.name : undefined;
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** `<VISUAL_TILE_DIR>/<map>/<x>-<y>.models.json`, read from the env on every call. */
export function tileModelsFile(map, gridX, gridY) {
  return resolve(root, process.env.VISUAL_TILE_DIR ?? "data/visual-tiles", String(map), `${gridX}-${gridY}.models.json`);
}

/**
 * The list for a tile that is already published: read from the tile, written beside it with a copy
 * of the tile's stamp, and returned. A tile that is not published answers `undefined` (the caller
 * publishes the tile first; this job never reads the archives).
 */
export async function publishTileModels(map, gridX, gridY) {
  const destination = tileModelsFile(map, gridX, gridY);
  const tile = join(dirname(destination), `${gridX}-${gridY}.json`);
  let objects;
  try {
    objects = JSON.parse(await readFile(tile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (!Array.isArray(objects)) throw new Error(`${tile} is not a visual tile`);
  const names = tileModelNames(objects);
  // Stamp first, as everywhere: a list without a stamp would be served as current for good. The
  // tile's own stamp, because the list is a function of the tile and nothing else. A tile with no
  // stamp (published before stamps, not yet reached by `tools/restamp.mjs`) gets its answer but no
  // file: an unstamped list could never be proven stale, and restamp cannot derive its inputs.
  try {
    await copyFile(stampSidecar(tile), stampSidecar(destination));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return names;
  }
  await writeFileAtomic(destination, JSON.stringify(names));
  return names;
}
