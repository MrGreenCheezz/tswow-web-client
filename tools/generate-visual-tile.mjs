import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { globalMapObjects, parseAdtPlacements, placementReachesCell } from "./adt-placements.mjs";
import { staticM2AdmissionRadius } from "./m2.mjs";
import { parseWmoDoodadSets, validParsedWmoDoodadSets, wmoDependencies } from "./wmo-visual.mjs";
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

function validTile(mapId, gridX, gridY) {
  return [mapId, gridX, gridY].every(Number.isInteger) && mapId >= 0 && gridX >= 0 && gridX <= 63 && gridY >= 0 && gridY <= 63;
}

/**
 * Publishes one tile's placements out of an open chain: the persistent tile worker calls this per
 * job (10.20 slice 2), the command line below once. Output directories are read on every call, so
 * a long-lived worker follows its env and a test's. Leaves the chain open.
 */
export async function publishVisualTile(mapId, gridX, gridY, archives) {
  if (!validTile(mapId, gridX, gridY)) throw new Error(`${mapId}/${gridX}/${gridY} is not a terrain tile`);
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
  if (adt) objects = parseAdtPlacements(adt);
  else {
    // Thirty-nine maps of this client have no ADT at all: the WDT says "one global map object"
    // (MPHD flag 0x1) and names it in its own MWMO/MODF — Wailing Caverns, Blackrock Depths, Molten
    // Core, the Nexus. The records are the ADT's `SMMapObjDef`, so the ADT parser reads them as they
    // are. Each cell the building's box reaches answers the same placement (its furniture is keyed
    // on the placement, so `objectsAround` keeps one copy); the cells it does not reach are empty,
    // not missing. Before this every cell of such a map failed, and the dungeon drew nothing.
    const wdtPath = `World\\Maps\\${mapName}\\${mapName}.wdt`;
    const wdt = await archives.read(wdtPath);
    const global = wdt ? globalMapObjects(wdt) : undefined;
    if (!global) throw new Error(`${adtPath} is not in the client`);
    tileSources.push(wdtPath);
    objects = global.filter((placement) => placementReachesCell(placement, gridX, gridY));
  }
  const wmoPaths = [...new Set(objects.filter((object) => object.kind === "wmo").map((object) => object.name))];
  let doodadCount = 0;
  let missingWmos = 0;
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
      roots.set(path.toLowerCase(), {
        doodadSets: await cachedWmoDoodadSets(data, path, groupPaths, archives, wmoDoodadCacheDirectory),
      });
    }
    const expanded = [];
    for (let placementIndex = 0; placementIndex < objects.length; placementIndex++) {
      const placement = objects[placementIndex];
      if (placement.kind !== "wmo") continue;
      const wmo = roots.get(placement.name.toLowerCase());
      if (!wmo) continue;
      const requestedSet = placement.doodadSet ?? 0;
      const doodads = wmo.doodadSets[requestedSet] ?? wmo.doodadSets[0] ?? [];
      for (let doodadIndex = 0; doodadIndex < doodads.length && objects.length + expanded.length < 10_000; doodadIndex++) {
        expanded.push(worldDoodad(placement, doodads[doodadIndex], doodadIndex));
      }
    }
    doodadCount = expanded.length;
    for (const object of expanded) objects.push(object);
  }

  // Admission runs before a model is requested or built. An unbounded M2 otherwise consumes one
  // of the 320 exterior slots even when it is behind the camera. Read each distinct outdoor model
  // from the same source chain as the tile and publish a conservative origin-centred radius only
  // for static geometry. Rigged and emitter models deliberately retain the old fail-open path.
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
    generation: "visual-tile-v4",
    paths: [...tileSources, ...wmoSourcePaths, ...outdoorM2Paths.values()],
  });
  await writeSourceStamp(destination, stamp);
  // 10.22: the distinct models of the tile, furniture included, for the gateway's preloader — a few
  // KB it can read instead of parsing this file (`tools/tile-models.mjs`). Same stamp: it is a
  // function of the tile. Stamp before bytes, so a torn write never leaves a list served as current.
  const models = tileModelsFile(mapId, gridX, gridY);
  await writeSourceStamp(models, stamp);
  await writeFileAtomic(models, JSON.stringify(tileModelNames(objects)));
  const absent = missingWmos > 0 ? `, ${missingWmos} WMO(s) not in the client` : "";
  console.log(`Generated visual tile ${mapId}/${gridX}/${gridY}: ${objects.length} objects (${doodadCount} WMO doodads)${absent}`);
  return { objects: objects.length, doodads: doodadCount };
}

// Run directly: node tools/generate-visual-tile.mjs <map> <grid-x> <grid-y>
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const mapId = Number.parseInt(process.argv[2] ?? "", 10);
  const gridX = Number.parseInt(process.argv[3] ?? "", 10);
  const gridY = Number.parseInt(process.argv[4] ?? "", 10);
  if (!validTile(mapId, gridX, gridY)) {
    throw new Error("Usage: node tools/generate-visual-tile.mjs <map> <grid-x> <grid-y>");
  }
  const archives = await clientArchives(clientDirectory());
  try {
    await publishVisualTile(mapId, gridX, gridY, archives);
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
async function cachedWmoDoodadSets(rootData, rootPath, groupPaths, archives, wmoDoodadCacheDirectory) {
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

function worldDoodad(placement, doodad, doodadIndex) {
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
    interior: true,
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
