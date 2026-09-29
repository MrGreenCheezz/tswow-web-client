import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { TERRAIN_GRID_SIZE, TerrainTile } from "../dist/code/browser/Terrain.js";
import { HORIZON_RANGE, buildHorizonGeometry, decodeHorizon, horizonTiles } from "../dist/code/browser/Horizon.js";

let directories;
try {
  const paths = await import("../tools/paths.mjs");
  directories = { maps: paths.mapsDirectory(), client: paths.clientDirectory() };
} catch {
  directories = undefined;
}

// Where `tools/generate-horizon.mjs` puts what it pulls out of the archives, which is also where
// the gateway serves it from.
const HORIZON_DIR = process.env.HORIZON_DIR ?? "data/horizon";
let azeroth;
try {
  const file = await readFile(`${HORIZON_DIR}/0.wdl`);
  azeroth = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
} catch {
  azeroth = undefined;
}
const withHorizon = { skip: azeroth && directories ? false : "no extracted horizon on this machine" };

test("the horizon reads as the tiles the server itself has, and nothing else", withHorizon, async () => {
  const world = decodeHorizon(azeroth);
  // Every tile the map has and no tile it does not: the `.wdl` table and the extracted `.map`
  // files are the same set, which is what makes this usable as a horizon rather than a guess.
  const served = new Set();
  for (const name of await readdir(directories.maps)) {
    const match = /^(\d{3})(\d{2})(\d{2})\.map$/.exec(name);
    if (match && Number(match[1]) === 0) served.add(`${Number(match[2])}/${Number(match[3])}`);
  }
  const listed = new Set([...world.tiles.values()].map((tile) => `${tile.gridX}/${tile.gridY}`));
  assert.equal(listed.size, 687, "Azeroth is 687 tiles");
  assert.deepEqual([...listed].sort().filter((key) => !served.has(key)), [], "no tile the server does not have");
  assert.deepEqual([...served].sort().filter((key) => !listed.has(key)), [], "and none of the server's missing");
});

test("a horizon vertex is the server's own ground, rounded to the yard", withHorizon, async () => {
  // This is the test that catches the orientation trap: read row-major with the rows running the
  // other way and the mesh still looks like a continent, but every vertex is tens of yards out.
  const world = decodeHorizon(azeroth);
  const errors = [];
  const transposed = [];
  for (const [gridX, gridY] of [[49, 31], [48, 31], [50, 31], [34, 36], [44, 30]]) {
    const tile = world.tiles.get(gridX * 64 + gridY);
    assert.ok(tile, `map 0 has tile ${gridX}/${gridY}`);
    const name = `000${String(gridX).padStart(2, "0")}${String(gridY).padStart(2, "0")}.map`;
    const file = await readFile(`${directories.maps}/${name}`);
    const ground = new TerrainTile(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    for (let row = 0; row < 17; row++) {
      for (let column = 0; column < 17; column++) {
        const x = (32 - gridX - row / 16) * TERRAIN_GRID_SIZE;
        const y = (32 - gridY - column / 16) * TERRAIN_GRID_SIZE;
        // The far edges belong to the next tile; the sampler would read across the join.
        const inside = ground.heightAt(row === 16 ? x + 0.05 : x, column === 16 ? y + 0.05 : y);
        // The extractor clamps anything below -500 to exactly -500, so deep ocean is not a
        // disagreement between the two files, it is the same floor written twice.
        if (inside <= -499) continue;
        errors.push(Math.abs(tile.outer[row * 17 + column] - inside));
        transposed.push(Math.abs(tile.outer[column * 17 + row] - inside));
      }
    }
  }
  errors.sort((left, right) => left - right);
  const median = errors[errors.length >> 1];
  const worst = errors.at(-1);
  // Measured over these five tiles: median 0.25, worst 1.04. A vertex is the same height field
  // rounded to whole yards, so about half a yard is the floor and a yard is the ceiling.
  assert.ok(median <= 0.55, `median error ${median.toFixed(3)} yards`);
  assert.ok(worst <= 1.1, `worst error ${worst.toFixed(3)} yards`);
  const transposedMean = transposed.reduce((sum, value) => sum + value, 0) / transposed.length;
  assert.ok(transposedMean > 20, `the transposed reading is ${transposedMean.toFixed(1)} yards out, so the test can tell`);
});

test("the horizon draws around the ring, never under it", withHorizon, () => {
  const world = decodeHorizon(azeroth);
  const centre = { x: 49, y: 31 };
  const tiles = horizonTiles(world, centre);
  for (const tile of tiles) {
    const near = Math.abs(tile.gridX - centre.x) <= 1 && Math.abs(tile.gridY - centre.y) <= 1;
    assert.equal(near, false, `tile ${tile.gridX}/${tile.gridY} is inside the loaded ring`);
  }
  // Four tiles out covers the ninety-ninth percentile of the client's own fog distances.
  assert.equal(HORIZON_RANGE, 4 * TERRAIN_GRID_SIZE);
  assert.ok(tiles.length >= 20 && tiles.length <= 80, `${tiles.length} tiles around Elwynn`);

  const geometry = buildHorizonGeometry(tiles);
  const positions = geometry.getAttribute("position");
  assert.equal(positions.count, tiles.length * (17 * 17 + 16 * 16));
  assert.equal(geometry.getIndex().count, tiles.length * 16 * 16 * 12, "four triangles a cell");
  assert.ok(geometry.getIndex().array instanceof Uint16Array,
    "the production horizon ring uses half-width GPU indices");
  assert.equal(geometry.getAttribute("normal"), undefined,
    "the unlit horizon does not rebuild unused normals at every tile crossing");

  // A vertex of the first tile lands where that tile stands in the world, in scene coordinates.
  const first = tiles[0];
  const x = positions.getX(0);
  const z = positions.getZ(0);
  assert.ok(Math.abs(x - (32 - first.gridX) * TERRAIN_GRID_SIZE) < 1e-3);
  assert.ok(Math.abs(z + (32 - first.gridY) * TERRAIN_GRID_SIZE) < 1e-3);
});

test("an unusually large horizon still uses indices wide enough for every vertex", () => {
  const tile = { gridX: 32, gridY: 32, outer: new Int16Array(17 * 17), inner: new Int16Array(16 * 16) };
  const geometry = buildHorizonGeometry(Array(121).fill(tile));
  assert.ok(geometry.getIndex().array instanceof Uint32Array);
  assert.ok(geometry.getIndex().array.at(-1) >= 120 * (17 * 17 + 16 * 16));
  geometry.dispose();
});

test("a horizon file with an empty table is a map with no horizon, not an error", () => {
  // 40 of the client's 106 `.wdl` files are exactly this: a header and 4,096 zeroes.
  const data = new ArrayBuffer(8 + 4 + 8 + 4096 * 4);
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  const tag = (offset, value) => [...value].reverse().forEach((letter, index) => { bytes[offset + index] = letter.charCodeAt(0); });
  tag(0, "MVER");
  view.setUint32(4, 4, true);
  view.setUint32(8, 18, true);
  tag(12, "MAOF");
  view.setUint32(16, 4096 * 4, true);
  assert.deepEqual(decodeHorizon(data).tiles.size, 0);
  assert.throws(() => decodeHorizon(new ArrayBuffer(16)), /no tile table/);
});
