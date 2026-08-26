import assert from "node:assert/strict";
import test from "node:test";
import { sunDirection } from "../dist/code/browser/WorldRenderer3D.js";

/** Half-minutes of a game day, which is what the light bands are keyed on. */
const hour = (h) => h * 120;
const elevation = (v) => Math.asin(v.y) * 180 / Math.PI;
/** How much a wall facing this way is lit. Four walls, one for each horizontal direction. */
const walls = (v) => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => Math.max(0, v.x * x + v.z * z));
const lit = (v) => walls(v).filter((value) => value > 0.001).length;

test("the source never goes below the horizon", () => {
  for (let time = 0; time < 2880; time += 10) {
    assert.ok(sunDirection(time).y > 0, `y must stay positive at ${time}`);
  }
});

test("the source is never straight overhead, which is what left every wall unlit", () => {
  // Midnight and noon are the two times the east-west term vanishes, and both used to normalise to
  // (0, 1, 0). A vertical face then gets N·L of exactly zero and the whole of the light lands on
  // the ground: that is the black silhouette against a lit street.
  for (const time of [hour(0), hour(12)]) {
    const direction = sunDirection(time);
    assert.ok(elevation(direction) < 85, `still at the pole at ${time}: ${elevation(direction)}`);
    assert.equal(lit(direction), 1, "at least one wall has to catch the light");
  }
  // And at every other hour too.
  for (let time = 0; time < 2880; time += 10) {
    assert.ok(lit(sunDirection(time)) >= 1, `no wall lit at ${time}`);
  }
});

test("dawn and dusk keep the low sun they had, and the arc keeps its direction", () => {
  // The floor and the east-west arc are unchanged by the tilt: 06:00 and 18:00 are the hours where
  // the tilt term is zero, so these are the numbers the old vector produced exactly.
  assert.ok(Math.abs(elevation(sunDirection(hour(6))) - 12.4) < 0.2);
  assert.ok(Math.abs(elevation(sunDirection(hour(18))) - 12.4) < 0.2);
  // Sunrise comes out of +Z and sunset goes into -Z.
  assert.ok(sunDirection(hour(6)).z > 0.9);
  assert.ok(sunDirection(hour(18)).z < -0.9);
  // Noon is high but not at the pole; midnight is the floor plus the tilt.
  assert.ok(elevation(sunDirection(hour(12))) > 65);
  assert.ok(elevation(sunDirection(hour(0))) > 25 && elevation(sunDirection(hour(0))) < 40);
});

test("the vector is a unit vector at every hour", () => {
  for (let time = 0; time < 2880; time += 37) {
    const { x, y, z } = sunDirection(time);
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-9, `not normalised at ${time}`);
  }
});
