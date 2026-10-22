// 22.10 (7.39): the far view — stretched fog, the outer horizon band, the skyline leash and the
// object-distance step past the stock slider.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  DISTANCE_FOG_FAR_SCALE, DISTANCE_FOG_NEAR_SCALE, DISTANCE_FOG_REACH, DISTANCE_HORIZON_RANGE,
  distanceFogRange, distanceHorizonRange,
} from "../dist/code/browser/DistanceFog.js";
import { HORIZON_RANGE, OUTER, buildHorizonGeometry } from "../dist/code/browser/Horizon.js";
import { HorizonBand, buildHorizonBandGeometry, horizonBandTiles } from "../dist/code/browser/HorizonBand.js";
import { ENVIRONMENT_DETAIL_FAR_MAX, sceneryFarCap } from "../dist/code/browser/SceneryReach.js";
import {
  ENVIRONMENT_FAR_RANGE, ENVIRONMENT_RESIDENT_HYSTERESIS, ENVIRONMENT_SHELL_RANGE, ENVIRONMENT_STREAM_RANGE,
  TERRAIN_GRID_SIZE,
} from "../dist/code/browser/Terrain.js";
import {
  environmentDetailScale, environmentDrawRange, environmentSceneryRange, wmoShellRange,
} from "../dist/code/browser/WorldRenderer3D.js";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `${actual} != ${expected}`);

test("the faithful levels and water keep the zone's own fog", () => {
  for (const quality of [0, 3]) {
    assert.deepEqual(distanceFogRange(125, 500, quality, false, 0), { near: 125, far: 500 }, `quality ${quality}`);
  }
  assert.deepEqual(distanceFogRange(10, 80, 2, true, 0), { near: 10, far: 80 }, "under water: the client's murk");
  assert.deepEqual(distanceFogRange(125, 500, 2, false, 1), { near: 125, far: 500 }, "a full rain veil: authored");
  assert.deepEqual(distanceFogRange(500, 3000, 2, false, 0), { near: 500, far: 3000 }, "already past the reach");
  assert.deepEqual(distanceFogRange(Number.NaN, 500, 2, false, 0), { near: Number.NaN, far: 500 }, "junk passes through");
});

test("the enhanced path stretches the fog toward the horizon, never past it", () => {
  assert.equal(DISTANCE_FOG_NEAR_SCALE, 3);
  assert.equal(DISTANCE_FOG_FAR_SCALE, 5);
  // Elwynn and Westfall at noon, as the bench resolves them (125/500 and 0/444.4).
  assert.deepEqual(distanceFogRange(125, 500, 2, false, 0), { near: 375, far: 2500 });
  const westfall = distanceFogRange(0, 4000 / 9, 1, false, 0);
  near(westfall.far, 20000 / 9);
  assert.equal(westfall.near, 0);
  // A long authored fog is capped at the reach; the start never passes half the end.
  assert.deepEqual(distanceFogRange(900, 1000, 2, false, 0), { near: DISTANCE_FOG_REACH / 2, far: DISTANCE_FOG_REACH });
  // Half a veil: half the stretch.
  const veiled = distanceFogRange(100, 400, 2, false, 0.5);
  near(veiled.far, 400 * (1 + (DISTANCE_FOG_FAR_SCALE - 1) / 2));
  near(veiled.near, 100 * (1 + (DISTANCE_FOG_NEAR_SCALE - 1) / 2));
  // Reused output: no allocation on the per-frame restore.
  const out = { near: 0, far: 0 };
  assert.equal(distanceFogRange(125, 500, 2, false, 0, out), out);
});

test("the fog closes inside the horizon the path draws", () => {
  assert.equal(distanceHorizonRange(0), HORIZON_RANGE, "classic: the client's four tiles");
  assert.equal(distanceHorizonRange(3), HORIZON_RANGE, "comparison level: the same");
  assert.equal(distanceHorizonRange(2), DISTANCE_HORIZON_RANGE);
  assert.equal(DISTANCE_HORIZON_RANGE, 6 * TERRAIN_GRID_SIZE);
  // The band's nearest outer edge is six tiles past the centre tile's edge.
  assert.ok(DISTANCE_FOG_REACH < DISTANCE_HORIZON_RANGE, "a margin of haze before the band runs out");
  assert.ok(DISTANCE_FOG_REACH > HORIZON_RANGE, "and further than the old four-tile horizon");
});

function flatTile(gridX, gridY, height = (row, column) => row * 3 + column) {
  const outer = new Int16Array(17 * 17);
  for (let row = 0; row < 17; row++) for (let column = 0; column < 17; column++) outer[row * 17 + column] = height(row, column);
  return { gridX, gridY, outer, inner: new Int16Array(16 * 16) };
}

test("the outer band holds tiles five and six at half resolution, heights from the full grid", () => {
  const tiles = new Map();
  for (let x = 20; x <= 44; x++) for (let y = 20; y <= 44; y++) tiles.set(x * 64 + y, flatTile(x, y));
  const map = { tiles };
  const band = horizonBandTiles(map, { x: 32, y: 32 }, DISTANCE_HORIZON_RANGE);
  assert.equal(band.length, 13 * 13 - 9 * 9, "the 13×13 square without the four-tile ring's 9×9");
  assert.ok(band.every((tile) => Math.max(Math.abs(tile.gridX - 32), Math.abs(tile.gridY - 32)) > 4));
  const geometry = buildHorizonBandGeometry([band[0]]);
  const position = geometry.getAttribute("position");
  assert.equal(position.count, 9 * 9 + 8 * 8, "a quarter of the ring's 545 vertices a tile");
  assert.equal(geometry.getIndex().count, 8 * 8 * 12);
  // Coarse outer vertex (1, 1) is the full grid's (2, 2); the middle of coarse cell (0, 0) is (1, 1).
  assert.equal(position.getY(1 * 9 + 1), band[0].outer[2 * OUTER + 2]);
  assert.equal(position.getY(81), band[0].outer[1 * OUTER + 1]);
  // Its corners sit exactly where the full-resolution ring puts the same tile's corners.
  const full = buildHorizonGeometry([band[0]]).getAttribute("position");
  for (const [coarse, fine] of [[0, 0], [8, 16], [72, 16 * 17], [80, 16 * 17 + 16]]) {
    assert.equal(position.getX(coarse), full.getX(fine));
    assert.equal(position.getZ(coarse), full.getZ(fine));
  }
});

test("the band is built off the ring's frame, hidden while stale, gone on the faithful levels", () => {
  const tiles = new Map();
  for (let x = 24; x <= 40; x++) for (let y = 24; y <= 40; y++) tiles.set(x * 64 + y, flatTile(x, y));
  const map = { tiles };
  const scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial();
  const band = new HorizonBand();
  const tile = 0 * 4096 + 32 * 64 + 32;
  band.update(scene, map, tile, 1, DISTANCE_HORIZON_RANGE, material);
  const built = band.mesh;
  assert.ok(built && scene.children.includes(built));
  band.update(scene, map, tile, 1, DISTANCE_HORIZON_RANGE, material);
  assert.equal(band.mesh, built, "unchanged: no rebuild");
  band.hideUnless(tile + 1);
  assert.equal(built.visible, false, "the ring moved on: the old band hides");
  band.update(scene, map, tile + 1, 1, DISTANCE_HORIZON_RANGE, material);
  assert.notEqual(band.mesh, built);
  assert.equal(scene.children.includes(built), false);
  band.update(scene, map, tile + 1, 1, HORIZON_RANGE, material);
  assert.equal(band.mesh, undefined, "classic: no band");
  assert.equal(scene.children.length, 0);
});

test("the renderer stretches the fog per frame and builds the band only on unchanged-ring frames", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const restore = source.slice(source.indexOf("  #restoreZoneFog(): void {"));
  const body = restore.slice(0, restore.indexOf("\n  }\n"));
  assert.match(body, /distanceFogRange\(this\.#zoneFogNear, this\.#zoneFogFar, this\.#lightingProfile\.quality,/);
  assert.match(body, /this\.#wmoInteriorFog\.far\.value = range\.far;/, "WMO materials take the same range");
  const horizon = source.slice(source.indexOf("  #updateHorizon(player: WorldPosition"));
  const method = horizon.slice(0, horizon.indexOf("\n  }\n"));
  const unchanged = method.indexOf("if (this.#horizon?.tile === tile && this.#horizon.revision === revision) {");
  const bandUpdate = method.indexOf("this.#horizonBand.update(");
  assert.ok(unchanged > 0 && bandUpdate > unchanged && bandUpdate < method.indexOf("return;", unchanged));
  assert.ok(method.indexOf("this.#horizonBand.hideUnless(tile)") > unchanged);
  assert.match(source, /light\.fogFar = distanceFogRange\(/, "the post haze follows the stretched fog");
});

test("big outdoor shells hold the 1,100-yard skyline leash inside the streamed footprint", () => {
  assert.equal(ENVIRONMENT_FAR_RANGE, 750, "trees and transports keep the far tier");
  assert.equal(ENVIRONMENT_SHELL_RANGE, 1100);
  assert.ok(ENVIRONMENT_SHELL_RANGE + ENVIRONMENT_RESIDENT_HYSTERESIS <= ENVIRONMENT_STREAM_RANGE);
  const keep = {
    id: "keep", kind: "wmo", name: "World\\wmo\\keep.wmo", x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
    bounds: { minX: -100, minY: -100, minZ: 0, maxX: 100, maxY: 100, maxZ: 40 },
  };
  assert.equal(environmentDrawRange(keep), 1100);
  const box = (size) => new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(size, size, size));
  assert.equal(wmoShellRange(box(120)), 1100);
  assert.equal(wmoShellRange(box(60)), 250, "small shells stay near");
});

test("objectDistance past the stock 150 % lengthens and uncaps the scenery leash", () => {
  assert.equal(ENVIRONMENT_DETAIL_FAR_MAX, 2);
  assert.equal(environmentDetailScale(2), 2);
  assert.equal(sceneryFarCap(1), 750);
  assert.equal(sceneryFarCap(1.5), 750, "the stock range draws exactly what it did");
  assert.equal(sceneryFarCap(1.75), 875);
  assert.equal(sceneryFarCap(2), 1000);
  const canopy = {
    id: "canopy", kind: "m2", name: "World\\Doodads\\canopy.m2", x: 0, y: 0, z: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1, admissionRadius: 60.1,
  };
  assert.equal(environmentSceneryRange(canopy, 1.5), 750);
  assert.equal(environmentSceneryRange(canopy, 2), 1000);
  assert.ok(1000 + ENVIRONMENT_RESIDENT_HYSTERESIS <= ENVIRONMENT_STREAM_RANGE, "inside the streamed footprint");
  const oak = { ...canopy, id: "oak", name: "World\\Trees\\Oak01.m2", admissionRadius: undefined };
  delete oak.admissionRadius;
  assert.equal(environmentDrawRange(oak, 2), 1000, "the legacy tree leash takes the same cap");
});
