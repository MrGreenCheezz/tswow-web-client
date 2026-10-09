// 05.10-A7b-7 (7.08 slice A): the colour of one map's far horizon, out of the client's own minimap.
//
// The `.wdl` the horizon is drawn from (`generate-horizon.mjs`) is heights only — the ring past the
// loaded tiles was one flat green, 0x4a6b4f, whatever the zone. The client ships a top-down bake of
// every ADT tile (`textures\Minimap\<md5>.blp`, named through `md5translate.trs`), and that bake is
// the ground as the zone's own textures paint it: averaged to one texel per WDL cell (33.3 yards,
// 16 a tile) it is the horizon's albedo.
//
// Layout: one 1024x1024 RGB PNG per map, 16x16 texels per tile. Row `gridX * 16 + r`, column
// `gridY * 16 + c` — the horizon mesh's own frame (rows run south with gridX, columns east with
// gridY). A minimap picture lies the same way as its tile's chunk grid (row = MCNK IndexY = south):
// scored against the tile's water chunks, the identity orientation wins on every clear coastal tile
// (`.runtime/re-2026-10-05/a7b-7/probe-minimap-orientation.out.txt`: 0.74, 0.77, 0.77 against
// ≤ 0.63 for any of the other seven symmetries).
//
// The average is taken in linear light (a box over each 16x16 block of a 256x256 bake) and written
// back in sRGB. A cell with no bake keeps the old flat green, so a map with gaps never shows black.
// Same bake under many cells (open ocean) is decoded once.
//
// It is a *new file name* beside `<map>.wdl` (`data/horizon/<map>.colour.png`), so no cache version
// is needed: a gateway older than the route never asks for it, and its stamp names md5translate and
// every bake it read, so a patched minimap makes it stale.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { decodeBlp } from "./blp.mjs";
import { internalMapName } from "./map-directory.mjs";
import { MINIMAP_TRS, loadMinimapIndex, minimapTexturePath, tilesOfMap } from "./minimap-index.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { SOURCE_MISSING_EXIT, SourceMissing } from "./source-missing.mjs";
import { sourceStamp, writeSourceStamp } from "./source-stamp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Texels per tile side: one per WDL cell. */
export const HORIZON_COLOUR_TEXELS = 16;
/** The whole map: 64 tiles of 16 texels. */
export const HORIZON_COLOUR_SIDE = 64 * HORIZON_COLOUR_TEXELS;
/** The colour the horizon was before it had one (`#horizonMaterial` in WorldRenderer3D). */
export const HORIZON_FALLBACK_RGB = Object.freeze([0x4a, 0x6b, 0x4f]);

const toLinear = new Float64Array(256);
for (let value = 0; value < 256; value++) {
  const c = value / 255;
  toLinear[value] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function toSrgb(linear) {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/**
 * Averages a decoded picture (`{ width, height, data }` RGBA) down to `texels`² in linear light,
 * row-major RGB bytes. Blocks are whole source pixels when the size divides, weighted otherwise.
 */
export function averageBlocks(image, texels = HORIZON_COLOUR_TEXELS) {
  const out = new Uint8Array(texels * texels * 3);
  for (let row = 0; row < texels; row++) {
    const y0 = Math.floor(row * image.height / texels);
    const y1 = Math.max(y0 + 1, Math.floor((row + 1) * image.height / texels));
    for (let column = 0; column < texels; column++) {
      const x0 = Math.floor(column * image.width / texels);
      const x1 = Math.max(x0 + 1, Math.floor((column + 1) * image.width / texels));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const at = (y * image.width + x) * 4;
          r += toLinear[image.data[at]];
          g += toLinear[image.data[at + 1]];
          b += toLinear[image.data[at + 2]];
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const target = (row * texels + column) * 3;
      out[target] = toSrgb(r / count);
      out[target + 1] = toSrgb(g / count);
      out[target + 2] = toSrgb(b / count);
    }
  }
  return out;
}

/**
 * Composes the map picture from `{ "<gridX>-<gridY>": hash }` and a loader of decoded bakes by hash
 * (`undefined` for one the archives do not hold). Returns the PNG and the bakes actually used.
 */
export async function composeHorizonColour(tiles, loadBake) {
  const png = new PNG({ width: HORIZON_COLOUR_SIDE, height: HORIZON_COLOUR_SIDE });
  for (let pixel = 0; pixel < HORIZON_COLOUR_SIDE * HORIZON_COLOUR_SIDE; pixel++) {
    png.data[pixel * 4] = HORIZON_FALLBACK_RGB[0];
    png.data[pixel * 4 + 1] = HORIZON_FALLBACK_RGB[1];
    png.data[pixel * 4 + 2] = HORIZON_FALLBACK_RGB[2];
    png.data[pixel * 4 + 3] = 255;
  }
  const averages = new Map();
  const used = new Set();
  let painted = 0;
  for (const [cell, hash] of Object.entries(tiles)) {
    const [gridX, gridY] = cell.split("-").map(Number);
    if (!Number.isInteger(gridX) || !Number.isInteger(gridY) || gridX < 0 || gridX > 63 || gridY < 0 || gridY > 63) continue;
    if (!averages.has(hash)) {
      const image = await loadBake(hash);
      averages.set(hash, image ? averageBlocks(image) : undefined);
      if (image) used.add(hash);
    }
    const block = averages.get(hash);
    if (!block) continue;
    painted++;
    for (let r = 0; r < HORIZON_COLOUR_TEXELS; r++) {
      for (let c = 0; c < HORIZON_COLOUR_TEXELS; c++) {
        const source = (r * HORIZON_COLOUR_TEXELS + c) * 3;
        const target = ((gridX * HORIZON_COLOUR_TEXELS + r) * HORIZON_COLOUR_SIDE + gridY * HORIZON_COLOUR_TEXELS + c) * 4;
        png.data[target] = block[source];
        png.data[target + 1] = block[source + 1];
        png.data[target + 2] = block[source + 2];
      }
    }
  }
  return { png, used: [...used], painted };
}

/** Where a map's colour picture is published. */
export function horizonColourFile(mapId) {
  return join(resolve(root, process.env.HORIZON_DIR ?? "data/horizon"), `${mapId}.colour.png`);
}

/**
 * Publishes one map's horizon colour out of an open chain (the tile worker per job, the command line
 * once). A map without a single minimap bake is `SourceMissing` — the route's 404: the client keeps
 * the flat green there, as it does for a gateway older than this.
 */
export async function publishHorizonColour(mapId, archives) {
  if (!Number.isInteger(mapId) || mapId < 0 || mapId > 9999) throw new Error(`${mapId} is not a map id`);
  const directory = await internalMapName(dbcDirectory(), mapId);
  if (!directory) throw new Error(`Map.dbc has no map ${mapId}`);
  const tiles = tilesOfMap(await loadMinimapIndex(archives), directory);
  const { png, used, painted } = await composeHorizonColour(tiles, async (hash) => {
    const blp = await archives.read(minimapTexturePath(hash));
    if (!blp) return undefined;
    try {
      return decodeBlp(blp);
    } catch {
      return undefined;
    }
  });
  if (painted === 0) throw new SourceMissing(`map ${mapId} (${directory}) has no minimap tiles`);
  // Taken while the chain is open; written after the file it describes.
  const stamp = await sourceStamp(archives, { paths: [MINIMAP_TRS, ...used.map(minimapTexturePath)] });
  const destination = horizonColourFile(mapId);
  await mkdir(dirname(destination), { recursive: true });
  const bytes = PNG.sync.write(png, { colorType: 2 });
  await writeFile(destination, bytes);
  await writeSourceStamp(destination, stamp);
  console.log(`Generated horizon colour for map ${mapId} (${directory}): ${painted} tiles, ${used.length} distinct bakes, ${bytes.length} bytes`);
  return { bytes: bytes.length, painted, bakes: used.length };
}

// Run directly: node tools/generate-horizon-colour.mjs <map>
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const mapId = Number.parseInt(process.argv[2] ?? "", 10);
  if (!Number.isInteger(mapId) || mapId < 0 || mapId > 9999) {
    throw new Error("Usage: node tools/generate-horizon-colour.mjs <map>");
  }
  const archives = await clientArchives(clientDirectory());
  try {
    await publishHorizonColour(mapId, archives);
  } catch (error) {
    if (!(error instanceof SourceMissing)) throw error;
    console.error(error.message);
    process.exitCode = SOURCE_MISSING_EXIT;
  } finally {
    archives.close();
  }
}
