// 15.11: the terrain horizon as read from Wow.exe 12340 (`TerrainHorizon.ts`): the gate, the buckets, the fill from a
// chunk's far edges (the lower end of each segment), and the box test that sees only nearer buckets. Not wired into the
// renderer: on the recorded frames it hides a group Wow.exe drew (portal5 report, "Horizon").

import assert from "node:assert/strict";
import test from "node:test";
import { TerrainHorizon, rint } from "../dist/code/browser/TerrainHorizon.js";

// Looking north (+x) from the origin, level; the projection's scales 1 and 1, near 0.2, far 1000.
const camera = (fz = 0) => ({ x: 0, y: 0, z: 0, fx: Math.sqrt(1 - fz * fz), fy: 0, fz, xScale: 1, yScale: 1, near: 0.2, far: 1000 });
/** A wall of nine points across the view at depth `x`, `height` high, from y = 40 to y = -40 (left to right). */
const wall = (x, height) => {
  const points = new Float64Array(18 * 3);
  for (let index = 0; index < 18; index++) {
    points[index * 3] = x;
    points[index * 3 + 1] = 40 - (index % 9) * 10;
    points[index * 3 + 2] = height;
  }
  return points;
};

test("rint rounds half to even, as fistp does", () => {
  assert.deepEqual([rint(0.5), rint(1.5), rint(2.5), rint(-0.5), rint(0.49), rint(0.51)], [0, 2, 2, 0, 0, 1]);
});

test("the gate: a camera pitched more than |0.9| fills and hides nothing", () => {
  const horizon = new TerrainHorizon();
  assert.equal(horizon.begin(camera(-0.95)), false);
  assert.equal(horizon.begin(camera(-0.5)), true);
  assert.equal(horizon.begin(camera(0), false), false, "the switch off");
});

test("buckets are 33.3 yards of depth along the level forward, by the nearest corner", () => {
  const horizon = new TerrainHorizon();
  horizon.begin(camera());
  assert.equal(horizon.bucketOf(-5, -1, 0, 5, 1, 1), 0, "around the eye");
  assert.equal(horizon.bucketOf(100, -1, 0, 110, 1, 1), 2, "rint(100 * 0.03 - 0.5) = rint(2.5), half to even");
  assert.equal(horizon.farBucketOf(100, -1, 110, 1), 3, "by the far corner, 110");
  assert.equal(horizon.bucketOf(3000, -1, 0, 3010, 1, 1), -1, "past the last bucket");
});

test("a wall hides a lower box behind it, only from the next bucket on, and never one nearer than 50", () => {
  const horizon = new TerrainHorizon();
  horizon.begin(camera());
  horizon.queueFill(2, wall(80, 20));
  horizon.run();
  // Behind the wall and lower than its line of sight: hidden. The wall is filled in bucket 2.
  assert.equal(horizon.boxHidden(200, -5, 0, 210, 5, 10, 6), true);
  assert.equal(horizon.boxHidden(200, -5, 0, 210, 5, 10, 2), false, "bucket 2 sees only buckets 0 and 1");
  assert.equal(horizon.boxHidden(200, -5, 0, 210, 5, 60, 6), false, "taller than the wall's sight line");
  assert.equal(horizon.boxHidden(200, 100, 0, 210, 110, 10, 6), false, "to the side of the wall");
  assert.equal(horizon.boxHidden(40, -5, -10, 45, 5, -5, 6), false, "a corner nearer than 50 is seen");
  assert.equal(horizon.sphereHidden(205, 0, 5, 3, 6), true);
});

test("a segment raises its columns to the lower of its two ends; a chunk with holes clears them", () => {
  const horizon = new TerrainHorizon();
  horizon.begin(camera());
  const points = wall(80, 20);
  points[4 * 3 + 2] = 0; // the middle point of both polylines is at eye height
  points[13 * 3 + 2] = 0;
  horizon.queueFill(1, points);
  horizon.run();
  // Straight ahead (column 192 is between points 3..5) the wall's line is the eye's: a box up to 5 high behind it shows.
  assert.equal(horizon.boxHidden(200, -1, 1, 210, 1, 5, 6), false);
  const reset = new TerrainHorizon();
  reset.begin(camera());
  reset.queueFill(1, wall(80, 20));
  reset.queueReset(2, 3, wall(90, 0));
  reset.run();
  assert.equal(reset.boxHidden(200, -5, 0, 210, 5, 10, 6), false, "the reset took the wall's columns back");
});
