import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  TERRAIN_GRID_SIZE,
  terrainGrid,
  terrainGridFootprint,
  terrainGridFootprintCells,
  terrainGridIndex,
} from "../dist/code/browser/Terrain.js";

// P1-13a (ENV-21): numeric tile identities on the per-frame terrain paths. Each numeric form must
// answer exactly what the object/string form answers.

const MAP_MAX = 32 * TERRAIN_GRID_SIZE;
const MAP_MIN = -MAP_MAX;

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** `terrainGridFootprint` as it stood before P1-13 (2026-10-07), kept verbatim as the reference. */
function oldFootprint(x, y, range) {
  const GRID_CENTER = 32;
  const GRID_COUNT = 64;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(range)) return [];
  const radius = Math.max(0, range);
  const outsideX = Math.max(MAP_MIN - x, 0, x - MAP_MAX);
  const outsideY = Math.max(MAP_MIN - y, 0, y - MAP_MAX);
  if (outsideX * outsideX + outsideY * outsideY > radius * radius) return [];
  const minGridX = Math.max(0, Math.min(GRID_COUNT - 1,
    Math.floor(GRID_CENTER - (x + radius) / TERRAIN_GRID_SIZE) - 1));
  const maxGridX = Math.min(GRID_COUNT - 1, Math.max(0,
    Math.floor(GRID_CENTER - (x - radius) / TERRAIN_GRID_SIZE) + 1));
  const minGridY = Math.max(0, Math.min(GRID_COUNT - 1,
    Math.floor(GRID_CENTER - (y + radius) / TERRAIN_GRID_SIZE) - 1));
  const maxGridY = Math.min(GRID_COUNT - 1, Math.max(0,
    Math.floor(GRID_CENTER - (y - radius) / TERRAIN_GRID_SIZE) + 1));
  const radiusSquared = radius * radius;
  const grids = [];
  for (let gridX = minGridX; gridX <= maxGridX; gridX++) {
    const minX = (GRID_CENTER - gridX - 1) * TERRAIN_GRID_SIZE;
    const maxX = (GRID_CENTER - gridX) * TERRAIN_GRID_SIZE;
    const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
    for (let gridY = minGridY; gridY <= maxGridY; gridY++) {
      const minY = (GRID_CENTER - gridY - 1) * TERRAIN_GRID_SIZE;
      const maxY = (GRID_CENTER - gridY) * TERRAIN_GRID_SIZE;
      const dy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
      if (dx * dx + dy * dy <= radiusSquared) grids.push({ x: gridX, y: gridY });
    }
  }
  return grids;
}

const asIndex = (grid) => (grid === undefined ? -1 : grid.x * 64 + grid.y);

test("P1-13a: terrainGridIndex is terrainGrid as one number, on a lattice and at every edge", () => {
  for (let x = -17_100; x <= 17_100; x += 95) {
    for (let y = -17_100; y <= 17_100; y += 190) {
      assert.equal(terrainGridIndex(x, y), asIndex(terrainGrid(x, y)), `${x}, ${y}`);
    }
  }
  const epsilon = 1e-9;
  const edges = [Number.NaN, Infinity, -Infinity, MAP_MIN, MAP_MAX, MAP_MIN - epsilon, MAP_MAX + epsilon,
    MAP_MIN + epsilon, MAP_MAX - epsilon, 0, -0, TERRAIN_GRID_SIZE, -TERRAIN_GRID_SIZE, 1e300, -1e300,
    Number.MIN_VALUE, -Number.MIN_VALUE];
  for (const x of edges) {
    for (const y of edges) assert.equal(terrainGridIndex(x, y), asIndex(terrainGrid(x, y)), `${x}, ${y}`);
  }
  const next = random(5);
  for (let step = 0; step < 20_000; step++) {
    const x = (next() - 0.5) * 2.2 * MAP_MAX;
    const y = (next() - 0.5) * 2.2 * MAP_MAX;
    assert.equal(terrainGridIndex(x, y), asIndex(terrainGrid(x, y)), `${x}, ${y}`);
  }
});

test("P1-13a: footprint cells and the rebuilt footprint equal the old footprint on 20,000 circles", () => {
  const next = random(13);
  const out = new Int32Array(4096);
  const ranges = [0, 0, 1, 50, 100, 300, 533.3333333333334, 800, 1600, 1e5, 1e9, -5, Infinity, Number.NaN];
  for (let step = 0; step < 20_000; step++) {
    const x = step % 97 === 0 ? [Number.NaN, Infinity, MAP_MAX, MAP_MIN][step % 4] : (next() - 0.5) * 2.4 * MAP_MAX;
    // Some circles centred on tile edges and corners exactly.
    const y = step % 11 === 0 ? Math.round((next() - 0.5) * 64) * TERRAIN_GRID_SIZE : (next() - 0.5) * 2.4 * MAP_MAX;
    const range = step % 3 === 0 ? ranges[step % ranges.length] : next() * 1200;
    const expected = oldFootprint(x, y, range);
    assert.deepEqual(terrainGridFootprint(x, y, range), expected, `${x}, ${y}, ${range}`);
    const count = terrainGridFootprintCells(x, y, range, out);
    assert.deepEqual([...out.subarray(0, count)], expected.map(asIndex), `cells ${x}, ${y}, ${range}`);
  }
  // The whole map in one circle fills the buffer exactly.
  assert.equal(terrainGridFootprintCells(0, 0, 1e9, out), 4096);
});

test("P1-13a: footprint cells come out ascending, so equal sets are equal sequences", () => {
  const next = random(17);
  const out = new Int32Array(4096);
  for (let step = 0; step < 2000; step++) {
    const count = terrainGridFootprintCells((next() - 0.5) * 2 * MAP_MAX, (next() - 0.5) * 2 * MAP_MAX, next() * 2000, out);
    for (let index = 1; index < count; index++) assert.ok(out[index - 1] < out[index]);
  }
});

/** Source text without line comments, which may quote code in backticks. */
const code = (text) => text.replace(/\/\/.*$/gm, "");

test("P1-13a: the per-frame keys compare numbers, not built strings", async () => {
  const terrain = await readFile(new URL("../src/browser/Terrain.ts", import.meta.url), "utf8");
  const aroundStart = terrain.indexOf("  objectsAround(map: number | undefined");
  const around = code(terrain.slice(aroundStart, terrain.indexOf("return this.#objectsCache;", aroundStart)));
  for (const forbidden of ["`", ".sort(", ".join(", ".map("]) {
    assert.ok(!around.includes(forbidden), `objectsAround's hit path has no ${forbidden}`);
  }
  const streaming = await readFile(new URL("../src/browser/TerrainStreaming.ts", import.meta.url), "utf8");
  const updateStart = streaming.indexOf("  update(map: number");
  const update = code(streaming.slice(updateStart, streaming.indexOf("return this.#plan;", updateStart)));
  for (const forbidden of ["`", ".sort(", ".join(", ".map("]) {
    assert.ok(!update.includes(forbidden), `the streaming plan's hit path has no ${forbidden}`);
  }
  const revisionStart = terrain.indexOf("  tileRevision(map: number, grid: TerrainGrid): number {");
  const revision = code(terrain.slice(revisionStart, terrain.indexOf("\n  }\n", revisionStart)));
  assert.ok(!revision.includes("`") && !revision.includes("#tileRevisions"), "tileRevision reads the numeric mirror");
  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  const helperStart = loop.indexOf("function updateTerrainActiveTiles");
  const helper = code(loop.slice(helperStart, loop.indexOf("if (key === lastTerrainFootprintKey) return;", helperStart)));
  assert.ok(!helper.includes("`") && helper.includes("terrainGridIndex("), "the loop's ring key is a number");
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const terrainStart = renderer.indexOf("  #updateTerrain(");
  const updateTerrain = renderer.slice(terrainStart, renderer.indexOf("\n  #cancelTerrainPreparation(", terrainStart));
  assert.ok(!updateTerrain.includes("`${map}/${grid.x}/${grid.y}`"), "P1-13b: the plan's keys, not one string per tile");
  const horizonStart = renderer.indexOf("  #updateHorizon(");
  const horizon = code(renderer.slice(horizonStart, renderer.indexOf("this.#horizon?.tile === tile", horizonStart)));
  assert.ok(!horizon.includes("`"), "P1-13b: the horizon's unchanged test builds no string");
});
