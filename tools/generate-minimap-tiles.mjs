// Decodes minimap tiles ahead of time, so the first minute in a new zone is not spent waiting.
//
// The tiles themselves are served by `/texture`, which publishes one on demand — but on demand
// means one node process and one opening of the twenty-two archive sources per tile, and a
// character standing still needs nine of them. This does the same work with the chain opened once.
//
// Deduplication is the point of the hash: 687 cells of Azeroth are 520 distinct pictures, because
// every square of open ocean is the same bake.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { minimapTexturePath } from "./minimap-index.mjs";
import { internalMapName } from "./map-directory.mjs";
import { loadMinimapIndex, tilesOfMap } from "./minimap-index.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { publishTexture } from "./generate-texture.mjs";

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const mapId = Number.parseInt(process.argv[2] ?? "", 10);
  const around = process.argv.indexOf("--around");
  const radius = Number.parseInt(process.argv[process.argv.indexOf("--radius") + 1] ?? "2", 10);
  const all = process.argv.includes("--all");
  if (!Number.isInteger(mapId) || (!all && around < 0)) {
    throw new Error("Usage: node tools/generate-minimap-tiles.mjs <map> --all | --around <grid-x> <grid-y> [--radius n]");
  }

  const directory = await internalMapName(dbcDirectory(), mapId);
  if (!directory) throw new Error(`Map.dbc has no map ${mapId}`);
  const archives = await clientArchives(clientDirectory());
  try {
    const tiles = tilesOfMap(await loadMinimapIndex(archives), directory);
    let wanted = Object.entries(tiles);
    if (!all) {
      const centreX = Number.parseInt(process.argv[around + 1] ?? "", 10);
      const centreY = Number.parseInt(process.argv[around + 2] ?? "", 10);
      if (!Number.isInteger(centreX) || !Number.isInteger(centreY)) throw new Error("--around needs a grid x and a grid y");
      wanted = wanted.filter(([cell]) => {
        const [gridX, gridY] = cell.split("-").map(Number);
        return Math.abs(gridX - centreX) <= radius && Math.abs(gridY - centreY) <= radius;
      });
    }

    // By hash rather than by cell: the same ocean tile under twenty cells is published once.
    const hashes = [...new Set(wanted.map(([, hash]) => hash))];
    let published = 0;
    for (const hash of hashes) {
      const result = await publishTexture(minimapTexturePath(hash), archives);
      if (!result.cached) published++;
    }
    console.log(`Minimap map ${mapId} (${directory}): ${wanted.length} cells, ${hashes.length} distinct tiles, ${published} newly decoded`);
  } finally {
    archives.close();
  }
}
