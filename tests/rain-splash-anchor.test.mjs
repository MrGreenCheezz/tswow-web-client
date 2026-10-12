// 12.10-7.21: a raindrop's splash stays where it landed while the character runs through the rain.
import assert from "node:assert/strict";
import test from "node:test";

import {
  RAIN_SPLASH_INNER_RADIUS, RAIN_SPLASH_INNER_SHARE, RAIN_SPLASH_RADIUS, RainSplashes, splashWindowOffset,
} from "../dist/code/browser/RainSplashes.js";

const rimFade = (radius, reach) => {
  const t = Math.max(0, Math.min(1, (radius / reach - 0.6) / 0.4));
  return 1 - t * t * (3 - 2 * t);
};

test("a splash's world position does not move with the window until its edge crosses it", () => {
  const half = RAIN_SPLASH_RADIUS;
  for (const seed of [0, 0.13, 0.5, 0.77, 0.999]) {
    const start = -9460.25;
    const world = start + splashWindowOffset(seed, start, half);
    let wrapped = 0;
    // A character running 7 yd/s for twenty seconds in sixtieths of a second.
    for (let step = 1; step <= 20 * 60; step++) {
      const centre = start + step * (7 / 60);
      const offset = splashWindowOffset(seed, centre, half);
      assert.ok(offset >= -half - 1e-9 && offset < half + 1e-9, `${offset} inside the window`);
      const position = centre + offset;
      const drift = position - world;
      // Either exactly where it landed, or a whole window away — the far side of the field.
      const periods = Math.round(drift / (2 * half));
      assert.ok(Math.abs(drift - periods * 2 * half) < 1e-6, `seed ${seed}: drifted ${drift}`);
      if (periods !== 0) {
        wrapped++;
        // It only ever reappears where the rim has it at zero alpha.
        const before = centre - 7 / 60 + splashWindowOffset(seed, centre - 7 / 60, half);
        if (Math.abs(before - position) > half) {
          assert.ok(rimFade(Math.abs(offset), half) < 1e-3, "a wrap is invisible");
          assert.ok(rimFade(Math.abs(before - (centre - 7 / 60)), half) < 1e-3);
        }
      }
    }
    assert.ok(wrapped > 0, "the field still covers the ground ahead after a long run");
  }
});

test("the window is a lattice over the world: the same seed at two centres agrees on the ground", () => {
  const half = RAIN_SPLASH_INNER_RADIUS;
  const a = 31.5 + splashWindowOffset(0.3, 31.5, half);
  const b = 35 + splashWindowOffset(0.3, 35, half);
  assert.ok(Math.abs(a - b) < 1e-9, `${a} and ${b}`);
  // Not an offset from the centre any more: the old field moved the splash with the feet.
  assert.notEqual(splashWindowOffset(0.3, 31.5, half), splashWindowOffset(0.3, 35, half));
  assert.equal(splashWindowOffset(Number.NaN, 10, half), 0);
  assert.equal(splashWindowOffset(0.5, 10, 0), 0);
});

test("the shader places slots by the same lattice and fades them to nothing at the window's edge", () => {
  const splashes = new RainSplashes();
  const shader = splashes.material.vertexShader;
  assert.ok(shader.includes("vec2 offset = mod( vec2( a, b ) * 2.0 * reach - uCentre + reach, 2.0 * reach ) - reach;"));
  assert.ok(shader.includes("vec2 xz = uCentre + offset;"));
  assert.ok(shader.includes("smoothstep( 0.6, 1.0, radius / reach )"));
  assert.ok(!/\bhalf\b/.test(shader.replace(/\/\/.*$/gm, "")), "`half` is reserved in GLSL ES");
  assert.ok(!shader.includes("cos( angle )"), "no polar offset around the feet");
  const uniforms = splashes.material.uniforms;
  assert.equal(uniforms.uInnerRadius.value, RAIN_SPLASH_INNER_RADIUS);
  assert.equal(uniforms.uInnerShare.value, RAIN_SPLASH_INNER_SHARE);
  assert.ok(RAIN_SPLASH_INNER_RADIUS < RAIN_SPLASH_RADIUS);
  assert.equal(rimFade(RAIN_SPLASH_RADIUS, RAIN_SPLASH_RADIUS), 0);
  splashes.dispose();
});
