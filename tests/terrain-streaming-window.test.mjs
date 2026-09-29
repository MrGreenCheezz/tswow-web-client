import assert from "node:assert/strict";
import test from "node:test";
import { TERRAIN_GRID_SIZE } from "../dist/code/browser/Terrain.js";
import { TerrainStreamingWindow, TERRAIN_RETAINED_LIMIT, terrainTileKey } from "../dist/code/browser/TerrainStreaming.js";

const position = (grid, fraction = 0.5) => (32 - grid - fraction) * TERRAIN_GRID_SIZE;
const at = (window, gx, gy, fx = 0.5, fy = 0.5, map = 0, speculative = true) =>
  window.update(map, position(gx, fx), position(gy, fy), speculative);
const keys = grids => new Set(grids.map(grid => terrainTileKey(0, grid)));

test("steady movement shares the plan and keeps the visible 3x3 unchanged", () => {
  const window = new TerrainStreamingWindow();
  const first = at(window, 32, 32);
  assert.equal(first.visible.length, 9);
  assert.deepEqual(first.visible[0], { x: 32, y: 32 });
  assert.equal(first.prepare.length, 0);
  assert.equal(first.dependencies.length, 25);
  assert.equal(at(window, 32, 32, 0.55, 0.45), first);
});

test("each approach row is ready before a crossing and the return keeps the old tiles", () => {
  for (const [dx, dy] of [[1,0], [-1,0], [0,1], [0,-1], [1,1], [-1,-1], [1,-1], [-1,1]]) {
    const window = new TerrainStreamingWindow();
    const before = at(window, 32, 32, dx > 0 ? 0.9 : dx < 0 ? 0.1 : 0.5,
      dy > 0 ? 0.9 : dy < 0 ? 0.1 : 0.5);
    assert.equal(before.visible.length, 9);
    assert.equal(before.prepare.length, dx && dy ? 7 : 3);
    const ready = keys([...before.visible, ...before.prepare]);
    const crossed = at(window, 32 + dx, 32 + dy, dx > 0 ? 0.02 : dx < 0 ? 0.98 : 0.5,
      dy > 0 ? 0.02 : dy < 0 ? 0.98 : 0.5);
    assert.ok(crossed.visible.every(grid => ready.has(terrainTileKey(0, grid))), "crossing needs no unprepared mesh");
    assert.ok(before.visible.every(grid => crossed.retainedKeys.has(terrainTileKey(0, grid))), "return keeps earlier borrowers alive");
  }
});

test("long walks and teleports retain at most 25 meshes with pinned sampling dependencies", () => {
  const window = new TerrainStreamingWindow();
  for (let step = 0; step < 120; step++) {
    const plan = at(window, (step * 13) % 64, (step * 7) % 64, 0.92, 0.08);
    assert.ok(plan.retained.length <= TERRAIN_RETAINED_LIMIT);
    assert.ok(plan.dependencies.length <= 45, "pins stay below the 64-entry CPU cache");
    const dependencies = keys(plan.dependencies);
    assert.ok(plan.retained.every(grid => dependencies.has(terrainTileKey(0, grid))));
    for (const grid of [...plan.visible, ...plan.prepare]) {
      assert.ok(plan.retainedKeys.has(terrainTileKey(0, grid)));
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const neighbour = {x:grid.x+ox, y:grid.y+oy};
        if (neighbour.x < 0 || neighbour.x >= 64 || neighbour.y < 0 || neighbour.y >= 64) continue;
        assert.ok(dependencies.has(terrainTileKey(0, neighbour)), "every normal and water corner has a pinned owner");
      }
    }
  }
  const origin = new TerrainStreamingWindow();
  const old = at(origin, 32, 32);
  at(origin, 42, 42);
  const distant = at(origin, 52, 52);
  assert.ok([...old.visibleKeys].some(key => !distant.retainedKeys.has(key)), "oldest history is evicted");
});

test("map changes, invalid positions and explicit clear drop old history", () => {
  const window = new TerrainStreamingWindow();
  at(window, 32, 32);
  const next = at(window, 42, 42, 0.5, 0.5, 1);
  assert.equal(next.retained.length, 9);
  assert.ok([...next.retainedKeys].every(key => key.startsWith("1/")));
  assert.equal(window.update(1, Number.NaN, 0), undefined);
  assert.equal(at(window, 32, 32).retained.length, 9);
  window.clear();
  assert.equal(at(window, 52, 52).retained.length, 9);
});

test("formal capture mode removes speculative work and resident history", () => {
  const window = new TerrainStreamingWindow();
  at(window, 32, 32, 0.9, 0.9);
  at(window, 33, 33);
  const capture = at(window, 33, 33, 0.9, 0.9, 0, false);
  assert.equal(capture.prepare.length, 0);
  assert.equal(capture.retained.length, 9);
  assert.equal(capture.dependencies.length, 25);
  assert.notEqual(at(window, 33, 33, 0.9, 0.9), capture);
});
