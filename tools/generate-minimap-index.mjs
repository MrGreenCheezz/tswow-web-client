// Publishes the minimap tile index of one map: which baked BLP holds which grid cell.
//
// The client stores every minimap bake under an MD5 of its own path, so the picture of Elwynn is
// not `Azeroth\map31_49.blp` but `textures\Minimap\e63e…blp`, and `md5translate.trs` is the only
// thing that connects them. Reading that file needs the archive chain, which the gateway process
// does not open, so the translation is published here and the gateway only serves the result.
//
// The output is keyed the repository's way — `"<gridX>-<gridY>"`, gridX from world X — and the
// hash is bare, because `textures\Minimap\<hash>.blp` is what `/texture` already knows how to
// publish. That means the whole minimap needs no image route of its own.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MINIMAP_TRS, loadMinimapIndex, tilesOfMap } from "./minimap-index.mjs";
import { internalMapName, mapsWithDirectory } from "./map-directory.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { stampGenerated } from "./source-stamp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function minimapDirectory() {
  return resolve(root, process.env.MINIMAP_DIR ?? "data/minimap");
}

export async function publishMinimapIndex(mapId, directory, index, archives) {
  const tiles = tilesOfMap(index, directory);
  const destination = resolve(minimapDirectory(), `${mapId}.json`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify({ map: mapId, directory, tiles }));
  // A custom map's tiles are appended to `md5translate.trs` by the tswow build, so this one file
  // is the whole answer to "has any map's minimap changed".
  if (archives) await stampGenerated(destination, archives, { paths: [MINIMAP_TRS] });
  return { destination, tiles: Object.keys(tiles).length };
}

// Run directly: node tools/generate-minimap-index.mjs 0     (or --all)
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const all = process.argv.includes("--all");
  const mapId = Number.parseInt(process.argv[2] ?? "", 10);
  if (!all && !Number.isInteger(mapId)) throw new Error("Usage: node tools/generate-minimap-index.mjs <map> | --all");

  const archives = await clientArchives(clientDirectory());
  try {
    const index = await loadMinimapIndex(archives);
    // One read of a 1.5 MB file answers every map, so `--all` costs no more than one.
    const wanted = all
      ? await mapsWithDirectory(dbcDirectory())
      : [{ id: mapId, directory: await internalMapName(dbcDirectory(), mapId) }];
    let published = 0;
    let empty = 0;
    for (const map of wanted) {
      if (!map.directory) throw new Error(`Map.dbc has no map ${map.id}`);
      const result = await publishMinimapIndex(map.id, map.directory, index, archives);
      // A map built entirely out of buildings has no tiles at all, and that is a real answer
      // rather than a failure: about a third of the instance maps look like this.
      if (result.tiles === 0) empty++;
      else published++;
      if (!all) console.log(`Minimap index for map ${map.id} (${map.directory}): ${result.tiles} tiles`);
    }
    if (all) console.log(`Published ${published + empty} minimap indexes: ${published} with tiles, ${empty} empty`);
  } finally {
    archives.close();
  }
}
