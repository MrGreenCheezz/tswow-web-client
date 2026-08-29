// Gives every published cache entry that carries no stamp one, in a single pass, without
// rendering anything.
//
// `tools/source-stamp.mjs` says why a stamp exists; this file exists because of when they started
// being written. Everything under `data/` was published before that, so none of it can say what it
// came from: measured on this machine, 23,025 of the 24,796 published files carry no sidecar,
// 21,068 of them item icons. `DatasetFingerprint.ensureCurrent` used to answer that by asking for
// the entry to be rebuilt, once, so that it gained one — right for a cache that fills a file at a
// time, and wrong for a whole tree that a bulk pass filled, because every one of those entries is
// then a child process on its family's serial lane. `ef685e6` measured it for the spell icons:
// sixteen already-correct pictures asked for at once cost 5,921 ms and sixteen processes, one
// every 370 ms with nothing overlapping. A texture is 308 ms, a city WMO or a terrain tile is
// seconds, and there are 23,025 of them — so the first zone visit after a build stalls for
// minutes, and a module's genuinely new asset waits behind a backlog of art that never changed.
//
// The way out is that a stamp does not need the picture. It needs the source that won each input
// path and that file's size and mtime, and for the families below the entry's own *name* says
// which paths those are: an item icon is its display id, a horizon is its map, a terrain tile is
// its map and grid cell. So this walks the tree, works out each unstamped entry's inputs from its
// name, and writes the sidecar. Nothing is decoded, nothing is re-encoded, and no published file
// is touched — the pass runs while the gateway is serving that very directory.
//
// What it does not do is *prove* the published bytes are what those inputs decode to today. The
// icon pass in `generate-spell-icons.mjs --restamp` does, because for a 2 KB picture that is
// cheap; here it would mean re-rendering the tree, which is the thing being avoided. The entries
// were published on this machine out of this chain, so deriving is the honest reading of them, and
// the case it can be wrong in — bytes replaced under the cache by something other than a
// generator — is one nothing else in the machine defends against either.
//
// Two families have no way back from the name: `data/textures` and `data/visual-models` are keyed
// on sha1 of a path, and no file on disk holds the path that was hashed. Reversing them would mean
// enumerating every texture and model reference in the client — several DBCs, every M2's own
// texture block and every ADT's placement list — to find the ones that hash to the names already
// published. They are reported as unrecoverable and left alone, and nothing comes back for them:
// `ensureCurrent` never drops an entry that has no stamp, so the only thing that runs either
// generator again is the published file going missing (`Gateway.ts`, the ENOENT arm of `/texture`
// and `/visual/model`). Those 1,506 entries are served as they stand and stay unwatched until
// somebody deletes them — the price of not re-rendering 112 MB of art to learn what it was made
// from, and the reason a *new* entry in either family is stamped on the way out of its generator.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openDbcFile } from "./dbc.mjs";
import { LIQUID_CLASSES, liquidTexturePattern } from "./generate-liquid-texture.mjs";
import { soundId, soundKitFiles } from "./generate-sound.mjs";
import { MINIMAP_TRS } from "./minimap-index.mjs";
import { parseAdtPlacements } from "./adt-placements.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory, repositoryRoot } from "./paths.mjs";
import { sourceStamp, stampSidecar, writeSourceStamp } from "./source-stamp.mjs";

/** How many sidecars are derived and written at once. The work is stats and small writes. */
const CONCURRENCY = 32;
/** How many frames of a texture family a liquid strip is built from; the generator's own number. */
const LIQUID_FRAMES = 30;

/** How many recovery failures a family says out loud before it just counts them. */
const REPORTED_FAILURES = 5;

const dryRun = process.argv.includes("--dry-run");
if (process.argv.slice(2).some((argument) => argument !== "--dry-run")) {
  throw new Error("Usage: node tools/restamp.mjs [--dry-run]");
}

/**
 * Where each family is published and how an entry's name is read back into the paths it was
 * built from.
 *
 * The directories are the same environment variables the generators and `main.ts` use, so a test
 * — or an operator with a second cache — points the whole pass somewhere else in one place.
 */
const FAMILIES = [
  {
    name: "item-icons",
    directory: cacheDirectory("ITEM_ICON_DIR", "data/item-icons"),
    inputs: itemIconInputs,
  },
  { name: "minimap", directory: cacheDirectory("MINIMAP_DIR", "data/minimap"), inputs: minimapInputs },
  { name: "horizon", directory: cacheDirectory("HORIZON_DIR", "data/horizon"), inputs: horizonInputs },
  { name: "liquid", directory: cacheDirectory("LIQUID_DIR", "data/liquid"), inputs: liquidInputs },
  { name: "sound", directory: cacheDirectory("SOUND_DIR", "data/sound"), inputs: soundInputs },
  {
    name: "terrain-textures",
    directory: cacheDirectory("TERRAIN_TEXTURE_DIR", "data/terrain-textures"),
    inputs: terrainInputs,
  },
  {
    name: "terrain-layers",
    directory: cacheDirectory("TERRAIN_LAYER_DIR", "data/terrain-layers"),
    inputs: terrainLayerInputs,
  },
  { name: "visual-tiles", directory: cacheDirectory("VISUAL_TILE_DIR", "data/visual-tiles"), inputs: visualTileInputs },
  {
    name: "textures",
    directory: cacheDirectory("TEXTURE_DIR", "data/textures"),
    // sha1(`texture-v1\0<path>`), and nothing on disk holds the path.
    inputs: () => undefined,
  },
  {
    name: "visual-models",
    directory: cacheDirectory("VISUAL_MODEL_DIR", "data/visual-models"),
    // sha1(`visual-v16\0<path>`) for M2 or `visual-wmo-v17` for WMO, same as the gateway — and the
    // stamp names every file the model's own publish read: .skin, external .anim or WMO groups.
    inputs: (name) => (/\.bin$/i.test(name) ? undefined : null),
  },
];

function cacheDirectory(variable, fallback) {
  return process.env[variable] ? resolve(process.env[variable]) : resolve(repositoryRoot, fallback);
}

/**
 * The archive chain, the DBC tables and the ADTs, opened on first use and only if there is work.
 *
 * A pass with nothing to do must cost a node start and a walk of the tree: the gateway runs this
 * at every startup, and opening the twenty-two archives is 185 ms that a stamped cache has no
 * reason to pay.
 */
let chain;
const tables = new Map();
const adts = new Map();
/** One stamp per distinct input list, keyed on it; `stampFor` says why. */
const stamps = new Map();

/**
 * The three reverse indexes, each held as the promise of itself rather than as the map.
 *
 * `inBatches` has thirty-two entries in flight, so a lazy index guarded by "is it empty yet"
 * builds thirty-two times over and thirty-one callers read it while it is still empty. Measured
 * before this was a promise: 1 of 13 sounds and 1 of 107 ground textures recovered, the rest
 * counted as names that do not name their inputs.
 */
let itemIcons;
let soundPaths;
let layerPaths;

async function archiveChain() {
  chain ??= await clientArchives(clientDirectory());
  return chain;
}

/** `ItemDisplayInfo.InventoryIcon` by display id. */
function itemIconIndex() {
  itemIcons ??= (async () => {
    const index = new Map();
    const displayInfo = await table("ItemDisplayInfo");
    for (const row of displayInfo.rows()) {
      const icon = displayInfo.string(row, "InventoryIcon", 0).replaceAll("/", "\\");
      if (icon) index.set(displayInfo.id(row), icon);
    }
    return index;
  })();
  return itemIcons;
}

/**
 * Every path `SoundEntries` names, by the sha1 the sound cache keys it under.
 *
 * The id is sha1 of the normalised path, so one pass over the table's 12,941 rows and their ten
 * file slots names every sound this cache could hold. A file published by hand, which
 * `generate-sound.mjs` also allows, is in no row and is reported unrecoverable.
 */
function soundPathIndex() {
  soundPaths ??= (async () => {
    const index = new Map();
    const entries = await table("SoundEntries");
    for (const row of entries.rows()) {
      // First row wins, the way `soundKitIndex` in the generator resolves the same collision. The
      // id is over the lowercased path, so rows that spell one file two ways share a key: of the
      // 20 published sounds here that have a generator's own sidecar to be held against, keeping
      // the last row instead of the first left 7 stamps naming `sound\music\citymusic\…` and
      // `Sound\Interface\…` where the generator had written `Sound\Music\CityMusic\…` and
      // `Sound\interface\…`. Nothing compares a stamp on the spelling — `DatasetFingerprint`
      // compares the file, its size and its mtime — but a stamp that does not read back as the one
      // it replaced is a stamp nobody can check.
      for (const path of soundKitFiles(entries, row)) {
        const id = soundId(path);
        if (!index.has(id)) index.set(id, path);
      }
    }
    return index;
  })();
  return soundPaths;
}

/**
 * Every ground texture the published tiles name, by the sha1 the layer cache keys it under.
 *
 * Nothing on disk holds a layer's path either, but the set it is drawn from is small and known: a
 * layer is only ever published by the tile that uses it, so hashing the `MTEX` list of every
 * published tile names every layer that can be there.
 */
function layerPathIndex() {
  layerPaths ??= (async () => {
    const index = new Map();
    for (const cell of await publishedTiles()) {
      const tile = await mapTile(cell.map, cell.gridX, cell.gridY).catch(() => undefined);
      for (const path of tile?.textures ?? []) {
        index.set(createHash("sha1").update(`terrain-layer-v1\0${path.toLowerCase()}`).digest("hex"), path);
      }
    }
    return index;
  })();
  return layerPaths;
}

async function table(name) {
  let opened = tables.get(name);
  if (!opened) {
    opened = openDbcFile(dbcDirectory(), name);
    tables.set(name, opened);
  }
  return opened;
}

/** The internal directory name of a map, e.g. 0 -> "Azeroth". */
async function internalMapName(id) {
  const maps = await table("Map");
  const row = maps.rowOf(id);
  return row === undefined ? undefined : maps.string(row, "Directory");
}

const started = Date.now();
const report = [];
let stamped = 0;
let unrecoverable = 0;
try {
  for (const family of FAMILIES) {
    const entries = await unstampedEntries(family.directory);
    if (entries.length === 0) continue;
    let written = 0;
    let lost = 0;
    let said = 0;
    await inBatches(entries, async ({ file, name }) => {
      let inputs;
      try {
        inputs = await family.inputs(name);
      } catch (error) {
        // A table that will not open or a tile that is no longer in the client: this entry keeps
        // its silence, and the rest of the family is still worth stamping. Said a few times and
        // then only counted — one broken table is one line per entry otherwise, and this family
        // holds 21,071 of them.
        if (said++ < REPORTED_FAILURES) {
          console.warn(`  ${family.name}/${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
        inputs = undefined;
      }
      // `null` is "this name was never something that carries a stamp" — a WMO's own textures are
      // published beside the model and served by a route that has no generator of its own — and
      // must not be counted as a failure to recover anything.
      if (inputs === null) return;
      if (!inputs) {
        lost++;
        return;
      }
      if (!dryRun) await writeSourceStamp(file, await stampFor(inputs));
      written++;
    });
    stamped += written;
    unrecoverable += lost;
    report.push(`${family.name}: ${written} stamped${lost > 0 ? `, ${lost} unrecoverable` : ""}`);
  }
} finally {
  chain?.close();
}

// On stderr, and that is not a mistake. The gateway starts this as a child and relays what it
// says, the way it relays `check-shadowed-tables.mjs`; StormLib's WebAssembly build writes its own
// startup banner and every heap resize to *stdout* — 9 lines here — so the report has to be on the
// other stream or the operator's log fills with the allocator's diary.
const elapsed = Date.now() - started;
process.stderr.write(`Stamped ${stamped} published entr${stamped === 1 ? "y" : "ies"} in ${elapsed} ms`
  + `${unrecoverable > 0 ? `, ${unrecoverable} whose names do not name their inputs` : ""}`
  + `${dryRun ? " (dry run: nothing was written)" : ""}\n`);
for (const line of report) process.stderr.write(`  ${line}\n`);

/**
 * One stamp per distinct input list, not per entry.
 *
 * `sourceOf` walks the chain for every path it is given, and the whole point of an icon cache is
 * that many entries share one picture: 21,071 item icons stand over far fewer BLPs, and asking the
 * twenty-two sources about the same file twenty times over is the difference between a pass that
 * takes seconds and one that takes minutes.
 */
async function stampFor(inputs) {
  const key = [...(inputs.paths ?? []), "::", ...(inputs.files ?? [])].join("|");
  let pending = stamps.get(key);
  if (!pending) {
    pending = sourceStamp(chain ?? await archiveChain(), inputs);
    stamps.set(key, pending);
  }
  return pending;
}

/**
 * Whether a sidecar is one `DatasetFingerprint` will actually read a stamp out of.
 *
 * `writeSourceStamp` is a plain `writeFile`, and this pass issues tens of thousands of them in the
 * background while the gateway is serving that same directory: a crash, a full disk or a machine
 * losing power in the middle of one leaves a sidecar that parses as nothing. `ensureCurrent` reads
 * that as "no stamp" and serves the entry as it stands, which is right, and it used to *also*
 * rebuild the entry, which repaired it. Nothing does now — so a torn sidecar this pass skipped on
 * the strength of its name alone would never be written again. The three checks are `parseStamp`'s
 * own, so "readable" here means exactly what the gateway means by it.
 */
async function readableStamp(file) {
  try {
    const stamp = JSON.parse(await readFile(file, "utf8"));
    return typeof stamp === "object" && stamp !== null
      && typeof stamp.chain === "string" && Array.isArray(stamp.sources) && Array.isArray(stamp.files);
  } catch {
    return false;
  }
}

/** Every published file under one family with no readable sidecar beside it, sidecars excluded. */
async function unstampedEntries(directory) {
  const found = [];
  const stamped = [];
  const walk = async (current, prefix) => {
    let listing;
    try {
      listing = await readdir(current, { withFileTypes: true });
    } catch {
      // A family this machine has never published. Not an error: `data/` fills as it is asked for.
      return;
    }
    const names = new Set(listing.filter((entry) => entry.isFile()).map((entry) => entry.name));
    for (const entry of listing) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(".src")) continue;
      if (names.has(stampSidecar(entry.name))) {
        stamped.push({ file: absolute, name: `${prefix}${entry.name}`, sidecar: join(current, stampSidecar(entry.name)) });
        continue;
      }
      found.push({ file: absolute, name: `${prefix}${entry.name}` });
    }
  };
  await walk(directory, "");
  // The sidecars are opened after the walk and in parallel, not one at a time inside it. A warm
  // tree holds 22,666 of them, and measured over this machine's published cache the whole pass
  // with nothing to do is 0.99 s reading none of them, 2.05 s reading them thirty-two at a time,
  // and 4.65 s reading them one at a time inside the walk.
  await inBatches(stamped, async (entry) => {
    if (!await readableStamp(entry.sidecar)) found.push({ file: entry.file, name: entry.name });
  });
  return found;
}

/** Bounded parallelism: the work is stats and 200-byte writes, and 21,071 of them serially is not. */
async function inBatches(items, run) {
  let next = 0;
  const workers = [];
  for (let worker = 0; worker < Math.min(CONCURRENCY, items.length); worker++) {
    workers.push((async () => {
      while (next < items.length) await run(items[next++]);
    })());
  }
  await Promise.all(workers);
}

/**
 * `<displayId>.png`, out of `ItemDisplayInfo.InventoryIcon` — the same two inputs
 * `generate-item-icon.mjs` records: the BLP, and the table that said it was this display's icon.
 */
async function itemIconInputs(name) {
  const displayId = entryId(name, ".png");
  if (displayId === undefined) return undefined;
  const icon = (await itemIconIndex()).get(displayId);
  if (!icon) return undefined;
  let source = icon.includes("\\") ? icon : `Interface\\Icons\\${icon}`;
  if (!source.toLowerCase().endsWith(".blp")) source += ".blp";
  return { paths: [source], files: [join(dbcDirectory(), "ItemDisplayInfo.dbc")] };
}

/** `<map>.json`: one file answers every map, so every index has the same single input. */
function minimapInputs(name) {
  return entryId(name, ".json") === undefined ? undefined : { paths: [MINIMAP_TRS] };
}

/** `<map>.wdl`: the client's own far-horizon file for that map's directory. */
async function horizonInputs(name) {
  const mapId = entryId(name, ".wdl");
  if (mapId === undefined) return undefined;
  const mapName = await internalMapName(mapId);
  return mapName ? { paths: [`World\\Maps\\${mapName}\\${mapName}.wdl`] } : undefined;
}

/** `<class>.png` and `<class>.json`: the thirty frames of the family and the table that names it. */
async function liquidInputs(name) {
  const liquidClass = name.replace(/\.(png|json)$/i, "");
  if (!LIQUID_CLASSES.includes(liquidClass) || liquidClass === name) return undefined;
  const pattern = await liquidTexturePattern(dbcDirectory(), liquidClass);
  const archives = await archiveChain();
  const paths = [];
  // The generator stops at the first frame the client does not have, and `sourceStamp` drops a
  // path that resolves to nothing — so this has to stop in the same place to record the same list.
  for (let frame = 1; frame <= LIQUID_FRAMES; frame++) {
    const path = pattern.replace("%d", String(frame));
    if (!await archives.has(path)) break;
    paths.push(path);
  }
  return paths.length === 0 ? undefined : { paths, files: [join(dbcDirectory(), "LiquidType.dbc")] };
}

/** `<sha1>.wav` and `<sha1>.mp3`, through the index of every path `SoundEntries` names. */
async function soundInputs(name) {
  if (!/\.(wav|mp3)$/i.test(name)) return undefined;
  const path = (await soundPathIndex()).get(name.slice(0, name.lastIndexOf(".")));
  return path ? { paths: [path] } : undefined;
}

/**
 * `<map>/<x>-<y>.png` and the four splat parts beside it.
 *
 * Both terrain generators record the same three things — the tile, the map's own header, and every
 * ground texture the tile names — so all five published names share one derivation. The ADT is read
 * once per tile and its `MTEX` list kept, because a tile publishes up to five files and the layers
 * below are hashed out of the same list.
 */
async function terrainInputs(name) {
  const cell = /^(\d{1,4})[/\\](\d{1,2})-(\d{1,2})(?:\.(?:alpha|index|mccv)\.png|\.splat\.json|\.png)$/.exec(name);
  if (!cell) return undefined;
  const tile = await mapTile(Number(cell[1]), Number(cell[2]), Number(cell[3]));
  return tile && { paths: [tile.adtPath, tile.wdtPath, ...tile.textures] };
}

/** `<sha1>.png`, where the hash is of a ground texture's path: through the published tiles. */
async function terrainLayerInputs(name) {
  if (!/^[0-9a-f]{40}\.png$/i.test(name)) return undefined;
  const path = (await layerPathIndex()).get(name.slice(0, -4).toLowerCase());
  return path ? { paths: [path] } : undefined;
}

/** `<map>/<x>-<y>.json`: the tile, and every building whose furniture was read out of it. */
async function visualTileInputs(name) {
  const cell = /^(\d{1,4})[/\\](\d{1,2})-(\d{1,2})\.json$/.exec(name);
  if (!cell) return undefined;
  const mapName = await internalMapName(Number(cell[1]));
  if (!mapName) return undefined;
  const adtPath = `World\\Maps\\${mapName}\\${mapName}_${Number(cell[3])}_${Number(cell[2])}.adt`;
  const adt = await (await archiveChain()).read(adtPath);
  if (!adt) return undefined;
  const wmoPaths = [...new Set(parseAdtPlacements(adt)
    .filter((object) => object.kind === "wmo")
    .map((object) => object.name))];
  return { paths: [adtPath, ...wmoPaths] };
}

/** Which map, grid X and grid Y the terrain families have already published. */
async function publishedTiles() {
  const root = FAMILIES.find((family) => family.name === "terrain-textures").directory;
  const tiles = [];
  let maps;
  try {
    maps = await readdir(root, { withFileTypes: true });
  } catch {
    return tiles;
  }
  for (const map of maps) {
    if (!map.isDirectory() || !/^\d{1,4}$/.test(map.name)) continue;
    for (const file of await readdir(join(root, map.name))) {
      const cell = /^(\d{1,2})-(\d{1,2})\.splat\.json$/.exec(file);
      if (cell) tiles.push({ map: Number(map.name), gridX: Number(cell[1]), gridY: Number(cell[2]) });
    }
  }
  return tiles;
}

/** One tile's paths and its ground-texture list, read from the archives once and kept. */
async function mapTile(mapId, gridX, gridY) {
  const key = `${mapId}/${gridX}/${gridY}`;
  let pending = adts.get(key);
  if (!pending) {
    pending = (async () => {
      const mapName = await internalMapName(mapId);
      if (!mapName) return undefined;
      const adtPath = `World\\Maps\\${mapName}\\${mapName}_${gridY}_${gridX}.adt`;
      const adt = await (await archiveChain()).read(adtPath);
      if (!adt) return undefined;
      return {
        adtPath,
        wdtPath: `World\\Maps\\${mapName}\\${mapName}.wdt`,
        textures: adtGroundTextures(adt),
      };
    })();
    adts.set(key, pending);
  }
  return pending;
}

/**
 * The `MTEX` list of an ADT: every ground texture the tile paints with, in the order the layers
 * index into.
 *
 * Both terrain generators read the same chunk on their way past the ones they also need; this
 * reads only that one, because the alpha maps and the heights are exactly what is not being
 * rebuilt here.
 */
function adtGroundTextures(data) {
  for (let offset = 0; offset + 8 <= data.length;) {
    const tag = [...data.subarray(offset, offset + 4)].reverse().map((value) => String.fromCharCode(value)).join("");
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > data.length) throw new Error(`Truncated ADT ${tag} chunk`);
    if (tag === "MTEX") return data.subarray(start, end).toString("latin1").split("\0").filter(Boolean);
    offset = end;
  }
  return [];
}

/** A published name that is a bare positive id and the expected extension, or undefined. */
function entryId(name, extension) {
  if (!name.toLowerCase().endsWith(extension)) return undefined;
  const id = Number(name.slice(0, -extension.length));
  return Number.isInteger(id) && id >= 0 ? id : undefined;
}
