// 22.10 (7.45): a flying character's rain splashes land on the ground below, not on a plane
// through their feet.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  RAIN_SPLASH_CELL, RAIN_SPLASH_GRID, RAIN_SPLASH_REGRID_YARDS, RainSplashes, splashesOnTerrain,
} from "../dist/code/browser/RainSplashes.js";

// WoW (x, y) → ground height: a slope plus ridges, so every cell differs.
const ground = (x, y) => 12 + 0.4 * x + 9 * Math.sin(y / 7);
const light = new THREE.Color(1, 1, 1);
const texture = new THREE.Texture();

/** Every grid cell holds the terrain under that cell's own centre. */
function assertFollowsTerrain(splashes, label) {
  const heights = splashes.heightTexture.image.data;
  const { x: cx, z: cz } = splashes.gridCentre;
  const originX = cx - (RAIN_SPLASH_GRID * RAIN_SPLASH_CELL) / 2;
  const originZ = cz - (RAIN_SPLASH_GRID * RAIN_SPLASH_CELL) / 2;
  for (let row = 0; row < RAIN_SPLASH_GRID; row += 5) {
    for (let column = 0; column < RAIN_SPLASH_GRID; column += 5) {
      const x = originX + (column + 0.5) * RAIN_SPLASH_CELL;
      const z = originZ + (row + 0.5) * RAIN_SPLASH_CELL;
      const expected = ground(x, -z);
      const got = heights[row * RAIN_SPLASH_GRID + column];
      assert.ok(Math.abs(got - expected) < 1e-3, `${label}: cell ${row},${column} at ${got}, ground ${expected}`);
    }
  }
}

test("a flyer high above the ground gets splashes on the terrain under each splash", () => {
  const splashes = new RainSplashes();
  const feet = new THREE.Vector3(100, 220, -40);
  splashes.update(feet, ground, 1 / 60, 0.9, texture, light, 1, true);
  assertFollowsTerrain(splashes, "first grid");
  const heights = splashes.heightTexture.image.data;
  assert.ok(heights.every((h) => h < 100), "nothing on a plane through the feet at 220");

  // Climbing while flying on: the rebuild must still finish (the feet's height no longer
  // restarts it every frame) and lay the new grid on the ground again.
  for (let frame = 1; frame <= 40; frame++) {
    feet.set(100 + frame * 0.5, 220 + frame * 2, -40);
    splashes.update(feet, ground, 1 / 60, 0.9, texture, light, 1, true);
  }
  assert.ok(splashes.gridCentre.x > 100 + RAIN_SPLASH_REGRID_YARDS - 1e-6, "the grid followed the flyer");
  assertFollowsTerrain(splashes, "after the climb");
  splashes.dispose();
});

test("standing on a WMO floor (not flying) still lays the field flat at the feet", () => {
  const splashes = new RainSplashes();
  const feet = new THREE.Vector3(100, 60, -40);
  splashes.update(feet, ground, 1 / 60, 0.9, texture, light, 1, false);
  const heights = splashes.heightTexture.image.data;
  assert.ok(heights.every((h) => h === 60));
  splashes.dispose();
});

test("the terrain rule: near the ground, flying above it, but not flying under it", () => {
  const underFeet = ground(10, 20);
  assert.equal(splashesOnTerrain(10, -20, underFeet + 0.5, ground), true);
  assert.equal(splashesOnTerrain(10, -20, underFeet + 30, ground), false);
  assert.equal(splashesOnTerrain(10, -20, underFeet + 30, ground, true), true);
  assert.equal(splashesOnTerrain(10, -20, underFeet - 30, ground, true), false);
  assert.equal(splashesOnTerrain(10, -20, underFeet + 30, () => undefined, true), false);
});
