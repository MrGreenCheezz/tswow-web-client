// One map's far horizon, which is the `.wdl` the client already ships.
//
// A WDL is the whole continent at one vertex per 33 yards: 17x17 outer heights and 16x16 inner
// ones per tile, `int16` in absolute world yards, plus a hole mask. Nothing has to be computed —
// this pulls the file out of the archives and puts it where the gateway can serve it, the same way
// the terrain and splat generators do for their own tiles.
//
// The accuracy is why it is worth drawing at all rather than fading the ground out: measured
// against the server's own height field on 40 tiles per continent, an outer vertex is never more
// than 1.01 yards off, because it is the same field quantised to whole yards. What deviates is the
// ground *between* those vertices — a median of 1.6 yards, ninetieth percentile 10 — and at the
// distances this is drawn at, the fog has closed long before that reads as anything.
//
// Sizes: Azeroth 798,234 bytes, Kalimdor 1,140,772, Northrend 1,303,949, Expansion01 926,828.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDbcFile } from "./dbc.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { sourceStamp, writeSourceStamp } from "./source-stamp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Publishes one map's horizon out of an open chain: the persistent tile worker calls this per job
 * (10.20 slice 2), the command line below once. The directory is read on every call, so a
 * long-lived worker follows its env. Leaves the chain open.
 */
export async function publishHorizon(mapId, archives) {
  if (!Number.isInteger(mapId) || mapId < 0 || mapId > 9999) throw new Error(`${mapId} is not a map id`);
  const destination = resolve(root, process.env.HORIZON_DIR ?? "data/horizon");
  const maps = await openDbcFile(dbcDirectory(), "Map");
  const row = maps.rowOf(mapId);
  const mapName = row === undefined ? undefined : maps.string(row, "Directory");
  if (!mapName) throw new Error(`Map.dbc has no map ${mapId}`);

  const wdlPath = `World\\Maps\\${mapName}\\${mapName}.wdl`;
  const wdl = await archives.read(wdlPath);
  // Taken while the chain is still open, and written after the file it describes.
  const stamp = await sourceStamp(archives, { paths: [wdlPath] });
  if (!wdl) throw new Error(`The client has no World\\Maps\\${mapName}\\${mapName}.wdl`);
  if (wdl.length < 16 + 4096 * 4) throw new Error(`${mapName}.wdl is ${wdl.length} bytes, too small to hold its tile table`);

  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, `${mapId}.wdl`), wdl);
  await writeSourceStamp(join(destination, `${mapId}.wdl`), stamp);
  console.log(`Generated horizon for map ${mapId} (${mapName}): ${wdl.length} bytes`);
  return { bytes: wdl.length, mapName };
}

// Run directly: node tools/generate-horizon.mjs <map>
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const mapId = Number.parseInt(process.argv[2] ?? "", 10);
  if (!Number.isInteger(mapId) || mapId < 0 || mapId > 9999) {
    throw new Error("Usage: node tools/generate-horizon.mjs <map>");
  }
  const archives = await clientArchives(clientDirectory());
  try {
    await publishHorizon(mapId, archives);
  } finally {
    archives.close();
  }
}
