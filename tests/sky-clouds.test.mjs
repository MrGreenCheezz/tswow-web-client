// 23.10 (7.43): the day-night clouds as Wow.exe 12340 builds them (`SkyClouds.ts`): the tables read
// out of the executable, the texture's noise, alpha and point-light shading, the dome, and the
// renderer's hand-over. The owner's complaint was clouds "black from the shadows": with Stormwind's
// golden-hour bands (band 12 black) no visible cloud texel may come out dark any more.
// What this does NOT prove: the look against the original on screen (LIVE_CHECKS «Облака»).

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  CLOUD_OCTAVES, CLOUD_OCTAVE_STEPS, CLOUD_PERMUTATION, CLOUD_RING_ALPHA, CLOUD_RING_POLAR, CLOUD_TEXTURE_SIZE,
  DayNightCloudTexture, buildCloudDomeGeometry, cloudDensityByte, cloudDomeUv, cloudFadeTable, cloudLatticeValues,
  cloudSharpnessTable, createCloudShading, fistp, setCloudBands,
} from "../dist/code/browser/SkyClouds.js";
import { SkyCelestials, createSkyCelestialInput } from "../dist/code/browser/SkyCelestials.js";

const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const luminance = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];

test("7.43 the tables are Wow.exe's (0xaf4a70, 0xaf4dc4, 0x7f04b0, 0xa41aac, 0xa41ad4, 0xa41b04)", () => {
  assert.equal(CLOUD_PERMUTATION.length, 256);
  assert.deepEqual([...CLOUD_PERMUTATION].sort((a, b) => a - b), Array.from({ length: 256 }, (_, i) => i), "a permutation");
  assert.deepEqual([...CLOUD_PERMUTATION.slice(0, 4)], [225, 155, 210, 108]);
  assert.deepEqual([...CLOUD_PERMUTATION.slice(252)], [105, 97, 204, 52]);
  assert.equal(CLOUD_OCTAVES, 4);
  assert.deepEqual(CLOUD_OCTAVE_STEPS, [16, 32, 64, 128], "8, 16, 32, 64 cells across 128 texels");
  assert.equal(CLOUD_TEXTURE_SIZE, 128);
  assert.equal(CLOUD_RING_POLAR.length, 12);
  assert.equal(CLOUD_RING_POLAR.at(-1), 0.25, "the last ring is the horizon of the lowered sphere");
  assert.deepEqual(CLOUD_RING_ALPHA, [255, 255, 255, 255, 255, 255, 255, 255, 255, 128, 0, 0]);
});

test("7.43 lattice, fade and sharpness tables (0x7ed250, 0x7edb50)", () => {
  const lattice = cloudLatticeValues(1);
  // The C runtime's rand() from seed 1 starts 41, 18467, 6334.
  assert.ok(near(lattice[0], 1 - 2 * 41 / 32767, 1e-6));
  assert.ok(near(lattice[1], 1 - 2 * 18467 / 32767, 1e-6));
  assert.ok(near(lattice[2], 1 - 2 * 6334 / 32767, 1e-6));
  assert.ok(lattice.every((v) => v >= -1 && v <= 1));
  const fade = cloudFadeTable();
  assert.equal(fade[0], 0);
  assert.ok(near(fade[128], 0.5, 1e-6));
  assert.ok(near(fade[255], (1 - Math.cos(255 * Math.PI / 256)) / 2, 1e-6));
  const sharp = cloudSharpnessTable();
  assert.equal(cloudDensityByte(0.6000000238418579), 102, "built at the start-up density 0.6");
  assert.equal(sharp[0], 0);
  assert.equal(sharp[1], 6);
  assert.equal(sharp[28], 126, "half alpha ≈ 28 level steps over the threshold: soft edges");
  assert.equal(sharp[255], 254);
  for (let i = 1; i < 256; i++) assert.ok(sharp[i] >= sharp[i - 1]);
  assert.equal(cloudDensityByte(0.5), 128);
  assert.equal(cloudDensityByte(2), 1, "a band over 1 wraps as the client's byte");
  assert.equal(fistp(2.5), 2);
  assert.equal(fistp(3.5), 4);
});

test("7.43 a direction maps onto the texture like 0x7eda90 + 0x7ef920", () => {
  const uv = [0, 0];
  cloudDomeUv(0, 1, 0, uv);
  assert.ok(near(uv[0], 0.5) && near(uv[1], 0.5), "the zenith is the middle");
  cloudDomeUv(1, 0, 0, uv); // scene +x = world x, on the horizon
  assert.ok(near(uv[0], 1, 1e-6) && near(uv[1], 0.5, 1e-6), `horizon → edge ${uv}`);
  cloudDomeUv(0, 0, -1, uv); // scene −z = world +y
  assert.ok(near(uv[0], 0.5, 1e-6) && near(uv[1], 1, 1e-6), `world y → v ${uv}`);
  cloudDomeUv(0.3, -0.9, 0, uv); // under the horizon: clamped to the dome's edge
  assert.ok(near(uv[0], 1, 1e-6));
  cloudDomeUv(Math.sin(0.4), Math.cos(0.4), 0, uv);
  assert.ok(uv[0] > 0.5 && uv[0] < 1 && near(uv[1], 0.5), "between");
});

/** Stormwind (Light params 79) at 19:30: band 10 ffd29c, band 11 7a5f52, band 12 black; low sun. */
function goldenHour(lightHeight = 64) {
  const shading = createCloudShading();
  setCloudBands(shading, 0xffd29c, 0x7a5f52, 0x000000);
  shading.lightU = 0.78 * 128;
  shading.lightV = 0.78 * 128;
  shading.lightHeight = lightHeight;
  shading.densityByte = cloudDensityByte(0.5);
  const texture = new DayNightCloudTexture();
  for (let frame = 0; frame < 16; frame++) texture.update(0.01, shading);
  return texture;
}

test("7.43 golden hour in Stormwind: no visible cloud texel is dark, thick cloud shades darker", () => {
  const texture = goldenHour();
  const px = texture.pixels;
  let darkest = 255, thick = 0, thickCount = 0, thin = 0, thinCount = 0, covered = 0;
  for (let row = 0; row < 128; row++) {
    for (let col = 0; col < 128; col++) {
      const i = (row * 128 + col) * 4;
      // The dome shows the disc of radius 0.41 at full alpha (rings to 0x00a41b04's 128).
      if (Math.hypot((col + 0.5) / 128 - 0.5, (row + 0.5) / 128 - 0.5) >= 0.41) continue;
      const alpha = px[i + 3];
      if (alpha >= 128) { darkest = Math.min(darkest, luminance(px, i)); covered++; }
      // Density 0.5 tops out at alpha 241 (level 248): the client's clouds are never quite opaque.
      if (alpha >= 190) { thick += luminance(px, i); thickCount++; }
      if (alpha >= 40 && alpha < 120) { thin += luminance(px, i); thinCount++; }
    }
  }
  assert.ok(covered > 500, `clouds cover part of the dome (${covered})`);
  assert.ok(darkest >= 100, `darkest visible cloud texel luminance ${darkest.toFixed(1)} (black was ≈ 25)`);
  assert.ok(thickCount > 0 && thinCount > 0);
  assert.ok(thick / thickCount < thin / thinCount, "the thickness shade: cores darker than thin edges");
});

test("7.43 the field drifts with the animation frame and the alpha ramp is soft", () => {
  const shading = createCloudShading();
  shading.densityByte = cloudDensityByte(0.5);
  const texture = new DayNightCloudTexture();
  for (let frame = 0; frame < 16; frame++) texture.update(0.01, shading);
  assert.equal(texture.frame, 0);
  const before = Uint8Array.from(texture.densities);
  for (let frame = 0; frame < 16; frame++) texture.update(1 / 16, shading); // +1 s: frame 2 at the pass end
  assert.equal(texture.frame, 2);
  for (let frame = 0; frame < 16; frame++) texture.update(0.001, shading); // the next pass is written at frame 2
  let changed = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== texture.densities[i]) changed++;
  assert.ok(changed > 0 && changed < before.length / 2, `a slow drift (${changed} texels)`);
  // Soft edges: many partial alphas, not a step.
  const partial = texture.densities.filter((a) => a > 10 && a < 200).length;
  const solid = texture.densities.filter((a) => a >= 200).length;
  assert.ok(partial > solid / 2, `partial ${partial} vs solid ${solid}`);
});

test("7.43 the dome is the client's (0x7f20e0): 12 rings × 16, horizon at the last ring", () => {
  const geometry = buildCloudDomeGeometry(1);
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const alpha = geometry.getAttribute("cloudAlpha");
  assert.equal(position.count, 1 + 11 * 16);
  assert.ok(near(position.getY(0), 1 - Math.cos(Math.PI / 4), 1e-6), "the top");
  assert.ok(near(uv.getX(0), 0.5) && near(uv.getY(0), 0.5));
  const last = position.count - 1;
  assert.ok(near(position.getY(last), 0, 1e-6), "the last ring sits on the camera's horizon");
  assert.ok(near(Math.hypot(uv.getX(last) - 0.5, uv.getY(last) - 0.5), 0.5, 1e-6));
  assert.equal(alpha.getX(last), 0);
  assert.ok(near(alpha.getX(1 + 7 * 16), 1) && near(alpha.getX(1 + 8 * 16), 128 / 255), "ring 8 full, ring 9 half");
  assert.equal(geometry.getIndex().count, 16 * 3 + 10 * 16 * 6);
});

test("7.43 the renderer hands the client's lighting over: moon at night, storm lifts and dims the light", () => {
  const sky = new SkyCelestials();
  const input = createSkyCelestialInput();
  const camera = new THREE.Vector3();
  input.enabled = true;
  input.cloudDensity = 0.5;
  input.sunHalo = 0xffd29c; input.cloudA = 0x7a5f52; input.cloudB = 0;
  input.time = 2340;
  for (let frame = 0; frame < 17; frame++) { input.seconds = frame / 60; sky.update(input, camera); }
  const clouds = sky.group.getObjectByName("skyClouds");
  const map = clouds.material.uniforms.cloudMap.value;
  assert.equal(map.image.data, sky.cloudTexture.pixels, "a finished pass is on the GPU texture");
  assert.ok(map.version > 1);
  assert.equal(sky.cloudShading.lightHeight, 64);
  assert.equal(sky.cloudShading.intensity, 1);
  const sunU = sky.cloudShading.lightU;
  assert.ok(sunU > 64, `the 19:30 sun's spot is toward its bearing (${sunU})`);
  input.storm = 1;
  sky.update(input, camera);
  assert.equal(sky.cloudShading.lightHeight, 256, "64 + 192 · storm");
  assert.equal(sky.cloudShading.intensity, 0.25, "1 − 0.75 · storm");
  input.storm = 0;
  input.time = 0; // midnight: the moon (35° off the zenith) lights them
  sky.update(input, camera);
  assert.notEqual(sky.cloudShading.lightU, sunU);
  sky.dispose();
});
