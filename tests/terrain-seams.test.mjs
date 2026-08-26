import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { TERRAIN_GRID_SIZE, TerrainTile } from "../dist/code/browser/Terrain.js";
import { terrainHeightField, terrainNormals } from "../dist/code/browser/WorldRenderer3D.js";

const SIDE = 129;
const SKIRT = SIDE + 2;

test("the skirt continues the tile's own slope where the world has nothing to answer with", () => {
  // A field that rises by one yard per vertex along x. Extrapolation is exact on a plane, which is
  // the point: the fallback is not a guess about the neighbour, it is this tile's own gradient.
  const slope = (x) => (32 - x / TERRAIN_GRID_SIZE) * 4;
  const own = { x: 32, y: 32 };
  const inside = (x, y) => {
    // Only inside this tile: everything a neighbour would answer comes back undefined.
    const gridX = Math.floor(32 - x / TERRAIN_GRID_SIZE);
    const gridY = Math.floor(32 - y / TERRAIN_GRID_SIZE);
    return gridX === own.x && gridY === own.y ? slope(x) : undefined;
  };
  const field = terrainHeightField(own, { x: 0, y: 0, z: -999, orientation: 0 }, inside);
  const at = (row, column) => field[(row + 1) * SKIRT + (column + 1)];

  // The player's own height must not appear anywhere in the skirt: that is the defect this fixes.
  assert.ok(![...field].includes(-999), "no sample falls back to the player's height");
  for (const column of [0, 64, 128]) {
    assert.ok(Math.abs(at(-1, column) - (2 * at(0, column) - at(1, column))) < 1e-4);
    assert.ok(Math.abs(at(SIDE, column) - (2 * at(SIDE - 1, column) - at(SIDE - 2, column))) < 1e-4);
  }
  // The corners are never sampled and never read; they stay at the zero the buffer was born with.
  assert.equal(at(-1, -1), 0);
  assert.equal(at(SIDE, SIDE), 0);
});

test("a missing neighbour is asked for four times, not eight", () => {
  // `surfaceNormal` reads the four neighbours of a vertex, so sampling the skirt's corners would
  // put four more tiles on the download queue per ring — 25 against 21 — for values nobody reads.
  const asked = new Set();
  const heightAt = (x, y) => {
    asked.add(`${Math.floor(32 - x / TERRAIN_GRID_SIZE)}/${Math.floor(32 - y / TERRAIN_GRID_SIZE)}`);
    return 0;
  };
  terrainHeightField({ x: 32, y: 32 }, { x: 0, y: 0, z: 0, orientation: 0 }, heightAt);
  assert.deepEqual([...asked].sort(), ["31/32", "32/31", "32/32", "32/33", "33/32"]);
});

let mapsDirectory;
try {
  mapsDirectory = (await import("../tools/paths.mjs")).mapsDirectory();
} catch {
  mapsDirectory = undefined;
}
const withMaps = { skip: mapsDirectory ? false : "no extracted maps on this machine" };

/** The tiles either side of a real join: Elwynn's `Azeroth_31_49` and `Azeroth_31_50`. */
const JOIN = { map: 0, own: { x: 49, y: 31 }, neighbour: { x: 50, y: 31 } };

async function loadTile(map, grid) {
  const name = `${String(map).padStart(3, "0")}${String(grid.x).padStart(2, "0")}${String(grid.y).padStart(2, "0")}.map`;
  const file = await readFile(`${mapsDirectory}/${name}`);
  return new TerrainTile(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
}

function angleBetween(left, right, index) {
  const dot = left[index * 3] * right[index * 3] + left[index * 3 + 1] * right[index * 3 + 1] + left[index * 3 + 2] * right[index * 3 + 2];
  return Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
}

test("a tile built without its neighbour is within degrees of the truth, not tens of degrees", withMaps, async () => {
  const own = await loadTile(JOIN.map, JOIN.own);
  const neighbour = await loadTile(JOIN.map, JOIN.neighbour);
  const gridOf = (x, y) => ({ x: Math.floor(32 - x / TERRAIN_GRID_SIZE), y: Math.floor(32 - y / TERRAIN_GRID_SIZE) });
  const both = (x, y) => {
    const grid = gridOf(x, y);
    if (grid.x === JOIN.own.x && grid.y === JOIN.own.y) return own.heightAt(x, y);
    if (grid.x === JOIN.neighbour.x && grid.y === JOIN.neighbour.y) return neighbour.heightAt(x, y);
    return undefined;
  };
  const alone = (x, y) => {
    const grid = gridOf(x, y);
    return grid.x === JOIN.own.x && grid.y === JOIN.own.y ? own.heightAt(x, y) : undefined;
  };
  const player = { x: 0, y: 0, z: 0, orientation: 0 };

  const truth = terrainNormals(terrainHeightField(JOIN.own, player, both));
  const withoutNeighbour = terrainNormals(terrainHeightField(JOIN.own, player, alone));
  // The far edge in x is the one that borders tile 50: row 128 of the mesh.
  const errors = [];
  for (let column = 0; column < SIDE; column++) errors.push(angleBetween(truth, withoutNeighbour, 128 * SIDE + column));
  const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  const worst = Math.max(...errors);
  // Falling back to the player's height measured 65.0 degrees mean and 98.3 worst on this join.
  assert.ok(mean < 5, `mean edge error ${mean.toFixed(2)} degrees`);
  assert.ok(worst < 50, `worst edge error ${worst.toFixed(2)} degrees`);

  // And with the neighbour present the two sides of the join agree, which is what the skirt is for.
  const other = terrainNormals(terrainHeightField(JOIN.neighbour, player, both));
  const across = [];
  for (let column = 0; column < SIDE; column++) {
    // Row 128 of this tile and row 0 of the next are the same line of ground: `worldX` counts
    // rows away from the tile's own origin, so the last row of 49 is the first row of 50.
    const dot = [0, 1, 2].reduce((sum, axis) =>
      sum + truth[(128 * SIDE + column) * 3 + axis] * other[column * 3 + axis], 0);
    across.push(Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI);
  }
  const acrossMean = across.reduce((sum, value) => sum + value, 0) / across.length;
  assert.ok(acrossMean < 1, `the join agrees to ${acrossMean.toFixed(3)} degrees`);
});

test("the sentinel is the mask, and the ground test was throwing shorelines away", withMaps, async () => {
  // Elwynn's lake tile. The extractor writes -500 over every cell of a water body's bounding
  // rectangle that has no water in it, so the cells that are left are the water — and comparing
  // that surface against the ground sample at the middle of the cell, which is what the renderer
  // used to do, discards the shallow edge of every stream and lake.
  const tile = await loadTile(0, { x: 49, y: 31 });
  let wet = 0;
  let alsoAboveGround = 0;
  let sentinel = 0;
  for (let row = 0; row < 128; row++) {
    for (let column = 0; column < 128; column++) {
      const x = (32 - 49 - (row + 0.5) / 128) * TERRAIN_GRID_SIZE;
      const y = (32 - 31 - (column + 0.5) / 128) * TERRAIN_GRID_SIZE;
      const liquid = tile.liquidAt(x, y);
      if (!liquid) continue;
      wet++;
      assert.equal(liquid.cells, true, "this tile carries a height per cell");
      if (liquid.height >= tile.heightAt(x, y) + 0.02) alsoAboveGround++;
      if (liquid.height === -500) sentinel++;
    }
  }
  assert.equal(sentinel, 0, "the sentinel never reaches a caller");
  // Measured: 975 cells of water, of which the old rule drew 761 — 21.9% of the lake's edge was
  // dry land as far as the renderer was concerned.
  assert.equal(wet, 975);
  assert.equal(alsoAboveGround, 761);
});
