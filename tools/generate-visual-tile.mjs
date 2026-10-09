import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { globalMapObjects, parseAdtPlacements, placementReachesCell } from "./adt-placements.mjs";
import { staticM2AdmissionRadius } from "./m2.mjs";
import { parseWmoDoodadSets, validParsedWmoDoodadSets, wmoDependencies, wmoRootId } from "./wmo-visual.mjs";
import { openDbcFile } from "./dbc.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { sourceStamp, stampGenerated, stampIsCurrent, writeFileAtomic, writeSourceStamp } from "./source-stamp.mjs";
import { tileModelNames, tileModelsFile } from "./tile-models.mjs";

const VMAP_TO_THREE = new THREE.Matrix4().set(
  -1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WMO_DOODAD_CACHE_VERSION = 1;

// 05.10-A7b-1 (M-A7b-1): one bump for slice 1 of line A7b — the effective doodad set (7.02), the
// owner class of a WMO doodad (7.03 slice 1), `wmoId`/`nameSet` on WMO placements (7.13) and the
// truncation sidecar (7.19). The gateway names the generation it serves in the job
// (`src/gateway/VisualTileGeneration.ts`); a gateway that names none is one still running
// `visual-tile-v4`, whose asset worker loads this file fresh from disk, and it keeps receiving the
// exact v4 bytes (and the v1 doodad cache) — `tests/visual-tile-v5.test.mjs` compares them.
//
// P2-04x: `visual-tile-v6` is v5 with one placement in one tile. On a map with ADTs a non-WMO record
// (an M2 placement or a WMO doodad) is written only into the tile its point lies in, unless that
// tile cannot carry it — its point is off the map, its ADT is missing, or its ADT does not list the
// placement (for a doodad: the parent WMO). WMO placements stay in every tile that lists them, and a
// map that is one WMO (no ADT, WDT global object) is untouched. The browser streams every tile its
// footprint circle (radius ENVIRONMENT_STREAM_RANGE, 810) touches, and no point record is drawn
// farther than that, so the tile of the record's point is always loaded whenever the record could be
// drawn: the union of ids over a footprint is unchanged, only the copies are gone (Stormwind: 80 % of
// the 86 321 records of its 14-tile footprint). A v5 gateway still gets v5 bytes; a client mixing
// v5 and v6 tiles keeps every record (a v6 tile drops only what the record's own tile carries in
// either generation).
export const VISUAL_TILE_GENERATION = "visual-tile-v6";
export const VISUAL_TILE_GENERATION_V5 = "visual-tile-v5";
export const LEGACY_VISUAL_TILE_GENERATION = "visual-tile-v4";
/** The doodad-set cache of the v5 generation: effective sets with MODD index and owner class. */
const WMO_DOODAD_CACHE_V2 = Object.freeze({ key: "wmo-doodad-light-v2", version: 2 });
/** The visual tile's hard cap, shared with the browser's decoder (`EnvironmentTileDecode.ts`). */
const VISUAL_TILE_OBJECT_LIMIT = 10_000;

/** `<x>-<y>.meta.json` beside a tile: what the v5 generator could not fit (7.19). */
export function visualTileMetaFile(tileFile) {
  return tileFile.replace(/\.json$/i, ".meta.json");
}

function validTile(mapId, gridX, gridY) {
  return [mapId, gridX, gridY].every(Number.isInteger) && mapId >= 0 && gridX >= 0 && gridX <= 63 && gridY >= 0 && gridY <= 63;
}

/**
 * Publishes one tile's placements out of an open chain: the persistent tile worker calls this per
 * job (10.20 slice 2), the command line below once. Output directories are read on every call, so
 * a long-lived worker follows its env and a test's. Leaves the chain open.
 */
export async function publishVisualTile(mapId, gridX, gridY, archives, options = {}) {
  if (!validTile(mapId, gridX, gridY)) throw new Error(`${mapId}/${gridX}/${gridY} is not a terrain tile`);
  // 05.10-A7b-1: which generation to write; none named is the v4 a running older gateway expects.
  const generation = options?.generation ?? LEGACY_VISUAL_TILE_GENERATION;
  if (generation !== LEGACY_VISUAL_TILE_GENERATION && generation !== VISUAL_TILE_GENERATION_V5
    && generation !== VISUAL_TILE_GENERATION) {
    throw new Error(`Unknown visual tile generation ${String(generation)}`);
  }
  // v6 is v5 plus one placement in one tile (P2-04x).
  const v6 = generation === VISUAL_TILE_GENERATION;
  const v5 = v6 || generation === VISUAL_TILE_GENERATION_V5;
  const placementOptions = v5 ? { nameSet: true } : undefined;
  const destination = resolve(root, process.env.VISUAL_TILE_DIR ?? "data/visual-tiles", String(mapId), `${gridX}-${gridY}.json`);
  const wmoDoodadCacheDirectory = resolve(
    root,
    process.env.WMO_DOODAD_CACHE_DIR ?? "data/visual-wmo-doodads",
  );
  const mapName = await internalMapName(dbcDirectory(), mapId);
  if (!mapName) throw new Error(`Map.dbc has no map ${mapId}`);

  const adtPath = `World\\Maps\\${mapName}\\${mapName}_${gridY}_${gridX}.adt`;
  const adt = await archives.read(adtPath);
  // What the tile was read out of, for the stamp: the ADT, or for a map that is one WMO its WDT.
  const tileSources = [adtPath];
  let objects;
  // P2-04x: the WMO placement each expanded doodad belongs to.
  const doodadParents = new Map();
  if (adt) objects = parseAdtPlacements(adt, placementOptions);
  else {
    // Thirty-nine maps of this client have no ADT at all: the WDT says "one global map object"
    // (MPHD flag 0x1) and names it in its own MWMO/MODF — Wailing Caverns, Blackrock Depths, Molten
    // Core, the Nexus. The records are the ADT's `SMMapObjDef`, so the ADT parser reads them as they
    // are. Each cell the building's box reaches answers the same placement (its furniture is keyed
    // on the placement, so `objectsAround` keeps one copy); the cells it does not reach are empty,
    // not missing. Before this every cell of such a map failed, and the dungeon drew nothing.
    const wdtPath = `World\\Maps\\${mapName}\\${mapName}.wdt`;
    const wdt = await archives.read(wdtPath);
    const global = wdt ? globalMapObjects(wdt, placementOptions) : undefined;
    if (!global) throw new Error(`${adtPath} is not in the client`);
    tileSources.push(wdtPath);
    objects = global.filter((placement) => placementReachesCell(placement, gridX, gridY));
  }
  const wmoPaths = [...new Set(objects.filter((object) => object.kind === "wmo").map((object) => object.name))];
  let doodadCount = 0;
  let missingWmos = 0;
  let truncated = 0;
  const wmoSourcePaths = new Set(wmoPaths);
  if (wmoPaths.length > 0) {
    const roots = new Map();
    for (const path of wmoPaths) {
      const data = await archives.read(path);
      if (!data) {
        missingWmos++;
        continue;
      }
      let groupPaths = [];
      try {
        groupPaths = wmoDependencies(data, path).groups;
      } catch {
        // Furniture lighting is optional enrichment. Keep a valid root placement on the ordinary
        // outdoor path when a custom/malformed WMO cannot enumerate its group files.
      }
      for (const groupPath of groupPaths) wmoSourcePaths.add(groupPath);
      const wmoId = v5 ? wmoRootId(data) : undefined;
      roots.set(path.toLowerCase(), {
        doodadSets: await cachedWmoDoodadSets(data, path, groupPaths, archives, wmoDoodadCacheDirectory, v5),
        ...(wmoId !== undefined ? { wmoId } : {}),
      });
    }
    const expanded = [];
    for (let placementIndex = 0; placementIndex < objects.length; placementIndex++) {
      const placement = objects[placementIndex];
      if (placement.kind !== "wmo") continue;
      const wmo = roots.get(placement.name.toLowerCase());
      if (!wmo) continue;
      // 05.10-A7b-1 (7.13): the WMOAreaTable key travels with the placement (`nameSet` came with it).
      if (wmo.wmoId !== undefined) placement.wmoId = wmo.wmoId;
      const requestedSet = placement.doodadSet ?? 0;
      // Under v5 each set is already the effective one (set 0 plus the placement's set, 7.02); a set
      // past the table falls back to set 0 alone, as wowee and the old path both do.
      const doodads = wmo.doodadSets[requestedSet] ?? wmo.doodadSets[0] ?? [];
      let doodadIndex = 0;
      // P2-04x: v6 expands every doodad and applies the cap after the copies are gone.
      for (; doodadIndex < doodads.length && (v6 || objects.length + expanded.length < VISUAL_TILE_OBJECT_LIMIT); doodadIndex++) {
        const doodad = worldDoodad(placement, doodads[doodadIndex], doodadIndex, v5);
        doodadParents.set(doodad, placement.id);
        expanded.push(doodad);
      }
      // 05.10-A7b-1 (7.19): the cap is no longer silent.
      truncated += doodads.length - doodadIndex;
    }
    doodadCount = expanded.length;
    for (const object of expanded) objects.push(object);
  }
  // P2-04x: one placement in one tile, on maps with ADTs. The neighbour ADTs read for it join the stamp.
  const neighbourSources = [];
  if (v6 && adt) {
    objects = await ownTileRecords(objects, doodadParents, mapName, gridX, gridY, archives, placementOptions, neighbourSources);
    if (objects.length > VISUAL_TILE_OBJECT_LIMIT) {
      // ADT placements come first and an ADT holds at most 10 000, so only doodads fall past the cap.
      truncated += objects.length - VISUAL_TILE_OBJECT_LIMIT;
      objects.length = VISUAL_TILE_OBJECT_LIMIT;
    }
    doodadCount = objects.reduce((count, object) => count + (doodadParents.has(object) ? 1 : 0), 0);
  }

  // Admission runs before a model is requested or built. Outdoor M2s have their own scenery budget
  // (ENVIRONMENT_SCENERY_BUDGET = 1 024 in WorldRenderer3D.ts) with a size-based leash; 320 and 48
  // are the near-WMO and far-WMO-shell budgets and 360 the building doodads'. Without a radius an
  // M2 cannot be culled before it is built, so admission spends scenery slots on objects behind the
  // camera. Read each distinct outdoor model from the same source chain as the tile and publish a
  // conservative origin-centred radius only for static geometry. Rigged and emitter models
  // deliberately retain the old fail-open path.
  const outdoorM2Paths = new Map();
  for (const object of objects) {
    if (object.kind === "m2" && object.interior !== true) {
      outdoorM2Paths.set(object.name.toLowerCase(), object.name);
    }
  }
  const outdoorM2Radii = new Map();
  for (const [key, path] of outdoorM2Paths) {
    const model = await archives.read(path);
    const radius = model ? staticM2AdmissionRadius(model) : undefined;
    if (radius !== undefined) outdoorM2Radii.set(key, radius);
  }
  for (const object of objects) {
    if (object.kind !== "m2" || object.interior === true) continue;
    const radius = outdoorM2Radii.get(object.name.toLowerCase());
    if (radius !== undefined) object.admissionRadius = radius;
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(objects));
  // The tile and every building whose furniture was read out of it: a module that changes a WMO's
  // doodad set changes this list without touching the ADT.
  const stamp = await sourceStamp(archives, {
    generation,
    paths: [...tileSources, ...neighbourSources, ...wmoSourcePaths, ...outdoorM2Paths.values()],
  });
  await writeSourceStamp(destination, stamp);
  if (v5) {
    // 05.10-A7b-1 (7.19): the tile stays a bare array (every reader keeps working); what the cap cut
    // goes beside it, and the route turns it into `X-Tile-Truncated`. A tile that fits has none.
    const meta = visualTileMetaFile(destination);
    if (truncated > 0) {
      console.warn(`Visual tile ${mapId}/${gridX}/${gridY}: ${truncated} WMO doodad(s) past the ${VISUAL_TILE_OBJECT_LIMIT}-object cap not published`);
      await writeFileAtomic(meta, JSON.stringify({ truncated }));
    } else await rm(meta, { force: true });
  }
  // 10.22: the distinct models of the tile, furniture included, for the gateway's preloader — a few
  // KB it can read instead of parsing this file (`tools/tile-models.mjs`). Same stamp: it is a
  // function of the tile. Stamp before bytes, so a torn write never leaves a list served as current.
  const models = tileModelsFile(mapId, gridX, gridY);
  await writeSourceStamp(models, stamp);
  await writeFileAtomic(models, JSON.stringify(tileModelNames(objects)));
  const absent = missingWmos > 0 ? `, ${missingWmos} WMO(s) not in the client` : "";
  console.log(`Generated visual tile ${mapId}/${gridX}/${gridY}: ${objects.length} objects (${doodadCount} WMO doodads)${absent}`);
  return v5 ? { objects: objects.length, doodads: doodadCount, truncated } : { objects: objects.length, doodads: doodadCount };
}

// Run directly: node tools/generate-visual-tile.mjs <map> <grid-x> <grid-y> [generation]
// (the gateway passes `visual-tile-v6`; without it the v4 tile an older gateway expects.)
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const mapId = Number.parseInt(process.argv[2] ?? "", 10);
  const gridX = Number.parseInt(process.argv[3] ?? "", 10);
  const gridY = Number.parseInt(process.argv[4] ?? "", 10);
  if (!validTile(mapId, gridX, gridY)) {
    throw new Error("Usage: node tools/generate-visual-tile.mjs <map> <grid-x> <grid-y>");
  }
  const archives = await clientArchives(clientDirectory());
  try {
    await publishVisualTile(mapId, gridX, gridY, archives,
      process.argv[5] ? { generation: process.argv[5] } : undefined);
  } finally {
    archives.close();
  }
}

/**
 * Parse a root's group ownership once, not once for every ADT that names the same city WMO.
 *
 * Stormwind is named by sixteen cells and has 286 group files. The gateway serialises visual-tile
 * generation, so this source-stamped, normalized-root-path cache turns the other fifteen runs into
 * one small JSON read while still invalidating when the root, any group, or archive chain changes.
 */
async function cachedWmoDoodadSets(rootData, rootPath, groupPaths, archives, wmoDoodadCacheDirectory, effective = false) {
  if (effective) {
    return cachedEffectiveWmoDoodadSets(rootData, rootPath, groupPaths, archives, wmoDoodadCacheDirectory);
  }
  const hash = createHash("sha1")
    .update(`wmo-doodad-light-v1\0${rootPath.toLowerCase()}`)
    .digest("hex");
  const destination = join(wmoDoodadCacheDirectory, `${hash}.json`);
  const inputs = {
    generation: "wmo-doodad-light-v1",
    paths: [rootPath, ...groupPaths],
  };
  try {
    if (await stampIsCurrent(destination, archives, inputs)) {
      const cached = JSON.parse(await readFile(destination, "utf8"));
      if (cached?.version === WMO_DOODAD_CACHE_VERSION
        && validParsedWmoDoodadSets(cached.sets)) return cached.sets;
    }
  } catch {
    // A torn/invalid optimization cache is only a miss. The tile itself still has to be generated.
  }

  const groups = [];
  for (const groupPath of groupPaths) {
    const group = await archives.read(groupPath);
    if (group) groups.push(group);
  }
  const sets = parseWmoDoodadSets(rootData, groups);
  const temporary = `${destination}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(temporary, JSON.stringify({ version: WMO_DOODAD_CACHE_VERSION, sets }));
    // A killed process can leave the temporary file, never a half-written payload under a stamp
    // that still compares current. Rename is the only point at which readers see the new JSON.
    await rename(temporary, destination);
    await stampGenerated(destination, archives, inputs);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    // A read-only/full cache directory costs performance, not a missing visual tile.
  }
  return sets;
}

/**
 * 05.10-A7b-1: the v5 twin of the cache above, under its own key so neither generation ever reads or
 * overwrites the other's file: effective sets (7.02) with each record's MODD index and owner class
 * (7.03 slice 1). A running v4 gateway keeps its v1 entries untouched.
 */
async function cachedEffectiveWmoDoodadSets(rootData, rootPath, groupPaths, archives, wmoDoodadCacheDirectory) {
  const { key, version } = WMO_DOODAD_CACHE_V2;
  const hash = createHash("sha1").update(`${key}\0${rootPath.toLowerCase()}`).digest("hex");
  const destination = join(wmoDoodadCacheDirectory, `${hash}.json`);
  const inputs = { generation: key, paths: [rootPath, ...groupPaths] };
  try {
    if (await stampIsCurrent(destination, archives, inputs)) {
      const cached = JSON.parse(await readFile(destination, "utf8"));
      if (cached?.version === version && validParsedWmoDoodadSets(cached.sets)) return cached.sets;
    }
  } catch {
    // A torn/invalid optimization cache is only a miss.
  }
  const groups = [];
  for (const groupPath of groupPaths) {
    const group = await archives.read(groupPath);
    if (group) groups.push(group);
  }
  const sets = parseWmoDoodadSets(rootData, groups, { effective: true });
  const temporary = `${destination}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(temporary, JSON.stringify({ version, sets }));
    await rename(temporary, destination);
    await stampGenerated(destination, archives, inputs);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return sets;
}

/** `terrainGrid` of `src/browser/Terrain.ts`, one axis: -1 off the map. */
const GRID_SIZE = 533.3333333333334;
function gridAxis(value) {
  if (!Number.isFinite(value) || value < -32 * GRID_SIZE || value > 32 * GRID_SIZE) return -1;
  return Math.max(0, Math.min(63, Math.floor(32 - value / GRID_SIZE)));
}

/**
 * P2-04x: the records of tile (gridX, gridY) that belong here — every WMO placement, and every other
 * record whose own tile is this one or cannot carry it. Order is kept. `sources` collects the
 * neighbour ADT paths consulted (present or absent), which the tile's stamp then names.
 */
async function ownTileRecords(objects, doodadParents, mapName, gridX, gridY, archives, placementOptions, sources) {
  const listings = new Map();
  const listing = async (x, y) => {
    const path = `World\\Maps\\${mapName}\\${mapName}_${y}_${x}.adt`;
    if (listings.has(path)) return listings.get(path);
    sources.push(path);
    const data = await archives.read(path);
    let listed = null;
    if (data) {
      listed = { m2: new Set(), wmo: new Set() };
      for (const placement of parseAdtPlacements(data, placementOptions)) listed[placement.kind]?.add(placement.id);
    }
    listings.set(path, listed);
    return listed;
  };
  const kept = [];
  for (const object of objects) {
    if (object.kind === "wmo") {
      kept.push(object);
      continue;
    }
    const ownX = gridAxis(object.x), ownY = gridAxis(object.y);
    if (ownX < 0 || ownY < 0 || (ownX === gridX && ownY === gridY)) {
      kept.push(object);
      continue;
    }
    const listed = await listing(ownX, ownY);
    const parent = doodadParents.get(object);
    const carried = parent !== undefined ? listed?.wmo.has(parent) : listed?.m2.has(object.id);
    if (!carried) kept.push(object);
  }
  return kept;
}

function worldDoodad(placement, doodad, doodadIndex, v5 = false) {
  const parentRotation = mappedRotation(placement.rotationX, placement.rotationY, placement.rotationZ);
  const position = new THREE.Vector3(-doodad.x, doodad.z, doodad.y)
    .multiplyScalar(placement.scale)
    .applyQuaternion(parentRotation)
    .add(new THREE.Vector3(placement.x, placement.z, -placement.y));
  const conversion = new THREE.Quaternion().setFromRotationMatrix(VMAP_TO_THREE);
  const localRotation = conversion.clone()
    .multiply(new THREE.Quaternion(doodad.quaternionX, doodad.quaternionY, doodad.quaternionZ, doodad.quaternionW).normalize())
    .multiply(conversion.clone().invert());
  const rotation = parentRotation.clone().multiply(localRotation).normalize();
  // Keyed on the placement's own uniqueId, not on the tile it was read from. A building can be
  // named by many ADTs — Stormwind by sixteen, all carrying uniqueId 10047 at the same spot — and
  // a tile-derived id gave each copy of the same chair a different one, so the id-dedupe in
  // `objectsAround` caught the building and not its furniture. Measured at the Trade District:
  // 754 interior records over 377 distinct doodads, and 60 of the 120 budget slots spent twice on
  // the same object.
  return {
    id: -(placement.id * 1_000_000 + doodadIndex + 1),
    kind: "m2",
    // What this doodad belongs to, not merely what it is. A WMO's own doodads are the furniture
    // inside a building, and there are far more of them than there are things on the ground:
    // Azeroth_31_49, the Goldshire tile, holds 1,302 terrain placements and 6,638 WMO doodads.
    // The browser draws them on their own budget so a fork on a table in the inn cannot take the
    // draw call a tree fifty metres away needed.
    //
    // 05.10-A7b-1 (7.03 slice 1): under v5 a doodad only outdoor groups own — a façade lamp, a sign,
    // a banner — is outdoor scenery: size-based range and the scenery quota, not the 60-yard leash.
    interior: !(v5 && doodad.outdoor === true),
    name: doodad.name,
    x: position.x,
    y: -position.z,
    z: position.y,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    scale: placement.scale * doodad.scale,
    // MODD is baked room illumination, not an albedo tint. Only MODR-owned indoor+MOCV doodads
    // carry it; outdoor and unreferenced doodads continue to use Light.dbc unchanged.
    ...(doodad.localLight ? { localLight: doodad.localLight } : {}),
    quaternionX: rotation.x,
    quaternionY: rotation.y,
    quaternionZ: rotation.z,
    quaternionW: rotation.w,
  };
}

function mappedRotation(rotationX, rotationY, rotationZ) {
  const source = new THREE.Matrix4()
    .makeRotationZ(THREE.MathUtils.degToRad(rotationY))
    .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(rotationX)))
    .multiply(new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(rotationZ)));
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().copy(VMAP_TO_THREE).multiply(source).multiply(VMAP_TO_THREE));
}


/** The internal directory name of a map, e.g. 0 -> "Azeroth". */
async function internalMapName(directory, id) {
  const maps = await openDbcFile(directory, "Map");
  const row = maps.rowOf(id);
  return row === undefined ? undefined : maps.string(row, "Directory");
}
