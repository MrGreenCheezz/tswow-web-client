// 22.10 (7.44): the first ring past the near window from the terrain's own heights (HorizonLodRing.ts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  HORIZON_LOD_BUILDS_PER_FRAME, HORIZON_LOD_SKIRT, HORIZON_LOD_SUBDIVISIONS, HorizonLodRing,
  buildHorizonLodGeometry, horizonLodCells, wdlHeightAt,
} from "../dist/code/browser/HorizonLodRing.js";
import { horizonTiles } from "../dist/code/browser/Horizon.js";
import { TERRAIN_GRID_SIZE, TerrainClient } from "../dist/code/browser/Terrain.js";

const T = TERRAIN_GRID_SIZE;
/** A smooth analytic surface: the same function on every tile, so shared edges must agree. */
const surface = (x, y) => 40 + 30 * Math.sin(x / 97) * Math.cos(y / 131);

function flatWorld(cells) {
  const tiles = new Map();
  for (const [gridX, gridY] of cells) {
    const outer = new Int16Array(17 * 17);
    for (let r = 0; r < 17; r++) for (let c = 0; c < 17; c++) outer[r * 17 + c] = 10 + r;
    tiles.set(gridX * 64 + gridY, { gridX, gridY, outer, inner: new Int16Array(16 * 16).fill(10) });
  }
  return { tiles };
}

test("the ring is the sixteen tiles two from the player's, and the WDL ring leaves them out on request", () => {
  const cells = horizonLodCells(49, 31);
  assert.equal(cells.length, 16);
  assert.ok(cells.every(({ x, y }) => Math.max(Math.abs(x - 49), Math.abs(y - 31)) === 2));
  const all = [];
  for (let x = 44; x <= 54; x++) for (let y = 26; y <= 36; y++) all.push([x, y]);
  const world = flatWorld(all);
  assert.equal(horizonTiles(world, { x: 49, y: 31 }).length, 81 - 9, "faithful: everything past the near 3×3");
  assert.equal(horizonTiles(world, { x: 49, y: 31 }, undefined, 2).length, 81 - 25, "enhanced: past the 5×5");
});

test("a tile's mesh follows its heights at 64 cells a side, with a skirt on every edge", () => {
  const geometry = buildHorizonLodGeometry(49, 31, surface, surface);
  const side = HORIZON_LOD_SUBDIVISIONS + 1;
  const position = geometry.getAttribute("position");
  assert.equal(position.count, side * side + 4 * side);
  assert.equal(geometry.index.count, HORIZON_LOD_SUBDIVISIONS ** 2 * 6 + 4 * HORIZON_LOD_SUBDIVISIONS * 12);
  // Vertex (row 10, column 20): scene x = world x, scene z = −world y, height from the sampler.
  const vertex = 10 * side + 20;
  const worldX = (32 - 49 - 10 / 64) * T;
  const worldY = (32 - 31 - 20 / 64) * T;
  assert.ok(Math.abs(position.getX(vertex) - worldX) < 1e-3);
  assert.ok(Math.abs(position.getZ(vertex) + worldY) < 1e-3);
  assert.ok(Math.abs(position.getY(vertex) - surface(worldX, worldY)) < 1e-3);
  // The first skirt vertex hangs below row 0's first vertex.
  assert.ok(Math.abs(position.getY(side * side) - (position.getY(0) - HORIZON_LOD_SKIRT)) < 1e-4);
  // Up-facing normals on this gentle surface; UVs in the colour map's frame (column / 64 of a tile).
  const normal = geometry.getAttribute("normal");
  assert.ok(normal.getY(vertex) > 0.9);
  const uv = geometry.getAttribute("uv");
  assert.ok(Math.abs(uv.getX(vertex) - (31 + 20 / 64) / 64) < 1e-6);
  assert.ok(Math.abs(uv.getY(vertex) - (49 + 10 / 64) / 64) < 1e-6);
  // A height the sampler cannot give means no mesh (the stand-in stays).
  assert.equal(buildHorizonLodGeometry(49, 31, () => undefined, surface), undefined);
});

test("neighbouring tiles agree on their shared edge", () => {
  const side = HORIZON_LOD_SUBDIVISIONS + 1;
  const a = buildHorizonLodGeometry(49, 31, surface, surface).getAttribute("position");
  const b = buildHorizonLodGeometry(49, 32, surface, surface).getAttribute("position");
  // a's last column is b's first column (columns run east with gridY).
  for (let row = 0; row < side; row += 8) {
    const left = row * side + side - 1;
    const right = row * side;
    assert.ok(Math.abs(a.getX(left) - b.getX(right)) < 1e-3);
    assert.ok(Math.abs(a.getZ(left) - b.getZ(right)) < 1e-3);
    assert.ok(Math.abs(a.getY(left) - b.getY(right)) < 1e-2, `row ${row}`);
  }
});

test("the ring stands in with the WDL, then upgrades one terrain tile a frame", () => {
  const all = [];
  for (let x = 44; x <= 54; x++) for (let y = 26; y <= 36; y++) all.push([x, y]);
  const world = flatWorld(all);
  const scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial();
  const ring = new HorizonLodRing();
  let resident = false;
  const terrain = {
    residentHeightAt: (map, x, y) => (resident ? surface(x, y) : undefined),
    ownRevision: () => 3,
  };
  ring.update(scene, 0, 49, 31, world, terrain, material);
  assert.equal(ring.meshes.length, 16, "every tile at once, from the WDL");
  assert.equal(ring.terrainTiles, 0);
  resident = true;
  ring.update(scene, 0, 49, 31, world, terrain, material);
  assert.equal(ring.terrainTiles, HORIZON_LOD_BUILDS_PER_FRAME);
  for (let frame = 0; frame < 20; frame++) ring.update(scene, 0, 49, 31, world, terrain, material);
  assert.equal(ring.terrainTiles, 16);
  assert.equal(scene.children.length, 16);
  // Crossing a tile: the cells that left the ring go; the new ones stand in at once.
  ring.update(scene, 0, 50, 31, world, terrain, material);
  assert.equal(ring.meshes.length, 16);
  ring.clear(scene);
  assert.equal(scene.children.length, 0);
});

test("the WDL height is the outer grid, bilinear", () => {
  const world = flatWorld([[49, 31]]);
  // Row r of the outer grid stands at 10 + r; half a row in, half a step up.
  const x = (32 - 49 - 2.5 / 16) * T;
  const y = (32 - 31 - 0.3) * T;
  assert.ok(Math.abs(wdlHeightAt(world, x, y) - 12.5) < 1e-6);
  assert.equal(wdlHeightAt(world, (32 - 10) * T, y), undefined);
});

test("the terrain probe never starts a download", () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error("no network in tests"); };
  try {
    const client = new TerrainClient("ws://127.0.0.1:1/");
    assert.equal(client.residentHeightAt(0, -9460, 60), undefined);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("the renderer draws the ring on the enhanced path only and keys the WDL ring on its inner reach", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /const enhanced = !lightingClassicLook\(this\.#lightingProfile\.quality\);\n\s*const inner = enhanced \? HORIZON_LOD_REACH : 1;/);
  assert.match(source, /if \(enhanced\) \{\n\s*this\.#horizonLod\.update\([^\n]*\n\s*\} else this\.#horizonLod\.clear\(this\.#scene\);/);
  assert.match(source, /this\.#horizon\.inner === inner\)/);
  assert.match(source, /horizonTiles\(world, centre, undefined, inner\)/);
});
