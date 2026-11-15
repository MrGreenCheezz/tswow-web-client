import assert from "node:assert/strict";
import test from "node:test";
import { TERRAIN_GRID_SIZE } from "../dist/code/browser/Terrain.js";
import {
  CHUNK_SIZE, chunkRectTiles, detailChunkWindow, detailWindowReach, detailWindowTiles, detailWindowYards,
  detailedGroundReach, frustumCornerDistance, wowFrustumCornerDistance, worldChunk,
  TerrainDetailWindowState, TERRAIN_WINDOW_FULL_REACH,
} from "../dist/code/browser/TerrainDetailWindow.js";
import { TerrainStreamingWindow, terrainTileKey } from "../dist/code/browser/TerrainStreaming.js";
import { horizonTiles } from "../dist/code/browser/Horizon.js";
import { HorizonLodRing } from "../dist/code/browser/HorizonLodRing.js";
import { shapedFogEnd } from "../dist/code/browser/DistanceFog.js";
import * as THREE from "three";

function flatWorld(cells) {
  const tiles = new Map();
  for (const [gridX, gridY] of cells) {
    const outer = new Int16Array(17 * 17).fill(10);
    tiles.set(gridX * 64 + gridY, { gridX, gridY, outer, inner: new Int16Array(16 * 16).fill(10) });
  }
  return { tiles };
}

test("the WDL leaves the window to the terrain; the ring's stand-ins cover its far tiles until each is drawn", () => {
  const all = [];
  for (let x = 40; x <= 60; x++) for (let y = 20; y <= 40; y++) all.push([x, y]);
  const world = flatWorld(all);
  const rect = { x0: 46, x1: 53, y0: 27, y1: 34 };
  const wdl = horizonTiles(world, { x: 49, y: 31 }, undefined, 1, rect);
  assert.equal(wdl.length, 81 - 64, "the 9×9 within four tiles, less the window's 8×8 inside it");
  assert.ok(wdl.every(tile => tile.gridX < 46 || tile.gridX > 53 || tile.gridY < 27 || tile.gridY > 34));
  const scene = new THREE.Scene();
  const ring = new HorizonLodRing();
  const material = new THREE.MeshBasicMaterial();
  const far = [];
  for (let x = 46; x <= 53; x++) for (let y = 27; y <= 34; y++) if (Math.abs(x - 49) > 1 || Math.abs(y - 31) > 1) far.push({ x, y });
  const drawn = new Set();
  ring.update(scene, 571, 49, 31, world, undefined, material, far, (x, y) => drawn.has(x * 64 + y), false);
  assert.equal(ring.tileCount, far.length, "every far tile has a stand-in while none is drawn");
  assert.equal(ring.meshes.filter(mesh => mesh.visible).length, far.length);
  drawn.add(53 * 64 + 34);
  ring.update(scene, 571, 49, 31, world, undefined, material, far, (x, y) => drawn.has(x * 64 + y), false);
  assert.equal(ring.meshes.filter(mesh => mesh.visible).length, far.length - 1, "the drawn tile's stand-in hides");
  drawn.clear();
  ring.update(scene, 571, 49, 31, world, undefined, material, far, (x, y) => drawn.has(x * 64 + y), false);
  assert.equal(ring.meshes.filter(mesh => mesh.visible).length, far.length, "and shows again when the tile goes");
  // Without cells the ring is the old sixteen.
  ring.update(scene, 571, 49, 31, world, undefined, material);
  assert.equal(ring.tileCount, 16);
});

test("the shaped fog closes inside the drawn ground: the horizon's reach, or the drawn window's without a WDL", () => {
  assert.equal(shapedFogEnd(true), 1277);
  assert.equal(shapedFogEnd(false), Math.floor(TERRAIN_GRID_SIZE * 0.9), "the near ring alone, as before");
  assert.equal(shapedFogEnd(false, 1000), 900);
  assert.equal(shapedFogEnd(false, 4 * TERRAIN_GRID_SIZE), 1277);
});

const FAR = 1277;

test("the window's size follows the frustum corner at the stand's far clip (Wow.exe 0x00780860)", () => {
  // The stand's projection (VS c2-c5 of fog6-n-borean): x 1.10397, y 1.96261 -> tan(v/2) 0.5095, tan(h/2) 0.9058.
  const corner = frustumCornerDistance(FAR, 2 * Math.atan(1 / 1.96261), 1.96261 / 1.10397);
  assert.ok(Math.abs(corner - 1841.7) < 1, `corner ${corner}`);
  assert.ok(Math.abs(wowFrustumCornerDistance(FAR) - corner) < 1, "fov 90° x 0.6 at 16:9 is the stand's projection");
  assert.equal(detailWindowYards(FAR, corner), corner);
  assert.equal(detailWindowReach(corner), 56);
  // Under the far clip the window is 1.25 far clips; past twice it, twice it.
  assert.equal(detailWindowYards(1000, 900), 1250);
  assert.equal(detailWindowYards(1000, 2600), 2000);
  // ftol truncates: 0.03 x 1250 = 37.5 -> 37, n = 38.
  assert.equal(detailWindowReach(1250), 38);
});

test("the camera's chunk rounds like the x87 store, and a chunk is a sixteenth of a tile", () => {
  assert.equal(CHUNK_SIZE * 16, TERRAIN_GRID_SIZE);
  assert.equal(worldChunk(17066.666 - 33.3333 * 10.25), 10);
  assert.equal(worldChunk(17066.666 - 33.3333 * 10.75), 10);
  assert.equal(worldChunk(17066.666 - 33.3333 * 11.25), 11);
  assert.equal(worldChunk(0), 511);
});

// What Wow.exe drew (F:\WowOracle\runs\fog6-n-*.tsv, chunk origins from each terrain draw's VS constant 23,
// .runtime/re-2026-11-15/farland12/chunks.mjs): the chunk offsets from the camera's chunk, x and y ranges. A pair draw
// covers its origin chunk and the next one, so one chunk is added at the high side.
const STAND = [
  { name: "borean", x: 2238, y: 5143, dx: [-48, -2], dy: [-38, 10] },
  { name: "icecrown", x: 6224, y: -40, dx: [-1, 39], dy: [-54, 2] },
  { name: "stormpeaks", x: 6127, y: -1027, dx: [-33, -4], dy: [-23, 25] },
  { name: "dalaran-air", x: 5804, y: 624, dx: [17, 36], dy: [-38, 24] },
  { name: "dragonblight", x: 3712, y: -700, dx: [-39, 5], dy: [-37, -2] },
];

test("every terrain chunk the stand's frames drew lies inside the outer window; a far-clip-only window misses some", () => {
  const corner = wowFrustumCornerDistance(FAR);
  let missedByFarClipOnly = 0;
  for (const frame of STAND) {
    const window = detailChunkWindow(frame.x, frame.y, FAR, corner);
    const { outer } = window;
    assert.ok(outer.x0 <= window.cameraX + frame.dx[0] && window.cameraX + frame.dx[1] + 1 <= outer.x1, frame.name);
    assert.ok(outer.y0 <= window.cameraY + frame.dy[0] && window.cameraY + frame.dy[1] + 1 <= outer.y1, frame.name);
    // far8's first reading (n from the far clip alone): ±41.
    const narrow = detailChunkWindow(frame.x, frame.y, FAR, FAR / 1.25 - 1).outer; // corner under the far clip: 1.25 x
    const tight = { x0: window.cameraX - 41, x1: window.cameraX + 41, y0: window.cameraY - 41, y1: window.cameraY + 41 };
    if (window.cameraY + frame.dy[0] < tight.y0 || window.cameraX + frame.dx[0] < tight.x0) missedByFarClipOnly++;
    assert.ok(narrow.y1 - narrow.y0 < outer.y1 - outer.y0);
  }
  assert.ok(missedByFarClipOnly >= 2, "Borean (-48) and Icecrown (-54) reach past 41 chunks");
});

test("inner and outer windows are even-aligned, two chunks apart, and held inside the map", () => {
  const corner = wowFrustumCornerDistance(FAR);
  const window = detailChunkWindow(2238, 5143, FAR, corner);
  assert.equal(window.reach, 56);
  assert.equal(window.inner.x0 % 2, 0);
  assert.equal(window.inner.x1 % 2, 1);
  assert.equal(window.outer.x0, window.inner.x0 - 2);
  assert.equal(window.outer.y1, window.inner.y1 + 2);
  const corner0 = detailChunkWindow(17000, 17000, FAR, corner);
  assert.equal(corner0.outer.x0, 0);
  assert.equal(corner0.outer.y0, 0);
  const corner1 = detailChunkWindow(-17000, -17000, FAR, corner);
  assert.equal(corner1.outer.x1, 1023);
  assert.equal(corner1.outer.y1, 1023);
});

test("a very short far clip is widened to eight chunks past the camera on the second axis", () => {
  // far clip 50: window 62.5 yd -> n = 2; outer y max - camera chunk = 2..5 < 8.
  const window = detailChunkWindow(0, 0, 50, 40);
  assert.equal(window.reach, 2);
  assert.ok(window.outer.y1 - window.cameraY >= 8, JSON.stringify(window));
  assert.ok(window.outer.y1 - window.inner.y1 > 2, "the outer window grew");
  assert.equal(window.inner.y1 - window.cameraY <= 3, true, "the inner window did not");
});

test("the window's tiles: up to 8 a side at the stand's far clip, the camera's tile inside", () => {
  const corner = wowFrustumCornerDistance(FAR);
  for (const frame of STAND) {
    const tiles = detailWindowTiles(frame.x, frame.y, FAR, corner);
    const gx = Math.floor(32 - frame.x / TERRAIN_GRID_SIZE), gy = Math.floor(32 - frame.y / TERRAIN_GRID_SIZE);
    assert.ok(tiles.x0 <= gx - 3 && gx + 3 <= tiles.x1, frame.name);
    assert.ok(tiles.y0 <= gy - 3 && gy + 3 <= tiles.y1, frame.name);
    assert.ok(tiles.x1 - tiles.x0 + 1 <= 9 && tiles.y1 - tiles.y0 + 1 <= 9, frame.name);
  }
  assert.deepEqual(chunkRectTiles({ x0: 15, x1: 16, y0: 31, y1: 32 }), { x0: 0, x1: 1, y0: 1, y1: 2 });
});

test("the drawn ground's reach grows ring by ring while the rings are drawn", () => {
  const x = (32 - 30.5) * TERRAIN_GRID_SIZE, y = (32 - 30.5) * TERRAIN_GRID_SIZE;
  const rect = { x0: 27, x1: 34, y0: 27, y1: 34 };
  assert.equal(detailedGroundReach(x, y, rect, () => false), TERRAIN_GRID_SIZE / 2);
  assert.equal(detailedGroundReach(x, y, rect, () => true), 3.5 * TERRAIN_GRID_SIZE);
  // One undrawn tile in the third ring holds the reach at the second.
  assert.equal(detailedGroundReach(x, y, rect, (gx, gy) => !(gx === 33 && gy === 30)), 2.5 * TERRAIN_GRID_SIZE);
});

test("past the full-detail reach the window's tiles go to the mid-detail ring; cells without ground are not asked", () => {
  const position = (grid) => (32 - grid - 0.5) * TERRAIN_GRID_SIZE;
  const rect = { x0: 27, x1: 34, y0: 26, y1: 33 };
  const plan = new TerrainStreamingWindow().update(571, position(30), position(30), true, rect, 1);
  assert.equal(plan.far.length, 0, "only the near 3×3 is built");
  assert.equal(plan.lod.length, 64 - 9);
  assert.deepEqual(plan.standIns, plan.lod);
  const dependencies = new Set(plan.dependencies.map(grid => terrainTileKey(571, grid)));
  assert.ok(plan.lod.every(grid => dependencies.has(terrainTileKey(571, grid))), "their own heights are pinned");
  assert.equal(plan.retained.length, 9, "nothing past the 3×3 holds a mesh");
  const mixed = new TerrainStreamingWindow().update(571, position(30), position(30), true, rect, 2);
  assert.equal(mixed.far.length, 16);
  assert.equal(mixed.lod.length, 64 - 25);
  // A WDL with no tile at x 34 (the sea): those cells are neither built nor asked for.
  const sea = new TerrainStreamingWindow().update(571, position(30), position(30), true, rect, 64, (x) => x !== 34);
  assert.equal(sea.far.length, 64 - 9 - 8);
  assert.ok(!sea.dependencies.some(grid => grid.x === 34 || grid.x === 35), "nor their neighbours past them");
});

test("the renderer's window state keeps its rectangle while the camera stays in its chunk", () => {
  const state = new TerrainDetailWindowState();
  const a = state.tiles(2238, 5143, 52, 16 / 9);
  assert.equal(state.tiles(2238 + 5, 5143 - 5, 52, 16 / 9), a);
  assert.equal(state.drawnRect, a);
  state.drawn = false;
  assert.equal(state.drawnRect, undefined);
  assert.equal(state.tiles(Number.NaN, 0, 52, 16 / 9), undefined);
  assert.ok(TERRAIN_WINDOW_FULL_REACH >= 1);
});

test("the streaming plan builds the window's far tiles cooperatively and pins their neighbours", () => {
  const position = (grid) => (32 - grid - 0.5) * TERRAIN_GRID_SIZE;
  const near = new TerrainStreamingWindow().update(571, position(30), position(30));
  assert.equal(near.far.length, 0);
  assert.equal(near.farKeys.size, 0);
  const window = new TerrainStreamingWindow();
  const rect = { x0: 27, x1: 34, y0: 26, y1: 33 };
  const plan = window.update(571, position(30), position(30), true, rect);
  assert.equal(plan.visible.length, 9);
  assert.equal(plan.far.length, 8 * 8 - 9);
  assert.ok(plan.far.every(grid => Math.max(Math.abs(grid.x - 30), Math.abs(grid.y - 30)) >= 2));
  // Nearest rings first.
  const rings = plan.far.map(grid => Math.max(Math.abs(grid.x - 30), Math.abs(grid.y - 30)));
  assert.deepEqual(rings, [...rings].sort((a, b) => a - b));
  for (const grid of plan.far) {
    const key = terrainTileKey(571, grid);
    assert.ok(plan.farKeys.has(key));
    assert.ok(plan.prepareTileKeys.includes(key), "built through the cooperative path");
    assert.ok(plan.retainedKeys.has(key), "kept");
  }
  const dependencies = new Set(plan.dependencies.map(grid => terrainTileKey(571, grid)));
  for (let gx = 26; gx <= 35; gx++) for (let gy = 25; gy <= 34; gy++) {
    assert.ok(dependencies.has(terrainTileKey(571, { x: gx, y: gy })), `${gx}/${gy} pinned for the edge normals`);
  }
  assert.equal(window.update(571, position(30) + 1, position(30), true, rect), plan, "same window, same plan");
  assert.notEqual(window.update(571, position(30), position(30), true, { ...rect, x1: 35 }), plan);
  // Dropping the window keeps the near plan's shape.
  const dropped = window.update(571, position(30), position(30), true);
  assert.equal(dropped.far.length, 0);
  assert.equal(dropped.visible.length, 9);
});
