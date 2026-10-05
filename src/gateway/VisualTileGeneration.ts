import { readFile } from "node:fs/promises";

/**
 * 05.10-A7b-1 (M-A7b-1): the generation of `/visual/environment` tiles this gateway serves and asks
 * `tools/generate-visual-tile.mjs` to write (`VISUAL_TILE_GENERATION` there; the two are kept equal
 * by `tests/visual-tile-v5.test.mjs`).
 *
 * v5 is slice 1 of line A7b: a WMO placement's doodads are set 0 plus its own set (7.02, numbered as
 * the `visual-wmo-v25` WME4 room tables number them), a doodad only outdoor groups own is outdoor
 * scenery (7.03 slice 1), WMO placements carry `wmoId`/`nameSet` (7.13) and a tile the 10,000-object
 * cap cut says so (7.19). The generator is told the generation in the job: a gateway still running
 * v4 names none and keeps receiving v4 bytes from the same freshly loaded tools.
 */
export const VISUAL_TILE_GENERATION = "visual-tile-v5";

/**
 * How many WMO doodads the generator had to leave out of a tile for the object cap (7.19), from the
 * `<x>-<y>.meta.json` sidecar it writes only when it cut something; 0 for a tile that fits or a tile
 * an older generator wrote.
 */
export async function visualTileTruncation(tileFile: string): Promise<number> {
  try {
    const meta: unknown = JSON.parse(await readFile(tileFile.replace(/\.json$/i, ".meta.json"), "utf8"));
    const truncated = (meta as { truncated?: unknown } | null)?.truncated;
    return typeof truncated === "number" && Number.isInteger(truncated) && truncated > 0 ? truncated : 0;
  } catch {
    return 0;
  }
}
