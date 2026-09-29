import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  createGroundCoverCellCache, hypot2, scatterGroundCover, writeGroundCoverInstanceMatrices,
} from "../dist/code/browser/GroundCover.js";
import { TERRAIN_GRID_SIZE } from "../dist/code/browser/Terrain.js";
import { groundCoverMatrix } from "../dist/code/browser/WorldRenderer3D.js";

/**
 * `scatterGroundCover` as it stood before a rebuild reused anything (GroundCover.ts, 2026-09-27),
 * copied verbatim but for its types, with the helpers it called. The rewrite has to agree with it
 * on every field, every model order, every cache and every recipe it asks for.
 */
const reference = (() => {
  const DETAIL_CELLS_PER_TILE = 128;
  const DETAIL_CELL_SIZE = TERRAIN_GRID_SIZE / DETAIL_CELLS_PER_TILE;
  const WORLD_ORIGIN = 32 * TERRAIN_GRID_SIZE;
  const GROUND_COVER_FADE_WIDTH = 20;
  const GROUND_COVER_BUDGET = 10_000;
  const GROUND_COVER_LIFT = 0.01;
  const SCALE_MINIMUM = 0.8;
  const SCALE_RANGE = 0.35;
  const CELLS_PER_WORLD_ROW = DETAIL_CELLS_PER_TILE * 64;

  function growCell(row, column, recipe, table, perCell, densityScale, heightAt) {
    const chunk = (((row >> 3) & 15) * 16 + ((column >> 3) & 15));
    const cellRow = row & 7;
    const cellColumn = column & 7;
    if (((recipe.noDoodad[chunk * 8 + cellRow] >> cellColumn) & 1) !== 0) return null;
    const layer = (recipe.winner[chunk * 8 + cellRow] >> (cellColumn * 2)) & 3;
    const effect = table.effects[recipe.effects[chunk * 4 + layer]];
    if (!effect || effect.doodads.length === 0) return null;
    const seed = mix((row * CELLS_PER_WORLD_ROW + column) | 0);
    let count = Math.max(0, Math.round(effect.density * densityScale));
    if (!perCell) {
      const share = (effect.density * densityScale) / 64;
      count = Math.floor(share);
      if (random01(seed, 0) < share - count) count++;
    }
    if (count <= 0) return null;
    let weight = 0;
    for (const [, share] of effect.doodads) weight += share;
    const equal = weight <= 0;
    if (equal) weight = effect.doodads.length;
    const paths = new Array(count);
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    const z = new Float64Array(count);
    const yaw = new Float64Array(count);
    const scale = new Float64Array(count);
    for (let index = 0; index < count; index++) {
      const point = mix(seed + Math.imul(index + 1, 0x85ebca6b));
      x[index] = WORLD_ORIGIN - (row + random01(point, 1)) * DETAIL_CELL_SIZE;
      y[index] = WORLD_ORIGIN - (column + random01(point, 2)) * DETAIL_CELL_SIZE;
      const height = heightAt(x[index], y[index]);
      z[index] = height === undefined ? Number.NaN : height + GROUND_COVER_LIFT;
      let roll = random01(point, 3) * weight;
      let model = effect.doodads[0][0];
      for (const [candidate, share] of effect.doodads) {
        model = candidate;
        roll -= equal ? 1 : share;
        if (roll < 0) break;
      }
      paths[index] = table.models[model];
      yaw[index] = random01(point, 4) * Math.PI * 2;
      scale[index] = SCALE_MINIMUM + random01(point, 5) * SCALE_RANGE;
    }
    return { paths, x, y, z, yaw, scale };
  }

  function scatterGroundCover(options) {
    const { centre, radius, table, perCell } = options;
    const requestedDrawRadius = options.drawRadius ?? radius;
    const drawRadius = Number.isFinite(requestedDrawRadius)
      ? Math.max(0, Math.min(radius, requestedDrawRadius))
      : 0;
    const cap = options.cap ?? GROUND_COVER_BUDGET;
    const field = { models: new Map(), total: 0, cellsDropped: 0, withoutHeight: 0 };
    if (radius <= 0 || cap <= 0) return field;
    const first = (value) => Math.max(0, Math.min(DETAIL_CELLS_PER_TILE * 64 - 1,
      Math.floor((WORLD_ORIGIN - value) / DETAIL_CELL_SIZE)));
    const rowFrom = first(centre.x + radius);
    const rowTo = first(centre.x - radius);
    const columnFrom = first(centre.y + radius);
    const columnTo = first(centre.y - radius);
    const cells = [];
    for (let row = rowFrom; row <= rowTo; row++) {
      const maxX = WORLD_ORIGIN - row * DETAIL_CELL_SIZE;
      const outsideX = Math.max(maxX - DETAIL_CELL_SIZE - centre.x, 0, centre.x - maxX);
      for (let column = columnFrom; column <= columnTo; column++) {
        const maxY = WORLD_ORIGIN - column * DETAIL_CELL_SIZE;
        const outsideY = Math.max(maxY - DETAIL_CELL_SIZE - centre.y, 0, centre.y - maxY);
        const distance = Math.hypot(outsideX, outsideY);
        if (distance <= radius) cells.push({ row, column, distance });
      }
    }
    cells.sort((left, right) => left.distance - right.distance);
    const densityScale = Number.isFinite(options.densityScale) && (options.densityScale ?? 1) > 0
      ? options.densityScale ?? 1
      : 1;
    const clip = options.deferDistanceFade ? radius : drawRadius;
    const clipSquared = clip * clip;
    const previous = options.cells?.cells;
    const kept = options.cells ? new Map() : undefined;
    const recipes = new Map();
    for (const cell of cells) {
      const cellKey = cell.row * CELLS_PER_WORLD_ROW + cell.column;
      if (field.total >= cap) {
        field.cellsDropped++;
        const known = previous?.get(cellKey);
        if (kept && known !== undefined) kept.set(cellKey, known);
        continue;
      }
      let grown = previous?.get(cellKey);
      if (grown === undefined) {
        const grid = { x: cell.row >> 7, y: cell.column >> 7 };
        const key = `${grid.x}/${grid.y}`;
        let recipe = recipes.get(key);
        if (recipe === undefined && !recipes.has(key)) {
          recipe = options.recipe(grid);
          recipes.set(key, recipe);
        }
        if (!recipe) continue;
        grown = growCell(cell.row, cell.column, recipe, table, perCell, densityScale, options.heightAt);
      }
      if (kept && (grown === null || !grown.z.some(Number.isNaN))) kept.set(cellKey, grown);
      if (grown === null) continue;
      const { paths, x, y, z, yaw, scale } = grown;
      for (let index = 0; index < x.length && field.total < cap; index++) {
        const dx = x[index] - centre.x;
        const dy = y[index] - centre.y;
        if (dx * dx + dy * dy > clipSquared) continue;
        const height = z[index];
        if (Number.isNaN(height)) {
          field.withoutHeight++;
          continue;
        }
        const path = paths[index];
        if (path === undefined) continue;
        let batch = field.models.get(path);
        if (!batch) {
          batch = { x: [], y: [], z: [], yaw: [], scale: [] };
          field.models.set(path, batch);
        }
        batch.x.push(x[index]);
        batch.y.push(y[index]);
        batch.z.push(height);
        batch.yaw.push(yaw[index]);
        batch.scale.push(scale[index]
          * (options.deferDistanceFade ? 1 : groundCoverDistanceScale(Math.hypot(dx, dy), drawRadius)));
        field.total++;
      }
    }
    if (options.cells && kept) options.cells.cells = kept;
    return field;
  }

  function groundCoverDistanceScale(distance, drawRadius) {
    if (!Number.isFinite(distance) || !Number.isFinite(drawRadius) || drawRadius <= 0) return 0;
    const linear = Math.max(0, Math.min(1, (drawRadius - distance) / GROUND_COVER_FADE_WIDTH));
    return linear * linear * (3 - 2 * linear);
  }

  function mix(value) {
    let hash = value | 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
    hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
    return (hash ^ (hash >>> 15)) >>> 0;
  }

  function random01(seed, salt) {
    return mix((seed + Math.imul(salt, 0x9e3779b1)) | 0) / 4294967296;
  }

  return { scatterGroundCover, DETAIL_CELL_SIZE, WORLD_ORIGIN };
})();

/** mulberry32: a walk that fails can be replayed from its seed. */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A few tiles around the world's centre, each with its own effects, so that walking across a tile
 * edge makes models appear, vanish and change the order they are first met in; two tiles are
 * missing, one grows nothing. Slot 7 names no model, effect 3's weights are all zero, effect 5 has
 * no density and effect 6 no doodads — every path through `growCell`.
 */
const table = {
  models: ["A.m2", "B.m2", "C.m2", "D.m2", "E.m2", "F.m2", "G.m2", undefined, "H.m2"],
  effects: {
    1: { density: 3, terrain: 0, doodads: [[0, 3], [1, 1]] },
    2: { density: 2, terrain: 0, doodads: [[2, 1], [3, 1], [7, 1]] },
    3: { density: 4, terrain: 0, doodads: [[4, 0], [5, 0]] },
    4: { density: 1, terrain: 0, doodads: [[6, 2], [8, 1]] },
    5: { density: 0, terrain: 0, doodads: [[0, 1]] },
    6: { density: 5, terrain: 0, doodads: [] },
  },
};
const tilePools = {
  "32/32": [1, 2, 3, 9], "31/32": [4, 1], "32/31": [3, 4, 5], "33/32": [2, 6, 1],
  "32/33": [4], "33/33": [1, 2, 3, 4], "33/31": [5, 6], "31/33": [4, 2],
};
const recipes = new Map();
{
  const random = generator(0x6c6f616d);
  for (const [tile, pool] of Object.entries(tilePools)) {
    const effects = new Uint32Array(1024);
    const winner = new Uint16Array(2048);
    const noDoodad = new Uint8Array(2048);
    for (let chunk = 0; chunk < 256; chunk++) {
      for (let slot = 0; slot < 4; slot++) effects[chunk * 4 + slot] = pool[Math.floor(random() * pool.length)];
      for (let row = 0; row < 8; row++) {
        winner[chunk * 8 + row] = Math.floor(random() * 65536);
        let mask = 0;
        for (let column = 0; column < 8; column++) if (random() < 0.08) mask |= 1 << column;
        noDoodad[chunk * 8 + row] = mask;
      }
    }
    recipes.set(tile, { effects, winner, noDoodad });
  }
}
const recipeOf = (grid) => recipes.get(`${grid.x}/${grid.y}`);

/** Same size, same keys, and bit for bit the same grown cells. */
function assertSameCells(actual, expected, label) {
  const bytes = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  assert.equal(actual.size, expected.size, `${label}: cached cells`);
  for (const [key, cell] of expected) {
    assert.ok(actual.has(key), `${label}: cell ${key} was forgotten`);
    const mine = actual.get(key);
    if (cell === null || mine === null) {
      assert.equal(mine, cell, `${label}: cell ${key}`);
      continue;
    }
    for (const name of ["x", "y", "z", "yaw", "scale"]) {
      assert.ok(Buffer.compare(bytes(mine[name]), bytes(cell[name])) === 0, `${label}: cell ${key} ${name}`);
    }
    assert.deepStrictEqual(mine.paths, cell.paths, `${label}: cell ${key} paths`);
  }
}

/** How many window cells share their distance with an earlier one, by the reference's formula. */
function tiesAround(centre, radius) {
  const { DETAIL_CELL_SIZE, WORLD_ORIGIN } = reference;
  const seen = new Set();
  let ties = 0;
  const first = (value) => Math.floor((WORLD_ORIGIN - value) / DETAIL_CELL_SIZE);
  for (let row = first(centre.x + radius); row <= first(centre.x - radius); row++) {
    const maxX = WORLD_ORIGIN - row * DETAIL_CELL_SIZE;
    const outsideX = Math.max(maxX - DETAIL_CELL_SIZE - centre.x, 0, centre.x - maxX);
    for (let column = first(centre.y + radius); column <= first(centre.y - radius); column++) {
      const maxY = WORLD_ORIGIN - column * DETAIL_CELL_SIZE;
      const distance = Math.hypot(outsideX, Math.max(maxY - DETAIL_CELL_SIZE - centre.y, 0, centre.y - maxY));
      if (distance > radius) continue;
      if (seen.has(distance)) ties++;
      seen.add(distance);
    }
  }
  return ties;
}

/**
 * Fifty windows each, walked in four-yard steps as the renderer rebuilds, over the combinations
 * the renderer and the tests use: the owner's deferred fade with a binding cap, a diagonal walk
 * whose centre keeps x = y so that mirrored cells tie to the last bit, the per-chunk reading, and
 * heights landing mid-walk with a jump, a shrinking radius and the degenerate options in between.
 */
const scenarios = [
  {
    name: "deferred fade, binding cap",
    seed: 1,
    options: (step, walk) => ({
      centre: walk(4), radius: 48, drawRadius: 44, deferDistanceFade: true,
      perCell: true, densityScale: 2, cap: 1200, heightAt: (x, y) => Math.sin(x * 0.05) * 3 + y * 0.01,
    }),
  },
  {
    name: "diagonal walk with ties, CPU fade",
    seed: 2,
    start: { x: -100.25, y: -100.25 },
    heading: Math.PI / 4,
    straight: true,
    options: (step, walk) => ({
      centre: walk(4), radius: 40, drawRadius: 36, perCell: true, densityScale: 3, cap: 1e9,
      heightAt: (x, y) => x * 0.02 - y * 0.01,
    }),
  },
  {
    name: "per-chunk reading",
    seed: 3,
    options: (step, walk) => ({
      centre: walk(4), radius: 60, drawRadius: 56, deferDistanceFade: true,
      perCell: false, densityScale: 64, cap: 1e9, heightAt: () => 1,
    }),
  },
  {
    name: "heights landing, a jump, a shrinking radius",
    seed: 4,
    options: (step, walk) => ({
      centre: step === 25 ? walk(140) : walk(4),
      radius: step >= 30 && step < 35 ? 24 : 48, drawRadius: 44, deferDistanceFade: step % 7 !== 3,
      perCell: true, densityScale: 1.5, cap: 500,
      // A half-plane every starting window reaches into (the start is within 43 yards of its
      // edge), whose tile lands at step 20.
      heightAt: (x, y) => (step < 20 && x + y < 0 ? undefined : Math.cos(y * 0.1)),
    }),
  },
  {
    name: "degenerate options",
    seed: 5,
    options: (step, walk) => {
      const centre = walk(4);
      const odd = [
        { radius: 0 }, { cap: 0 }, { cap: Number.NaN }, { radius: Number.NaN },
        { centre: { x: Number.NaN, y: centre.y } }, { densityScale: -2 }, { drawRadius: 1e9 },
        { drawRadius: Number.NaN }, { cap: 777.5 },
      ][step % 12];
      return {
        centre, radius: 36, perCell: true, densityScale: Number.NaN, cap: 1500, heightAt: () => 0,
        ...(odd ?? {}),
      };
    },
  },
];

test("a walked rebuild scatters exactly the field, cache and recipe requests it did before, with or without a reused field", () => {
  const seen = { ties: 0, orderChanged: 0, vanished: 0, shrank: 0, dropped: 0, withoutHeight: 0, missing: 0 };
  for (const scenario of scenarios) {
    const random = generator(scenario.seed);
    let heading = scenario.heading ?? random() * Math.PI * 2;
    const at = { ...(scenario.start ?? { x: -30 + random() * 60, y: -30 + random() * 60 }) };
    const walk = (distance) => {
      if (!scenario.straight) heading += (random() - 0.5) * 0.8;
      if (scenario.straight) {
        // The same addend on equal coordinates keeps them equal.
        const step = distance * Math.SQRT1_2;
        at.x += step;
        at.y += step;
      } else {
        at.x += Math.cos(heading) * distance;
        at.y += Math.sin(heading) * distance;
      }
      return { x: at.x, y: at.y };
    };
    const referenceCells = { cells: new Map() };
    const freshCells = createGroundCoverCellCache();
    const reuseCells = createGroundCoverCellCache();
    let reused;
    for (let step = 0; step < 50; step++) {
      const options = { table, ...scenario.options(step, walk) };
      const label = `${scenario.name}, step ${step}`;
      const asked = { reference: [], fresh: [], reuse: [] };
      const recipe = (log) => (grid) => {
        log.push(`${grid.x}/${grid.y}`);
        return recipeOf(grid);
      };
      const expected = reference.scatterGroundCover({ ...options, recipe: recipe(asked.reference), cells: referenceCells });
      const fresh = scatterGroundCover({ ...options, recipe: recipe(asked.fresh), cells: freshCells });
      const before = reused && new Map([...reused.models].map(([path, batch]) => [path, batch.x.length]));
      const next = scatterGroundCover({
        ...options, recipe: recipe(asked.reuse), cells: reuseCells, ...(reused ? { reuse: reused } : {}),
      });
      if (reused) assert.strictEqual(next, reused, `${label}: the reused field is the field returned`);

      assert.deepStrictEqual(fresh, expected, label);
      assert.deepStrictEqual([...fresh.models.keys()], [...expected.models.keys()], `${label}: model order`);
      assert.deepStrictEqual(next, expected, `${label}, reused`);
      assert.deepStrictEqual([...next.models.keys()], [...expected.models.keys()], `${label}, reused: model order`);
      assert.deepStrictEqual(asked.fresh, asked.reference, `${label}: recipes asked`);
      assert.deepStrictEqual(asked.reuse, asked.reference, `${label}, reused: recipes asked`);
      assertSameCells(freshCells.cells, referenceCells.cells, label);
      assertSameCells(reuseCells.cells, referenceCells.cells, `${label}, reused`);

      if (before) {
        const keys = [...next.models.keys()];
        const kept = [...before.keys()].filter((path) => next.models.has(path));
        if (kept.length < before.size) seen.vanished++;
        if (kept.join() !== keys.filter((path) => before.has(path)).join()) seen.orderChanged++;
        if (kept.some((path) => next.models.get(path).x.length < before.get(path))) seen.shrank++;
      }
      if (Number.isFinite(options.centre.x) && options.radius > 0) seen.ties += tiesAround(options.centre, options.radius);
      if (expected.cellsDropped > 0) seen.dropped++;
      if (expected.withoutHeight > 0) seen.withoutHeight++;
      if (asked.reference.some((tile) => !recipes.has(tile))) seen.missing++;
      reused = next;
    }
  }
  // Each way the rewrite could part from the old scatter was actually taken by some step.
  for (const [what, count] of Object.entries(seen)) assert.ok(count > 0, `no step exercised ${what}`);
});

test("a reused field keeps its models' batches and arrays, and lets go of a model that stops growing", () => {
  const cells = createGroundCoverCellCache();
  const options = (centre) => ({
    recipe: recipeOf, table, centre, radius: 48, drawRadius: 44, deferDistanceFade: true,
    perCell: true, densityScale: 2, cap: 1e9, heightAt: () => 0, cells,
  });
  const field = scatterGroundCover(options({ x: -20, y: -20 }));
  let kept = 0;
  for (let step = 1; step <= 12; step++) {
    const before = new Map([...field.models].map(([path, batch]) => [path, { batch, x: batch.x, scale: batch.scale }]));
    const next = scatterGroundCover({ ...options({ x: -20 - step * 4, y: -20 }), reuse: field });
    assert.strictEqual(next, field);
    for (const [path, batch] of field.models) {
      const earlier = before.get(path);
      if (!earlier) continue;
      assert.strictEqual(batch, earlier.batch, `step ${step}: ${path} is the same batch`);
      assert.strictEqual(batch.x, earlier.x, `step ${step}: ${path} writes over the same x array`);
      assert.strictEqual(batch.scale, earlier.scale, `step ${step}: ${path} writes over the same scale array`);
      kept++;
    }
  }
  assert.ok(kept > 12 * 3, `${kept} batches carried over`);
  // Tile 33/32 grows four of the models: jumping into it drops the others and keeps those four's
  // batches, in the order the new walk met them.
  const before = new Map(field.models);
  const far = { x: -800, y: -250 };
  scatterGroundCover({ ...options(far), reuse: field });
  const gone = [...before.keys()].filter((path) => !field.models.has(path));
  assert.ok(gone.length > 0 && field.models.size > 0, `${gone.length} models stopped growing, ${field.models.size} did not`);
  for (const [path, batch] of field.models) {
    if (before.has(path)) assert.strictEqual(batch, before.get(path), `${path} kept its batch across the jump`);
  }
  assert.deepStrictEqual(field, reference.scatterGroundCover({ ...options(far), cells: undefined }));
  assert.deepStrictEqual([...field.models.keys()],
    [...reference.scatterGroundCover({ ...options(far), cells: undefined }).models.keys()]);
  // Turned off, the same field comes back empty.
  assert.strictEqual(scatterGroundCover({ ...options(far), radius: 0, reuse: field }), field);
  assert.equal(field.models.size, 0);
  assert.equal(field.total, 0);
});

test("a scatter that throws empties the field it was reusing, and one run inside a callback keeps to its own arrays", () => {
  const options = (centre, extra = {}) => ({
    recipe: recipeOf, table, centre, radius: 40, drawRadius: 36, deferDistanceFade: true,
    perCell: true, densityScale: 2, cap: 1e9, heightAt: () => 0, ...extra,
  });
  const cells = createGroundCoverCellCache();
  const field = scatterGroundCover(options({ x: -20, y: -20 }, { cells }));
  assert.ok(field.total > 0);
  assert.throws(() => scatterGroundCover(options({ x: -60, y: -20 }, {
    cells, reuse: field, heightAt: () => { throw new Error("the tile went away"); },
  })), /the tile went away/);
  assert.equal(field.total, 0, "a half written field is not left behind");
  assert.equal(field.models.size, 0);
  // The shared arrays were let go: the next scatter, through the same cache and field, is right.
  scatterGroundCover(options({ x: -64, y: -20 }, { cells, reuse: field }));
  assert.deepStrictEqual(field, reference.scatterGroundCover(options({ x: -64, y: -20 })));

  // A recipe callback that scatters elsewhere, half way through the outer walk.
  let nested;
  const outer = scatterGroundCover(options({ x: -20, y: -20 }, {
    recipe: (grid) => {
      nested ??= scatterGroundCover(options({ x: -300, y: 150 }));
      return recipeOf(grid);
    },
  }));
  assert.ok(nested && nested.total > 0);
  assert.deepStrictEqual(outer, reference.scatterGroundCover(options({ x: -20, y: -20 })));
  assert.deepStrictEqual(nested, reference.scatterGroundCover(options({ x: -300, y: 150 })));
});

test("hypot2 is V8's own Math.hypot, double for double, without its allocation", () => {
  const random = generator(9);
  const specials = [0, -0, 1, -1, 3, 4, 5e-324, -5e-324, 1e-310, 2.2250738585072014e-308, 1e-200, 1e200,
    1.7976931348623157e308, -1.7976931348623157e308, Infinity, -Infinity, Number.NaN, Math.PI,
    TERRAIN_GRID_SIZE / 128, 184, 0.1, 0.2, 0.3];
  const check = (a, b) => {
    const mine = hypot2(a, b);
    const engine = Math.hypot(a, b);
    if (!Object.is(mine, engine)) assert.fail(`hypot2(${a}, ${b}) = ${mine}, Math.hypot = ${engine}`);
  };
  for (const a of specials) for (const b of specials) check(a, b);
  for (let index = 0; index < 400_000; index++) {
    switch (index % 4) {
      case 0: check(random() * 200, random() * 200); break;
      case 1: check((random() - 0.5) * 1e6, (random() - 0.5) * 3); break;
      case 2: check(10 ** (random() * 600 - 300) * (random() < 0.5 ? -1 : 1), 10 ** (random() * 600 - 300)); break;
      default: {
        // Cell offsets, and the equal pair a diagonal through the centre produces.
        const value = Math.floor(random() * 50) * (TERRAIN_GRID_SIZE / 128) - random() * 3;
        check(value, value);
      }
    }
  }
});

test("the instance matrix writer stores the floats groundCoverMatrix and setMatrixAt do, bit for bit", () => {
  const random = generator(11);
  const yaws = [0, -0, Math.PI, -Math.PI, 2 * Math.PI, -2 * Math.PI, Math.PI / 2, -Math.PI / 2, 5e-324, -5e-324,
    1e-300, -1e-300, 1e10, -1e10, 1e300, Number.NaN, Infinity, -Infinity];
  const scales = [0, -0, 1, 0.8, 1.15, 1e-30, 1e-40, 1e-46, 1e30, 3.4e38, 1e39, -1, Number.NaN];
  const coordinates = [0, -0, 1e7, -1e7, 17066.666666666668, -17066.666666666668, 3.4e38, -3.5e38, 1e300, 5e-324];
  const pick = (list, chance, otherwise) => (random() < chance ? list[Math.floor(random() * list.length)] : otherwise());
  const count = 4000;
  const batch = { x: [], y: [], z: [], yaw: [], scale: [] };
  for (let index = 0; index < count; index++) {
    batch.x.push(pick(coordinates, 0.05, () => (random() - 0.5) * 34000));
    batch.y.push(pick(coordinates, 0.05, () => (random() - 0.5) * 34000));
    batch.z.push(pick(coordinates, 0.05, () => (random() - 0.5) * 1000));
    batch.yaw.push(pick(yaws, 0.08, () => (random() - 0.5) * 8 * Math.PI));
    batch.scale.push(pick(scales, 0.08, () => 0.8 + random() * 0.35));
  }
  // What the renderer does today, one tuft at a time through three.
  const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), count);
  const matrix = new THREE.Matrix4();
  for (let index = 0; index < count; index++) mesh.setMatrixAt(index, groundCoverMatrix(batch, index, matrix));
  const expected = mesh.instanceMatrix.array;

  const offset = 32;
  const target = new Float32Array(offset + count * 16 + 8).fill(7);
  assert.equal(writeGroundCoverInstanceMatrices(batch, target, offset), count);
  for (let index = 0; index < count * 16; index++) {
    const mine = target[offset + index];
    const three = expected[index];
    if (!Object.is(mine, three)) {
      const tuft = index >> 4;
      assert.fail(`tuft ${tuft} element ${index & 15}: ${mine} against ${three} (yaw ${batch.yaw[tuft]}, `
        + `scale ${batch.scale[tuft]}, at ${batch.x[tuft]}, ${batch.y[tuft]}, ${batch.z[tuft]})`);
    }
  }
  assert.ok(target.subarray(0, offset).every((value) => value === 7), "nothing written before the offset");
  assert.ok(target.subarray(offset + count * 16).every((value) => value === 7), "nor after the last tuft");
  assert.equal(writeGroundCoverInstanceMatrices(batch, new Float32Array(count * 16)), count, "the offset defaults to 0");
  assert.throws(() => writeGroundCoverInstanceMatrices(batch, new Float32Array(count * 16 - 1)), RangeError);
  assert.throws(() => writeGroundCoverInstanceMatrices(batch, target, offset + 9), RangeError);
  assert.throws(() => writeGroundCoverInstanceMatrices(batch, target, 0.5), RangeError);
  assert.equal(writeGroundCoverInstanceMatrices({ x: [], y: [], z: [], yaw: [], scale: [] }, new Float32Array(0)), 0);
  mesh.dispose();
});
