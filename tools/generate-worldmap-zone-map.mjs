// Publishes the original client's continent hit mask through a narrow, map-id keyed cache.
//
// A ZMP is not an image and exposing it through the arbitrary client-file route would widen that
// route to a binary format no other UI source needs. This generator is the archive boundary: it
// resolves one Map.dbc directory, accepts only that one `Interface\WorldMap\<name>.zmp`, validates
// the fixed 128x128 uint32 layout, and writes the exact bytes the browser decoder consumes.

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceMissing, SOURCE_MISSING_EXIT } from "./generate-texture.mjs";
import { internalMapName } from "./map-directory.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { stampGenerated } from "./source-stamp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WORLD_MAP_ZONE_MAP_BYTES = 128 * 128 * 4;

export function worldMapZoneMapsDirectory() {
  return resolve(root, process.env.WORLD_MAP_ZONE_MAP_DIR ?? "data/worldmap-zone-maps");
}

export function worldMapZoneMapPath(mapDirectory) {
  if (!mapDirectory || /[\\/]/.test(mapDirectory)) throw new Error(`Invalid map directory ${mapDirectory}`);
  return `Interface\\WorldMap\\${mapDirectory}.zmp`;
}

export async function publishWorldMapZoneMap(
  mapId,
  mapDirectory,
  archives,
  outputDirectory = worldMapZoneMapsDirectory(),
) {
  const source = worldMapZoneMapPath(mapDirectory);
  const data = await archives.read(source);
  if (!data) throw new SourceMissing(`${source} is not in the client`);
  if (data.byteLength !== WORLD_MAP_ZONE_MAP_BYTES) {
    throw new Error(`${source} is ${data.byteLength} bytes; a 128x128 uint32 ZMP must be ${WORLD_MAP_ZONE_MAP_BYTES}`);
  }
  const destination = resolve(outputDirectory, `${mapId}.bin`);
  const temporary = `${destination}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(temporary, data);
    // A killed generator may leave a disposable temporary, never a partial 65,536-byte cache entry
    // under the live name. Rename is the only moment at which readers can observe the new ZMP.
    await rename(temporary, destination);
    // The MapID cache key is resolved through Map.dbc. If a module remaps that id to a different
    // directory, unchanged old ZMP bytes are still the wrong source and must be invalidated.
    await stampGenerated(destination, archives, {
      paths: [source],
      files: [resolve(dbcDirectory(), "Map.dbc")],
    });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return { destination, source, bytes: data.byteLength };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const mapId = Number.parseInt(process.argv[2] ?? "", 10);
  if (!Number.isInteger(mapId) || mapId < 0) {
    throw new Error("Usage: node tools/generate-worldmap-zone-map.mjs <map>");
  }
  const mapDirectory = await internalMapName(dbcDirectory(), mapId);
  if (!mapDirectory) throw new SourceMissing(`Map.dbc has no map ${mapId}`);
  const archives = await clientArchives(clientDirectory());
  try {
    const result = await publishWorldMapZoneMap(mapId, mapDirectory, archives);
    console.log(`Published ${result.source} (${result.bytes} bytes)`);
  } catch (error) {
    if (!(error instanceof SourceMissing)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = SOURCE_MISSING_EXIT;
  } finally {
    archives.close();
  }
}
