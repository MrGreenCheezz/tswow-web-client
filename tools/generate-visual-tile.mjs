import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { parseAdtPlacements } from "./adt-placements.mjs";
import { parseWmoDoodads } from "./wmo-visual.mjs";
import { openDbcFile } from "./dbc.mjs";
import { clientArchives } from "./mpq.mjs";
import { clientDirectory, dbcDirectory } from "./paths.mjs";
import { stampGenerated } from "./source-stamp.mjs";

const VMAP_TO_THREE = new THREE.Matrix4().set(
  -1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mapId = Number.parseInt(process.argv[2] ?? "", 10);
const gridX = Number.parseInt(process.argv[3] ?? "", 10);
const gridY = Number.parseInt(process.argv[4] ?? "", 10);
if (![mapId, gridX, gridY].every(Number.isInteger) || mapId < 0 || gridX < 0 || gridX > 63 || gridY < 0 || gridY > 63) {
  throw new Error("Usage: node tools/generate-visual-tile.mjs <map> <grid-x> <grid-y>");
}

const destination = resolve(root, process.env.VISUAL_TILE_DIR ?? "data/visual-tiles", String(mapId), `${gridX}-${gridY}.json`);
const mapName = await internalMapName(dbcDirectory(), mapId);
if (!mapName) throw new Error(`Map.dbc has no map ${mapId}`);

const archives = await clientArchives(clientDirectory());
const adtPath = `World\\Maps\\${mapName}\\${mapName}_${gridY}_${gridX}.adt`;
const adt = await archives.read(adtPath);
if (!adt) throw new Error(`${adtPath} is not in the client`);
const objects = parseAdtPlacements(adt);
const wmoPaths = [...new Set(objects.filter((object) => object.kind === "wmo").map((object) => object.name))];
let doodadCount = 0;
let missingWmos = 0;
if (wmoPaths.length > 0) {
  const roots = new Map();
  for (const path of wmoPaths) {
    const data = await archives.read(path);
    if (data) roots.set(path.toLowerCase(), data);
    else missingWmos++;
  }
  const expanded = [];
  for (let placementIndex = 0; placementIndex < objects.length; placementIndex++) {
    const placement = objects[placementIndex];
    if (placement.kind !== "wmo") continue;
    const wmo = roots.get(placement.name.toLowerCase());
    if (!wmo) continue;
    const doodads = parseWmoDoodads(wmo, placement.doodadSet ?? 0);
    for (let doodadIndex = 0; doodadIndex < doodads.length && objects.length + expanded.length < 10_000; doodadIndex++) {
      expanded.push(worldDoodad(placement, doodads[doodadIndex], doodadIndex));
    }
  }
  doodadCount = expanded.length;
  for (const object of expanded) objects.push(object);
}
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(objects));
// The tile and every building whose furniture was read out of it: a module that changes a WMO's
// doodad set changes this list without touching the ADT.
await stampGenerated(destination, archives, { paths: [adtPath, ...wmoPaths] });
const absent = missingWmos > 0 ? `, ${missingWmos} WMO(s) not in the client` : "";
console.log(`Generated visual tile ${mapId}/${gridX}/${gridY}: ${objects.length} objects (${doodadCount} WMO doodads)${absent}`);
archives.close();

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
