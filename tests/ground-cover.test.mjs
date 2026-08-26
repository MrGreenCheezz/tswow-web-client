import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import * as THREE from "three";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import {
  DETAIL_CELL_SIZE, GROUND_COVER_BUDGET, GROUND_COVER_MARGIN, GROUND_COVER_MAX_RADIUS,
  GROUND_COVER_SIZE, GroundCoverClient, decodeGroundCover, scatterGroundCover,
} from "../dist/code/browser/GroundCover.js";
import { coerceSetting, defaultSettings, settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { RESELECT_DISTANCE } from "../dist/code/browser/RenderStats.js";
import { TerrainTile, TERRAIN_GRID_SIZE, terrainGrid } from "../dist/code/browser/Terrain.js";
import { ADT_MODEL_TO_SCENE, groundCoverMatrix } from "../dist/code/browser/WorldRenderer3D.js";
import { GROUND_COVER_STRIDE, encodeGroundCover } from "../tools/ground-cover.mjs";
import { repositoryRoot } from "../tools/paths.mjs";

let directories;
try {
  const paths = await import("../tools/paths.mjs");
  directories = { maps: paths.mapsDirectory(), client: paths.clientDirectory(), dbc: paths.dbcDirectory() };
} catch {
  directories = undefined;
}
const withDataset = { skip: directories ? false : "no client and dataset on this machine" };
const encoder = new TextEncoder();

/** One chunk of a synthetic tile: four layer effects, the winner map and the no-doodad mask. */
function chunk({ row, column, effects = [], winner = () => 0, masked = () => false }) {
  const detail = { winner: [], noDoodad: [] };
  for (let cellRow = 0; cellRow < 8; cellRow++) {
    let word = 0;
    let mask = 0;
    for (let cellColumn = 0; cellColumn < 8; cellColumn++) {
      word |= (winner(cellRow, cellColumn) & 3) << (cellColumn * 2);
      if (masked(cellRow, cellColumn)) mask |= 1 << cellColumn;
    }
    detail.winner.push(word);
    detail.noDoodad.push(mask);
  }
  return { row, column, layers: effects.map((effectId) => ({ effectId })), detail };
}

/** The recipe as the browser sees it, through the generator's own encoder. */
function recipeOf(chunks) {
  const buffer = encodeGroundCover(chunks);
  return decodeGroundCover(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

/** A table with one growing effect: `density` doodads of one model per cell. */
function oneEffect(density, models = ["World\\NoDXT\\Detail\\ElwGra01.m2"], weights = [1]) {
  return {
    models,
    effects: { 7: { density, terrain: 2, doodads: models.map((_, index) => [index, weights[index] ?? 1]) } },
  };
}

/** Tile 32/32 is the tile whose corner is the world origin, which keeps the arithmetic readable. */
const TILE_X = 32;
const TILE_Y = 32;
const flat = () => 0;

test("a tile's recipe is 10,248 bytes and every chunk lands at IndexY * 16 + IndexX", () => {
  // The record order is the one the splat family's `index.png` already uses: the row is MCNK
  // `IndexY`, running south, and the column is `IndexX`, running east. Writing them the other way
  // round transposes the whole tile about its diagonal — the defect the terrain splat had, caught
  // there against Blizzard's own minimap bake.
  const chunks = [];
  for (let row = 0; row < 16; row++) {
    for (let column = 0; column < 16; column++) {
      chunks.push(chunk({ row, column, effects: [1000 + row * 16 + column] }));
    }
  }
  const buffer = encodeGroundCover(chunks);
  assert.equal(buffer.byteLength, GROUND_COVER_SIZE);
  assert.equal(buffer.byteLength, 10_248);
  assert.equal(buffer.subarray(0, 4).toString("latin1"), "WGC1");
  assert.equal(buffer.readUInt8(4), 1);
  assert.equal(buffer.readUInt8(5), GROUND_COVER_STRIDE);
  assert.equal(buffer.readUInt16LE(6), 256);

  const recipe = decodeGroundCover(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  for (let row = 0; row < 16; row++) {
    for (let column = 0; column < 16; column++) {
      assert.equal(recipe.effects[(row * 16 + column) * 4], 1000 + row * 16 + column, `chunk ${column}/${row}`);
    }
  }
  // A chunk the ADT does not carry is forty zero bytes, which reads as "no layers, nothing grows".
  const sparse = encodeGroundCover([chunk({ row: 3, column: 5, effects: [7] })]);
  assert.equal(sparse.byteLength, GROUND_COVER_SIZE);
  assert.equal(sparse.readUInt32LE(8 + (3 * 16 + 5) * GROUND_COVER_STRIDE), 7);
  assert.equal(sparse.readUInt32LE(8), 0);
});

test("the winner map is two bits per column and the mask one bit, both counted from the low end", () => {
  // Measured on Azeroth_31_49 rather than taken from documentation. The winner map read straight
  // agrees with the layer the alpha maps make dominant on 86.8% of its 16,384 cells and its
  // transpose on 51.1%. The mask read with bit `column` puts 642 of the tile's 1,119 masked cells
  // on `ElwynnCobbleStoneBase.blp` against 5 of the 15,265 unmasked — it is the road; read with
  // the bits reversed it is 313 against 334, which is no road at all.
  const recipe = recipeOf([chunk({
    row: 0, column: 0, effects: [1, 2, 3, 4],
    winner: (row, column) => (row + column) % 4,
    masked: (row, column) => row === 2 && column === 5,
  })]);
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      assert.equal((recipe.winner[row] >> (column * 2)) & 3, (row + column) % 4, `winner ${row}/${column}`);
      assert.equal((recipe.noDoodad[row] >> column) & 1, row === 2 && column === 5 ? 1 : 0, `mask ${row}/${column}`);
    }
  }
});

test("a file that is not this layout is refused rather than read as one", () => {
  const good = encodeGroundCover([chunk({ row: 0, column: 0, effects: [7] })]);
  const bytes = () => Buffer.from(good);
  const decode = (buffer) => decodeGroundCover(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const wrongMagic = bytes();
  wrongMagic.write("WGC2", 0, "latin1");
  assert.throws(() => decode(wrongMagic), /magic/);
  const wrongVersion = bytes();
  wrongVersion.writeUInt8(2, 4);
  assert.throws(() => decode(wrongVersion), /version/);
  const wrongStride = bytes();
  wrongStride.writeUInt8(44, 5);
  assert.throws(() => decode(wrongStride), /layout/);
  assert.throws(() => decode(bytes().subarray(0, 1000)), /bytes/);
});

test("the ground-effect client rejects null and malformed effects records", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const payload of [
      { models: [], effects: null },
      { models: [], effects: [] },
      { models: [], effects: { 7: null } },
      { models: [], effects: { 7: { density: 1, terrain: 2, doodads: [[0]] } } },
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), {
        status: 200, headers: { "content-type": "application/json" },
      });
      const client = new GroundCoverClient("ws://localhost:1234/world");
      const statuses = [];
      client.onStatus = (message, error) => statuses.push({ message, error });
      assert.equal(client.table(), undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(client.table(), undefined);
      assert.equal(statuses.length, 1);
      assert.equal(statuses[0].error, true);
      assert.match(statuses[0].message, /invalid table/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a growing cell gets exactly its effect's density, and a masked one gets nothing", () => {
  // Half the cells of one chunk masked, so the count is the arithmetic and not an accident of
  // where the window happened to fall.
  const recipe = recipeOf([chunk({
    row: 0, column: 0, effects: [7],
    masked: (row) => row >= 4,
  })]);
  const field = scatterGroundCover({
    recipe: (grid) => (grid.x === TILE_X && grid.y === TILE_Y ? recipe : undefined),
    table: oneEffect(3),
    // The chunk's own centre, with a radius that reaches every one of its cells and no other
    // chunk's: a chunk is 33.33 yards across, so 24 covers its corners and stops short of 33.33.
    centre: { x: -16.666_666, y: -16.666_666 },
    radius: 24,
    perCell: true,
    heightAt: flat,
  });
  // 32 unmasked cells of 3 each, minus the corners the circle does not reach.
  let cells = 0;
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 8; column++) {
      const x = -row * DETAIL_CELL_SIZE;
      const y = -column * DETAIL_CELL_SIZE;
      const outsideX = Math.max(x - DETAIL_CELL_SIZE + 16.666_666, 0, -16.666_666 - x);
      const outsideY = Math.max(y - DETAIL_CELL_SIZE + 16.666_666, 0, -16.666_666 - y);
      if (Math.hypot(outsideX, outsideY) <= 24) cells++;
    }
  }
  assert.equal(cells, 32, "every unmasked cell of the chunk is inside the window");
  assert.equal(field.total, 32 * 3);
  // Nothing at all on the masked half: the mask is the road, and a road that sprouts grass is the
  // whole reason this is authored data rather than something derived from the alpha maps.
  for (const batch of field.models.values()) {
    for (const x of batch.x) assert.ok(x > -4 * DETAIL_CELL_SIZE, `a doodad at x=${x} is on a masked cell`);
  }
});

test("the cell's own layer decides what grows there, not the chunk's first", () => {
  // Four layers with four different effects, and the two-bit map naming the third on one cell.
  const recipe = recipeOf([chunk({
    row: 0, column: 0, effects: [7, 8, 9, 10],
    winner: (row, column) => (row === 1 && column === 1 ? 2 : 0),
  })]);
  const table = {
    models: ["A.m2", "B.m2"],
    effects: {
      7: { density: 1, terrain: 0, doodads: [[0, 1]] },
      9: { density: 1, terrain: 0, doodads: [[1, 1]] },
    },
  };
  const field = scatterGroundCover({
    recipe: () => recipe,
    table,
    centre: { x: -DETAIL_CELL_SIZE * 1.5, y: -DETAIL_CELL_SIZE * 1.5 },
    radius: 12,
    perCell: true,
    heightAt: flat,
  });
  const layer2 = field.models.get("B.m2");
  assert.equal(layer2?.x.length, 1, "one cell names layer 2, and it grows layer 2's effect");
  assert.ok(layer2.x[0] <= -DETAIL_CELL_SIZE && layer2.x[0] >= -2 * DETAIL_CELL_SIZE, `x ${layer2.x[0]}`);
  assert.ok(layer2.y[0] <= -DETAIL_CELL_SIZE && layer2.y[0] >= -2 * DETAIL_CELL_SIZE, `y ${layer2.y[0]}`);
  // Every other cell in the window names layer 0, whose effect is 7 and whose model is A.
  assert.equal(field.models.get("A.m2")?.x.length, field.total - 1);
});

test("weights are shares among the slots that name a model, and an empty slot's weight is not one", () => {
  // 36 weights in this dataset sit on a slot whose doodad id is zero. Counting them in the total
  // would drop that share of every roll into a hole — the model would simply never be reached and
  // the last one in the list would take its place.
  const recipe = recipeOf([chunk({ row: 0, column: 0, effects: [7] })]);
  const field = scatterGroundCover({
    recipe: () => recipe,
    table: {
      models: ["A.m2", "B.m2"],
      // Slot 3 carries a weight of 96 and no model, which is what the gateway drops on the way out.
      effects: { 7: { density: 8, terrain: 0, doodads: [[0, 1], [1, 3]] } },
    },
    centre: { x: -16.666_666, y: -16.666_666 },
    radius: 24,
    perCell: true,
    heightAt: flat,
  });
  const a = field.models.get("A.m2")?.x.length ?? 0;
  const b = field.models.get("B.m2")?.x.length ?? 0;
  assert.equal(a + b, field.total);
  const share = a / field.total;
  assert.ok(Math.abs(share - 0.25) < 0.02, `A took ${(share * 100).toFixed(1)}% of ${field.total}, expected 25%`);
});

test("the same ground grows the same field, from any window and in any order", () => {
  // This is the property that cannot be seen by looking and matters most: the field is rebuilt
  // every four yards of walking, and if a doodad's position depended on the window it was
  // generated in, the whole meadow would shuffle itself on every rebuild.
  const recipe = recipeOf([
    chunk({ row: 0, column: 0, effects: [7] }),
    chunk({ row: 0, column: 1, effects: [7] }),
    chunk({ row: 1, column: 0, effects: [7] }),
    chunk({ row: 1, column: 1, effects: [7] }),
  ]);
  const scatter = (centre) => scatterGroundCover({
    recipe: () => recipe, table: oneEffect(4), centre, radius: 20, perCell: true, heightAt: (x, y) => x + y,
  });
  const first = scatter({ x: -20, y: -20 });
  const again = scatter({ x: -20, y: -20 });
  const moved = scatter({ x: -28, y: -24 });
  const key = (batch, index) => [batch.x[index], batch.y[index], batch.z[index], batch.yaw[index], batch.scale[index]].join(",");
  const listOf = (field) => {
    const entries = [];
    for (const [path, batch] of field.models) for (let index = 0; index < batch.x.length; index++) entries.push(`${path}|${key(batch, index)}`);
    return entries;
  };
  assert.deepEqual(listOf(first), listOf(again), "two identical calls are identical");
  const overlap = new Set(listOf(first));
  let shared = 0;
  for (const entry of listOf(moved)) if (overlap.has(entry)) shared++;
  // The two windows overlap over most of their area, and every doodad in that overlap has to be
  // the same doodad — same model, same spot, same turn, same size.
  assert.ok(shared > 200, `only ${shared} doodads survived the move`);
  const movedNear = listOf(moved).filter((entry) => {
    const [, x, y] = /\|(-?[\d.]+),(-?[\d.]+)/.exec(entry).map(Number);
    return Math.hypot(x - -20, y - -20) <= 20;
  });
  assert.equal(movedNear.filter((entry) => overlap.has(entry)).length, movedNear.length,
    "every doodad of the moved window that is also inside the first one is the same doodad");
});

test("the budget takes the far edge of the field and never a hole out of the middle", () => {
  const recipe = recipeOf(Array.from({ length: 256 }, (_, index) =>
    chunk({ row: index >> 4, column: index & 15, effects: [7] })));
  const centre = { x: -266, y: -266 };
  const uncapped = scatterGroundCover({
    recipe: () => recipe, table: oneEffect(8), centre, radius: 120, perCell: true, cap: 1e9, heightAt: flat,
  });
  const capped = scatterGroundCover({
    recipe: () => recipe, table: oneEffect(8), centre, radius: 120, perCell: true, cap: 500, heightAt: flat,
  });
  assert.ok(uncapped.total > 500, `the uncapped field is ${uncapped.total}`);
  assert.equal(capped.total, 500);
  assert.ok(capped.cellsDropped > 0, "and it says how many cells it refused");
  let keptFurthest = 0;
  for (const batch of capped.models.values()) {
    for (let index = 0; index < batch.x.length; index++) {
      keptFurthest = Math.max(keptFurthest, Math.hypot(batch.x[index] - centre.x, batch.y[index] - centre.y));
    }
  }
  // Cells are visited nearest first, so what a cap takes away is the rim. One cell's diagonal of
  // slack, because a cell is placed as a whole and its far corner is 5.9 yards past its near one.
  const rim = Math.hypot(DETAIL_CELL_SIZE, DETAIL_CELL_SIZE);
  let nearestDropped = Infinity;
  for (const batch of uncapped.models.values()) {
    for (let index = 0; index < batch.x.length; index++) {
      const distance = Math.hypot(batch.x[index] - centre.x, batch.y[index] - centre.y);
      if (distance > keptFurthest) nearestDropped = Math.min(nearestDropped, distance);
    }
  }
  assert.ok(nearestDropped + rim >= keptFurthest, `kept out to ${keptFurthest.toFixed(1)}, dropped from ${nearestDropped.toFixed(1)}`);
});

test("every doodad stands inside its own cell and inside the radius, on the ground it was given", () => {
  const recipe = recipeOf(Array.from({ length: 16 }, (_, index) =>
    chunk({ row: index >> 2, column: index & 3, effects: [7] })));
  const centre = { x: -40, y: -40 };
  const radius = 30;
  const field = scatterGroundCover({
    recipe: () => recipe, table: oneEffect(6), centre, radius, perCell: true,
    heightAt: (x, y) => Math.sin(x) * 3 + y * 0.01,
  });
  assert.ok(field.total > 500, `${field.total} doodads`);
  for (const batch of field.models.values()) {
    for (let index = 0; index < batch.x.length; index++) {
      const x = batch.x[index];
      const y = batch.y[index];
      assert.ok(Math.hypot(x - centre.x, y - centre.y) <= radius, `${x},${y} is outside the radius`);
      // Inside its own cell: the position is the cell's own corner plus a fraction of one cell.
      const row = Math.floor((32 * TERRAIN_GRID_SIZE - x) / DETAIL_CELL_SIZE);
      const column = Math.floor((32 * TERRAIN_GRID_SIZE - y) / DETAIL_CELL_SIZE);
      const cellX = 32 * TERRAIN_GRID_SIZE - row * DETAIL_CELL_SIZE;
      const cellY = 32 * TERRAIN_GRID_SIZE - column * DETAIL_CELL_SIZE;
      assert.ok(x <= cellX + 1e-9 && x >= cellX - DETAIL_CELL_SIZE - 1e-9, `${x} outside its cell`);
      assert.ok(y <= cellY + 1e-9 && y >= cellY - DETAIL_CELL_SIZE - 1e-9, `${y} outside its cell`);
      // The ground it was given, lifted by the hair that keeps a base out of the terrain.
      assert.ok(Math.abs(batch.z[index] - (Math.sin(x) * 3 + y * 0.01) - 0.01) < 1e-6, "height comes from the sampler");
    }
  }
  // A tile that has not landed has no height, so its share of the field waits rather than sinking
  // to zero: 3,525 tufts at sea level under a hillside is worse than no tufts at all.
  const waiting = scatterGroundCover({
    recipe: () => recipe, table: oneEffect(6), centre, radius, perCell: true, heightAt: () => undefined,
  });
  assert.equal(waiting.total, 0);
  assert.equal(waiting.withoutHeight, field.total);
});

test("prefetch margin does not extend the visible ground-cover radius", () => {
  const recipe = recipeOf(Array.from({ length: 256 }, (_, index) =>
    chunk({ row: index >> 4, column: index & 15, effects: [7] })));
  const centre = { x: -266, y: -266 };
  const prefetched = scatterGroundCover({
    recipe: () => recipe, table: oneEffect(2), centre, radius: 54, drawRadius: 50,
    perCell: true, cap: 1e9, heightAt: flat,
  });
  assert.ok(prefetched.total > 0);
  for (const batch of prefetched.models.values()) {
    for (let index = 0; index < batch.x.length; index++) {
      assert.ok(Math.hypot(batch.x[index] - centre.x, batch.y[index] - centre.y) <= 50,
        "a rebuild margin must not draw outside the setting");
    }
  }
});

test("the per-chunk reading of Density is the same field, sixty-four times thinner", () => {
  // The unit is not settled offline and this is the other reading, kept behind «Густая трава»
  // rather than deleted. A chunk is 64 cells, so each cell carries a sixty-fourth of the row's
  // density and spends the fraction as a coin it tosses for itself — which keeps the field
  // reproducible, unlike thinning it by dropping doodads at draw time.
  const recipe = recipeOf(Array.from({ length: 256 }, (_, index) =>
    chunk({ row: index >> 4, column: index & 15, effects: [7] })));
  const centre = { x: -266, y: -266 };
  const dense = scatterGroundCover({
    recipe: () => recipe, table: oneEffect(8), centre, radius: 200, perCell: true, cap: 1e9, heightAt: flat,
  });
  const sparse = scatterGroundCover({
    recipe: () => recipe, table: oneEffect(8), centre, radius: 200, perCell: false, cap: 1e9, heightAt: flat,
  });
  const ratio = dense.total / sparse.total;
  assert.ok(ratio > 55 && ratio < 75, `the two readings differ by ${ratio.toFixed(1)}x, expected about 64`);
  const again = scatterGroundCover({
    recipe: () => recipe, table: oneEffect(8), centre, radius: 200, perCell: false, cap: 1e9, heightAt: flat,
  });
  assert.equal(again.total, sparse.total, "and the thinner field is reproducible too");
});

test("an instance matrix puts a tuft where the scatter put it, turned about the world's vertical", () => {
  // The scatter works in world coordinates — the frame the recipe, the height field and the player
  // are all in — and the scene's is (x, z, -y). The turn is applied after the model-to-scene
  // conversion, or it would be a roll in model space instead of a yaw in the world.
  const batch = { x: [-9464], y: [62], z: [45.5], yaw: [Math.PI / 3], scale: [1.15] };
  const matrix = groundCoverMatrix(batch, 0);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  assert.ok(Math.abs(position.x - -9464) < 1e-3);
  assert.ok(Math.abs(position.y - 45.5) < 1e-3, "world z is the scene's up");
  assert.ok(Math.abs(position.z - -62) < 1e-3, "and world y is negated");
  assert.ok(Math.abs(scale.x - 1.15) < 1e-6 && Math.abs(scale.y - 1.15) < 1e-6);

  // The same tuft built the way a placed doodad is, which is the only thing that says the frames
  // agree: a mesh under a node, carrying `ADT_MODEL_TO_SCENE`, turned about the scene's vertical.
  const node = new THREE.Group();
  node.position.set(-9464, 45.5, -62);
  node.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
  node.scale.setScalar(1.15);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.quaternion.copy(ADT_MODEL_TO_SCENE);
  node.add(mesh);
  node.updateMatrixWorld(true);
  for (let element = 0; element < 16; element++) {
    assert.ok(Math.abs(matrix.elements[element] - mesh.matrixWorld.elements[element]) < 1e-6,
      `element ${element}: ${matrix.elements[element]} vs ${mesh.matrixWorld.elements[element]}`);
  }
});

test("the two settings reach as far as the renderer lets them, and no further", () => {
  // A setting whose range is wider than the clamp behind it is a slider that stops doing anything
  // half way along, which reads as a broken option. The renderer clamps the radius to its own
  // ceiling — the top of the range the original client draws ground cover in — so that number and
  // the slider's maximum have to be the same number.
  const radius = settingDefinition("grassRadius");
  assert.equal(radius.group, "Мир");
  assert.equal(radius.kind, "number");
  assert.equal(radius.max, GROUND_COVER_MAX_RADIUS);
  assert.equal(radius.min, 0, "zero is how the field is turned off");
  assert.equal(coerceSetting(radius, 9999), GROUND_COVER_MAX_RADIUS);
  assert.equal(coerceSetting(radius, -20), 0);
  assert.equal(defaultSettings().grassRadius, 50);
  const dense = settingDefinition("grassDense");
  assert.equal(dense.group, "Мир");
  assert.equal(dense.kind, "boolean");
  assert.equal(defaultSettings().grassDense, true, "the per-cell reading is the one that reads as grass");
  // The field is generated one rebuild step wider than it is drawn, so that at its stalest — a
  // whole step of walking since the last rebuild — it still reaches the radius ahead of the
  // player. The step is the environment ranking's own.
  assert.equal(GROUND_COVER_MARGIN, RESELECT_DISTANCE);
  assert.equal(GROUND_COVER_BUDGET, 6000);
});

test("the cover file is served beside its family, and a missing one rebuilds the tile once", async () => {
  const textures = await mkdtemp(join(tmpdir(), "webclient-cover-"));
  const dbc = await mkdtemp(join(tmpdir(), "webclient-cover-dbc-"));
  // A tile published before ground cover existed: its pictures are there and current, and it has
  // no cover file and never had one. That is every one of the 86 tiles on the owner's machine, and
  // it is the case the stamp check is asked about first — `ensureCurrent` runs before the read and
  // is keyed on this file's own name, so it finds no `.src` beside a file that does not exist,
  // remembers that, and lets the ordinary ENOENT path rebuild the family.
  await mkdir(join(textures, "0"), { recursive: true });
  await writeFile(join(textures, "0", "49-31.alpha.png"), Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1));
  let generated = 0;
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    // With a dataset configured the fingerprint is watching, which is what puts `ensureCurrent` on
    // the path at all: without one it returns before doing anything and the case above is untested.
    dbcDirectory: dbc,
    terrainTexturesDirectory: textures,
    generateTerrainSplat: async (map, gridX, gridY) => {
      generated++;
      await mkdir(join(textures, String(map)), { recursive: true });
      const cover = encodeGroundCover([chunk({ row: 0, column: 0, effects: [7] })]);
      await writeFile(join(textures, String(map), `${gridX}-${gridY}.cover.bin`), cover);
      await writeFile(join(textures, String(map), `${gridX}-${gridY}.alpha.png`), Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
      await writeFile(join(textures, String(map), `${gridX}-${gridY}.index.png`), Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
      await writeFile(join(textures, String(map), `${gridX}-${gridY}.splat.json`), JSON.stringify({ layers: [] }));
    },
  });
  try {
    const headers = { origin: "http://localhost:5173" };
    const base = `http://127.0.0.1:${gateway.port}/terrain-splat/0/49/31`;
    assert.equal((await fetch(`${base}/cover.bin`)).status, 403, "a foreign origin is refused");

    // The whole family asked for at once, exactly as a tile landing asks for it: one generation,
    // because the lane dedupes on the tile rather than on the file.
    const [cover, alpha, index] = await Promise.all([
      fetch(`${base}/cover.bin`, { headers }),
      fetch(`${base}/alpha.png`, { headers }),
      fetch(`${base}/index.png`, { headers }),
    ]);
    assert.equal(cover.status, 200);
    assert.equal(alpha.status, 200);
    assert.equal(index.status, 200);
    assert.equal(generated, 1, "concurrent requests for one tile are one child process");
    assert.equal(cover.headers.get("content-type"), "application/octet-stream");
    assert.equal(alpha.headers.get("content-type"), "image/png");
    const body = Buffer.from(await cover.arrayBuffer());
    await alpha.arrayBuffer();
    await index.arrayBuffer();
    assert.equal(body.byteLength, GROUND_COVER_SIZE);
    assert.equal(body.subarray(0, 4).toString("latin1"), "WGC1");

    // Already on disk: served without touching the generator again.
    const cached = await fetch(`${base}/cover.bin`, { headers });
    assert.equal(cached.status, 200);
    await cached.arrayBuffer();
    assert.equal(generated, 1);

    // A grid that is not a grid never reaches the filesystem, and never a generator.
    const outside = await fetch(`http://127.0.0.1:${gateway.port}/terrain-splat/0/64/31/cover.bin`, { headers });
    assert.equal(outside.status, 400);
    await outside.arrayBuffer();
    assert.equal(generated, 1);
    // And a name in the family that does not exist is not a path either.
    const strange = await fetch(`${base}/cover.png`, { headers });
    assert.ok(strange.status >= 400);
    await strange.arrayBuffer();
  } finally {
    await gateway.close();
    await rm(textures, { recursive: true, force: true });
    await rm(dbc, { recursive: true, force: true });
  }
});

test("the ground effect table names its models by path and drops the slots that name none", async () => {
  const dbc = await mkdtemp(join(tmpdir(), "webclient-ground-effects-"));
  try {
    // Two rows: one that grows two of its four slots, one with a density and no doodad at all —
    // which is 308 of the real table's rows, and none of them belongs in the answer.
    const strings = [0, ...encoder.encode("ElwGra01.mdx"), 0, ...encoder.encode("ElwFlo02.mdl"), 0];
    const texture = dbcRows(11, [
      [7, 3, 5, 0, 0, /* weights */ 1, 3, 0, 96, /* density */ 8, /* sound */ 5],
      [9, 0, 0, 0, 0, 0, 0, 0, 0, 4, 2],
    ], Uint8Array.from(strings));
    const doodad = dbcRows(3, [[3, 1, 0], [5, 14, 1]], Uint8Array.from(strings));
    await writeFile(join(dbc, "GroundEffectTexture.dbc"), texture);
    await writeFile(join(dbc, "GroundEffectDoodad.dbc"), doodad);
    const gateway = await startGateway({
      host: "127.0.0.1",
      port: 0,
      auth: { host: "127.0.0.1", port: 1 },
      world: { host: "127.0.0.1", port: 1 },
      allowedOrigins: ["http://localhost:5173"],
      dbcDirectory: dbc,
    });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/dbc/ground-effects`)).status, 403);
      const response = await fetch(`http://127.0.0.1:${gateway.port}/dbc/ground-effects`, {
        headers: { origin: "http://localhost:5173" },
      });
      assert.equal(response.status, 200);
      const table = await response.json();
      // The stored name is bare and its extension is the client's; the file on disk is `.m2`.
      assert.deepEqual(table.models, ["World\\NoDXT\\Detail\\ElwGra01.m2", "World\\NoDXT\\Detail\\ElwFlo02.m2"]);
      assert.deepEqual(Object.keys(table.effects), ["7"], "a row that grows nothing is not published");
      assert.equal(table.effects[7].density, 8);
      assert.equal(table.effects[7].terrain, 5, "the last field is the TerrainType, which footsteps read");
      // Slot 3 carries a weight of 96 and no model. It is dropped here, so the weight cannot be
      // counted into a total that nothing can ever roll.
      assert.deepEqual(table.effects[7].doodads, [[0, 1], [1, 3]]);
    } finally {
      await gateway.close();
    }
  } finally {
    await rm(dbc, { recursive: true, force: true });
  }
});

test("the real Goldshire tile grows 101,036 doodads over eleven models, and none on the road",
  withDataset, async () => {
    // End to end, through the shipping generator: the ADT's own MCLY effect ids and header maps,
    // the dataset's own tables, and the browser's own scatter. The numbers are the tile's, not the
    // test's — a transposed map, a reversed mask bit or a missed MCLY field all move them.
    const textures = await mkdtemp(join(tmpdir(), "webclient-cover-tile-"));
    const layers = await mkdtemp(join(tmpdir(), "webclient-cover-layers-"));
    try {
      await promisify(execFile)(
        process.execPath,
        [resolve(repositoryRoot, "tools/generate-terrain-splat.mjs"), "0", "49", "31"],
        { cwd: repositoryRoot, env: { ...process.env, TERRAIN_LAYER_DIR: layers, TERRAIN_TEXTURE_DIR: textures } },
      );
      const file = await readFile(join(textures, "0", "49-31.cover.bin"));
      assert.equal(file.byteLength, GROUND_COVER_SIZE);
      // The fifth file of the family carries the family's own stamp, or it could not say for
      // itself whether the ADT it was read from has moved.
      const stamp = JSON.parse(await readFile(join(textures, "0", "49-31.cover.bin.src"), "utf8"));
      const alpha = JSON.parse(await readFile(join(textures, "0", "49-31.alpha.png.src"), "utf8"));
      assert.deepEqual(stamp, alpha);

      const recipe = decodeGroundCover(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
      let masked = 0;
      for (const byte of recipe.noDoodad) masked += popcount(byte);
      assert.equal(masked, 1119, "the tile's own no-doodad mask");

      const { loadGroundEffects } = await import("../dist/code/gateway/GroundEffects.js");
      const table = await loadGroundEffects(directories.dbc);
      assert.equal(Object.keys(table.effects).length, 892, "892 of the 24,981 rows grow anything");
      assert.equal(table.models.length, 485);

      // The whole tile at once: a radius of one tile from the tile's own centre covers it, and
      // nothing outside it has a recipe.
      const field = scatterGroundCover({
        recipe: (grid) => (grid.x === 49 && grid.y === 31 ? recipe : undefined),
        table,
        centre: { x: (32 - 49 - 0.5) * TERRAIN_GRID_SIZE, y: (32 - 31 - 0.5) * TERRAIN_GRID_SIZE },
        radius: TERRAIN_GRID_SIZE,
        perCell: true,
        cap: Number.MAX_SAFE_INTEGER,
        heightAt: flat,
      });
      assert.equal(field.total, 101_036);
      assert.equal(field.models.size, 11);
      for (const path of field.models.keys()) {
        assert.match(path, /^World\\NoDXT\\Detail\\(Elw(Gra|Flo)0\d|DskGra03)\.m2$/, path);
      }

      // Not one of them on a cell the artist closed — 642 of those 1,119 cells are the Goldshire
      // road, and 24 of them are inside an ADT hole.
      let onRoad = 0;
      for (const batch of field.models.values()) {
        for (let index = 0; index < batch.x.length; index++) {
          const row = Math.floor((32 * TERRAIN_GRID_SIZE - batch.x[index]) / DETAIL_CELL_SIZE) & 127;
          const column = Math.floor((32 * TERRAIN_GRID_SIZE - batch.y[index]) / DETAIL_CELL_SIZE) & 127;
          const at = ((row >> 3) * 16 + (column >> 3)) * 8 + (row & 7);
          if (((recipe.noDoodad[at] >> (column & 7)) & 1) !== 0) onRoad++;
        }
      }
      assert.equal(onRoad, 0);

      // And every one of them stands on the ground the client draws.
      const map = await readFile(join(directories.maps, "0004931.map"));
      const ground = new TerrainTile(map.buffer.slice(map.byteOffset, map.byteOffset + map.byteLength));
      const real = scatterGroundCover({
        recipe: (grid) => (grid.x === 49 && grid.y === 31 ? recipe : undefined),
        table,
        centre: { x: -9540, y: 300 },
        radius: 50,
        perCell: true,
        heightAt: (x, y) => {
          const grid = terrainGrid(x, y);
          return grid?.x === 49 && grid.y === 31 ? ground.heightAt(x, y) : undefined;
        },
      });
      // Measured on this machine: 3,515 doodads over 11 models in the densest 40-yard window of
      // the tile, 14,148 triangles, and every one of them answered by the height field.
      assert.ok(real.total > 3000 && real.total < 4000, `${real.total} doodads within 50 yards`);
      assert.equal(real.withoutHeight, 0);
      for (const batch of real.models.values()) for (const z of batch.z) assert.ok(Number.isFinite(z));
    } finally {
      await rm(textures, { recursive: true, force: true });
      await rm(layers, { recursive: true, force: true });
    }
  });

test("every model the real table names is in the client, bar the one that is not", withDataset, async () => {
  // 484 of 485. `World\NoDXT\Detail\ArathiGra01.m2` is named by a row and is not in the archives,
  // which is the client's own gap and not this pipeline's: the browser asks for it, `/visual/model`
  // answers 404, and that model's share of the field simply does not appear.
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { loadGroundEffects } = await import("../dist/code/gateway/GroundEffects.js");
  const table = await loadGroundEffects(directories.dbc);
  const archives = await clientArchives(directories.client);
  try {
    const missing = [];
    for (const path of table.models) if (!(await archives.read(path))) missing.push(path);
    assert.deepEqual(missing, ["World\\NoDXT\\Detail\\ArathiGra01.m2"]);
  } finally {
    archives.close();
  }
});

function popcount(value) {
  let count = 0;
  for (let bit = 0; bit < 8; bit++) if ((value >> bit) & 1) count++;
  return count;
}

/** A WDBC of `fields` unsigned words a row, with a string block after it. */
function dbcRows(fields, rows, strings) {
  const result = new Uint8Array(20 + rows.length * fields * 4 + strings.byteLength);
  result.set(encoder.encode("WDBC"));
  const view = new DataView(result.buffer);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, strings.byteLength, true);
  for (let row = 0; row < rows.length; row++) {
    for (let field = 0; field < fields; field++) view.setUint32(20 + (row * fields + field) * 4, rows[row][field] ?? 0, true);
  }
  result.set(strings, 20 + rows.length * fields * 4);
  return result;
}
