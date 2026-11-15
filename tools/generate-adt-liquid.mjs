// 15.11 (7.09 slice B, 7.31): publishes one tile's authored liquid layers for `/liquid/adt`.
//
// The client's own ADT, read through the patch chain the game reads, turned into JSON by
// `tools/adt-liquid.mjs`: per chunk and layer the LiquidType, the vertex format, the heights, the depth
// bytes or the magma/slime texture coordinates, and the masks. The project ships the reader, never
// the data: the file is made on the user's machine from the user's client, like every tile cache.
//
// A tile whose ADT has no liquid is still published (an empty `layers`), so the browser asks once and
// keeps its own rule there; a tile the client has no ADT for is `SourceMissing` (the route's 404).

import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADT_LIQUID_VERSION, readAdtLiquid } from "./adt-liquid.mjs";
import { internalMapName } from "./map-directory.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { SOURCE_MISSING_EXIT, SourceMissing } from "./source-missing.mjs";
import { stampGenerated, stampSidecar, writeFileAtomic } from "./source-stamp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function validTile(map, gridX, gridY) {
  return [map, gridX, gridY].every(Number.isInteger) && map >= 0 && map <= 9999
    && gridX >= 0 && gridX <= 63 && gridY >= 0 && gridY <= 63;
}

/** Where one tile's answer lives; the gateway route names the same file (`adtLiquidFile`). */
export function adtLiquidFile(directory, map, gridX, gridY) {
  return join(directory, "adt", `v${ADT_LIQUID_VERSION}`, String(map), `${gridX}-${gridY}.json`);
}

export function liquidDirectory() {
  return resolve(root, process.env.LIQUID_DIR ?? "data/liquid");
}

/** Publishes `map`/`gridX`/`gridY` (the `.map` grid: the ADT is `<name>_<gridY>_<gridX>.adt`). */
export async function publishAdtLiquid(map, gridX, gridY, archives) {
  if (!validTile(map, gridX, gridY)) throw new Error(`${map}/${gridX}/${gridY} is not a terrain tile`);
  const destination = adtLiquidFile(liquidDirectory(), map, gridX, gridY);
  try {
    await access(destination);
    await access(stampSidecar(destination));
    return { destination, cached: true };
  } catch {
    // Not published yet, or published without its stamp.
  }
  const name = await internalMapName(dbcDirectory(), map);
  if (!name) throw new SourceMissing(`Map.dbc has no map ${map}`);
  const adtPath = `World\\Maps\\${name}\\${name}_${gridY}_${gridX}.adt`;
  const adt = await archives.read(adtPath);
  if (!adt) throw new SourceMissing(`${adtPath} is not in the client`);
  const parsed = readAdtLiquid(adt, map);
  await mkdir(dirname(destination), { recursive: true });
  await writeFileAtomic(destination, JSON.stringify({ ...parsed, map, gridX, gridY }));
  await stampGenerated(destination, archives, { paths: [adtPath] });
  return { destination, cached: false, layers: parsed.layers.length };
}

// Run directly: node tools/generate-adt-liquid.mjs <map> <gridX> <gridY>
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [map, gridX, gridY] = process.argv.slice(2, 5).map((value) => Number.parseInt(value ?? "", 10));
  if (!validTile(map, gridX, gridY)) throw new Error("Usage: node tools/generate-adt-liquid.mjs <map> <gridX> <gridY>");
  const archives = await clientArchives(clientDirectory());
  try {
    const result = await publishAdtLiquid(map, gridX, gridY, archives);
    console.log(`Liquid layers ${map}/${gridX}/${gridY}: ${result.cached ? "already published" : `${result.layers} layers`}`);
  } catch (error) {
    if (!(error instanceof SourceMissing)) throw error;
    console.error(error.message);
    process.exitCode = SOURCE_MISSING_EXIT;
  } finally {
    archives.close();
  }
}
