import { openDbcFile } from "./dbc.mjs";

/**
 * The internal directory name of a map, e.g. 0 -> "Azeroth".
 *
 * Both the terrain tiles and the minimap tiles are addressed by this name rather than by the map
 * id, so it lives here rather than being copied into each generator.
 */
export async function internalMapName(directory, id) {
  const maps = await openDbcFile(directory, "Map");
  const row = maps.rowOf(id);
  return row === undefined ? undefined : maps.string(row, "Directory");
}

/** Every map that has a directory of its own, which is every map that could have tiles. */
export async function mapsWithDirectory(directory) {
  const maps = await openDbcFile(directory, "Map");
  const found = [];
  for (const row of maps.rows()) {
    const name = maps.string(row, "Directory");
    if (name) found.push({ id: maps.id(row), directory: name });
  }
  return found;
}
