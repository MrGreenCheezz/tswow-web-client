// Builds what the gateway would otherwise build on the first request, for one map (10.22).
//
//   node tools/pregenerate.mjs --map <id> [--tiles x1,y1-x2,y2] [--families splat,tile,models,players]
//                              [--limit N] [--dry-run]
//
// After a patch change `tools/restamp.mjs` proves and re-signs what is already published; this
// builds what is *missing* or stale: each tile's ground splat (or its 7.23 `.nosplat` marker), its
// visual tile and model list, and every model the tiles place; `players` adds the playable races'
// character models (ChrRaces → CreatureDisplayInfo → CreatureModelData, the path the browser asks
// `/visual/model` for). It runs the very `publish*` functions the gateway's workers run
// (`tools/asset-jobs.mjs`), in this one process, out of one open archive chain, below normal
// priority. Entries whose stamp still matches the client are skipped, so a second run does nothing.
//
// It writes where the generators write — `data/…` by default, or the directories the usual
// variables name (TERRAIN_TEXTURE_DIR, TERRAIN_LAYER_DIR, VISUAL_TILE_DIR, WMO_DOODAD_CACHE_DIR,
// VISUAL_MODEL_DIR, TEXTURE_DIR) — and it is the owner's to run: the gateway's published cache is
// his. Running beside a live gateway is safe (both write atomically or idempotently) but shares the
// processor, so use `--limit` while playing. `--dry-run` reads the chain and writes nothing.
// Exit code 1 on any failure other than "the client does not hold it".

import { readFile, stat } from "node:fs/promises";
import { constants, setPriority } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDbcFile } from "./dbc.mjs";
import { internalMapName } from "./map-directory.mjs";
import { openClientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory, repositoryRoot } from "./paths.mjs";
import { SourceMissing } from "./source-missing.mjs";
import { stampSidecar } from "./source-stamp.mjs";
import { publishTileModels, tileModelNames, tileModelsFile } from "./tile-models.mjs";
import { visualModelHash } from "./visual-model-key.mjs";

export const PREGENERATE_FAMILIES = Object.freeze(["splat", "tile", "models", "players"]);
/** The visual tile generation the gateway requires (`/visual/environment`). */
const VISUAL_TILE_GENERATION = "visual-tile-v5"; // 05.10-A7b-1
/** The terrain splat generation the gateway requires (`/terrain-splat`). */
const TERRAIN_SPLAT_GENERATION = "terrain-splat-v2"; // 05.10-A7b-7

const directory = (variable, fallback) => resolve(repositoryRoot, process.env[variable] ?? fallback);

/**
 * Whether `destination` exists and the stamp beside it still describes the chain: the same
 * composition, every recorded source still the winner with the same size and mtime, every recorded
 * absence still absent, every plain file unchanged. The gateway's `DatasetFingerprint` asks the
 * same questions of the same stamp. No file or no stamp is "not current".
 */
export async function stampStillCurrent(destination, archives, { generation } = {}) {
  let stamp;
  try {
    await stat(destination);
    stamp = JSON.parse(await readFile(stampSidecar(destination), "utf8"));
  } catch {
    return false;
  }
  if (generation !== undefined && stamp?.generation !== generation) return false;
  if (stamp?.chain !== archives.chainDigest()) return false;
  for (const source of stamp.sources ?? []) {
    const now = await archives.sourceOf(source.path);
    if (!now || now.file !== source.file || now.size !== source.size || now.mtimeMs !== source.mtimeMs) return false;
  }
  for (const missing of stamp.missingSources ?? []) {
    if (await archives.has(missing.path)) return false;
  }
  for (const file of stamp.files ?? []) {
    try {
      const stats = await stat(file.file);
      if (stats.size !== file.size || stats.mtimeMs !== file.mtimeMs) return false;
    } catch {
      return false;
    }
  }
  for (const file of stamp.missingFiles ?? []) {
    if (await stat(file).then(() => true, () => false)) return false;
  }
  return true;
}

/** The map's tiles as the generators address them: `<Dir>_<gridY>_<gridX>.adt`. */
export async function mapTiles(archives, mapDirectory) {
  const prefix = `world\\maps\\${mapDirectory.toLowerCase()}\\${mapDirectory.toLowerCase()}_`;
  const tiles = [];
  for (const path of await archives.list(`World\\Maps\\${mapDirectory}\\`)) {
    if (!path.startsWith(prefix) || !path.endsWith(".adt")) continue;
    const cell = /^(\d{1,2})_(\d{1,2})\.adt$/.exec(path.slice(prefix.length));
    if (!cell) continue;
    const gridY = Number(cell[1]);
    const gridX = Number(cell[2]);
    if (gridX <= 63 && gridY <= 63) tiles.push({ gridX, gridY });
  }
  return tiles.sort((a, b) => a.gridX - b.gridX || a.gridY - b.gridY);
}

/**
 * The character models of every ChrRaces row, as `/visual/model` is asked for them. Every row and
 * not the classic ten: this core treats every race as playable (`RACEMASK_ALL_PLAYABLE` is
 * 0xFFFFFFFF, TrinityCore `SharedDefines.h:113`) and a TSWoW module may add its own. 36 paths on
 * this dataset, the rigs NPCs of those races share.
 */
export async function playerModelPaths(dbc) {
  const [races, displays, models] = await Promise.all([
    openDbcFile(dbc.races, "ChrRaces"), openDbcFile(dbc.models, "CreatureDisplayInfo"), openDbcFile(dbc.models, "CreatureModelData"),
  ]);
  const paths = [];
  for (const row of races.rows()) {
    for (const field of ["MaleDisplayID", "FemaleDisplayID"]) {
      const display = displays.rowOf(races.int(row, field));
      if (display === undefined) continue;
      const model = models.rowOf(displays.int(display, "ModelID"));
      if (model === undefined) continue;
      const path = models.string(model, "ModelName").replaceAll("/", "\\").replace(/\.(mdx|mdl|m2)$/i, ".m2");
      if (/^character\\/i.test(path) && !paths.some((known) => known.toLowerCase() === path.toLowerCase())) paths.push(path);
    }
  }
  return paths;
}

function parseArguments(argv) {
  const options = { map: undefined, tiles: undefined, families: [...PREGENERATE_FAMILIES], limit: Infinity, dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${argument} needs a value`);
      return next;
    };
    if (argument === "--map") options.map = Number(value());
    else if (argument === "--tiles") {
      const match = /^(\d{1,2}),(\d{1,2})-(\d{1,2}),(\d{1,2})$/.exec(value());
      if (!match) throw new Error("--tiles takes x1,y1-x2,y2");
      const [x1, y1, x2, y2] = match.slice(1).map(Number);
      options.tiles = { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
    } else if (argument === "--families") {
      options.families = value().split(",").map((name) => name.trim()).filter(Boolean);
      for (const family of options.families) {
        if (!PREGENERATE_FAMILIES.includes(family)) throw new Error(`Unknown family ${family} (${PREGENERATE_FAMILIES.join(", ")})`);
      }
    } else if (argument === "--limit") {
      options.limit = Number(value());
      if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error("--limit takes a whole number");
    } else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!Number.isInteger(options.map) || options.map < 0) {
    throw new Error("Usage: node tools/pregenerate.mjs --map <id> [--tiles x1,y1-x2,y2] [--families splat,tile,models,players] [--limit N] [--dry-run]");
  }
  return options;
}

/**
 * The whole run against an open chain; returns the counts. `log` gets one line per tile and the
 * summary. `limit` counts builds (dry run: would-be builds), not skips.
 */
export async function pregenerate(options, archives, log = (line) => console.log(line)) {
  const families = new Set(options.families);
  const counts = { tiles: 0, built: 0, skipped: 0, missing: 0, failed: 0, planned: 0 };
  const failures = [];
  const modules = {};
  const load = async (name, path) => (modules[name] ??= await import(path));
  const budgetLeft = () => counts.built + counts.planned < options.limit;
  /** One unit of work: skip, plan or build it. */
  const work = async (label, current, build) => {
    if (await current()) {
      counts.skipped++;
      return "skipped";
    }
    if (!budgetLeft()) return "limit";
    if (options.dryRun) {
      counts.planned++;
      return "planned";
    }
    try {
      await build();
      counts.built++;
      return "built";
    } catch (error) {
      if (error instanceof SourceMissing) {
        counts.missing++;
        return "missing";
      }
      counts.failed++;
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return "failed";
    }
  };

  const mapDirectory = await internalMapName(dbcDirectory(), options.map);
  if (!mapDirectory) throw new Error(`Map.dbc has no map ${options.map}`);
  const textures = directory("TERRAIN_TEXTURE_DIR", "data/terrain-textures");
  const tilesDirectory = directory("VISUAL_TILE_DIR", "data/visual-tiles");
  const modelsDirectory = directory("VISUAL_MODEL_DIR", "data/visual-models");
  const seenModels = new Set();
  const model = async (path) => {
    const key = path.toLowerCase();
    if (seenModels.has(key) || !/\.(m2|wmo)$/i.test(path)) return;
    seenModels.add(key);
    const hash = visualModelHash(path);
    await work(`model ${path}`, () => stampStillCurrent(join(modelsDirectory, `${hash}.bin`), archives),
      async () => (await load("model", "./generate-visual-model.mjs")).publishVisualModel(path, hash, archives));
  };

  let tiles = await mapTiles(archives, mapDirectory);
  if (options.tiles) {
    const { x1, y1, x2, y2 } = options.tiles;
    tiles = tiles.filter((tile) => tile.gridX >= x1 && tile.gridX <= x2 && tile.gridY >= y1 && tile.gridY <= y2);
  }
  for (const { gridX, gridY } of tiles) {
    if (!budgetLeft()) break;
    counts.tiles++;
    const results = [];
    if (families.has("splat")) {
      const base = join(textures, String(options.map), `${gridX}-${gridY}`);
      results.push(`splat ${await work(`splat ${gridX}/${gridY}`,
        async () => await stampStillCurrent(`${base}.splat.json`, archives, { generation: TERRAIN_SPLAT_GENERATION })
          || await stampStillCurrent(`${base}.nosplat`, archives),
        async () => (await load("splat", "./generate-terrain-splat.mjs")).publishTerrainSplat(options.map, gridX, gridY, archives,
          { generation: TERRAIN_SPLAT_GENERATION }))}`); // 05.10-A7b-7
    }
    const tileFile = join(tilesDirectory, String(options.map), `${gridX}-${gridY}.json`);
    if (families.has("tile")) {
      const current = await stampStillCurrent(tileFile, archives, { generation: VISUAL_TILE_GENERATION });
      results.push(`tile ${await work(`tile ${gridX}/${gridY}`, async () => current,
        async () => (await load("tile", "./generate-visual-tile.mjs")).publishVisualTile(options.map, gridX, gridY, archives,
          { generation: VISUAL_TILE_GENERATION }))}`); // 05.10-A7b-1
      // A current tile published before its model list existed gets the list, not a rebuild.
      if (current && !options.dryRun && !await stat(tileModelsFile(options.map, gridX, gridY)).then(() => true, () => false)) {
        await publishTileModels(options.map, gridX, gridY);
      }
    }
    if (families.has("models")) {
      let names;
      try {
        names = JSON.parse(await readFile(tileModelsFile(options.map, gridX, gridY), "utf8"));
      } catch {
        try {
          // A tile published before its list existed (or a dry run that did not build it).
          names = tileModelNames(JSON.parse(await readFile(tileFile, "utf8")));
        } catch {
          names = [];
        }
      }
      const before = counts.built + counts.planned;
      for (const name of names) {
        if (!budgetLeft()) break;
        await model(String(name).replaceAll("/", "\\"));
      }
      results.push(`models ${counts.built + counts.planned - before}/${names.length}`);
    }
    log(`${options.map}/${gridX}/${gridY}: ${results.join(", ")}`);
  }

  if (families.has("players") && budgetLeft()) {
    const dataset = dbcDirectory();
    const visual = directory("VISUAL_DBC_DIR", "data/visual-dbc");
    const hasVisual = await stat(join(visual, "CreatureModelData.dbc")).then(() => true, () => false)
      && await stat(join(visual, "CreatureDisplayInfo.dbc")).then(() => true, () => false);
    const players = await playerModelPaths({ races: dataset, models: hasVisual ? visual : dataset });
    for (const path of players) {
      if (!budgetLeft()) break;
      await model(path);
    }
    log(`players: ${players.length} models`);
  }

  log(`${options.dryRun ? "Would build" : "Built"} ${options.dryRun ? counts.planned : counts.built}, `
    + `skipped ${counts.skipped} current, ${counts.missing} not in the client, ${counts.failed} failed, over ${counts.tiles} tiles`);
  for (const failure of failures) log(`  failed: ${failure}`);
  return counts;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const options = parseArguments(process.argv.slice(2));
  try {
    // Below the game on the same machine, like the gateway's workers.
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not permitted here; run at normal priority.
  }
  const archives = await openClientArchives(clientDirectory());
  try {
    const counts = await pregenerate(options, archives);
    if (counts.failed > 0) process.exitCode = 1;
  } finally {
    archives.close();
  }
}
