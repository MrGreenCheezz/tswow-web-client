// 13.10 (7.04): the sun's and the moon's glare (`SkyGlare.ts`, update 0x7ef6e0 / draw 0x9ac400), the
// second moon's own colour, the horizon fade's replace rule, and the stars' warm-up hand-back.
// What this does NOT prove: the look against the original at sunrise / at the moon (14.25).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  MOON_GLARE, SUN_GLARE, glareAlpha, glareFacing, glareSize, glareStep, glareTarget,
  moonGlareCloudTerm, sunGlareCloudTerm,
} from "../dist/code/browser/SkyGlare.js";
import {
  CELESTIAL_FRAGMENT_SHADER, CLOUD_FRAGMENT_SHADER, SkyCelestials, createSkyCelestialInput, moon2Alpha,
} from "../dist/code/browser/SkyCelestials.js";
import { DayNightCloudTexture, createCloudShading } from "../dist/code/browser/SkyClouds.js"; // 23.10 (7.43)

const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

test("the two glare objects' numbers (0x7ee150, 0x7ee230)", () => {
  assert.deepEqual([SUN_GLARE.base, SUN_GLARE.sizeMin, SUN_GLARE.sizeMax, SUN_GLARE.alphaMin, SUN_GLARE.alphaMax, SUN_GLARE.rise],
    [1, 3, 20, 0.5, 1, 4]);
  assert.deepEqual([MOON_GLARE.base, MOON_GLARE.sizeMin, MOON_GLARE.sizeMax, MOON_GLARE.alphaMax], [2, 1, 1, 1]);
  assert.ok(near(SUN_GLARE.align, 0.7) && near(MOON_GLARE.alphaMin, 0.1) && near(MOON_GLARE.rise, 100 / 33, 1e-5));
  assert.ok(near(SUN_GLARE.fall, 50 / 33, 1e-6) && near(MOON_GLARE.fall, 50 / 33, 1e-6));
  assert.equal(SUN_GLARE.texture, "Textures\\sunGlare.blp");
  assert.equal(MOON_GLARE.texture, "Textures\\moonGlare.blp");
});

test("target: clouds, a drawn skybox and the day curve; the moon shines brightest through half cover", () => {
  assert.equal(sunGlareCloudTerm(0), 1);
  assert.equal(sunGlareCloudTerm(1), 0);
  assert.equal(moonGlareCloudTerm(0.5), 1);
  assert.equal(moonGlareCloudTerm(0), 0);
  assert.equal(moonGlareCloudTerm(1), 0);
  assert.equal(glareTarget(SUN_GLARE, 1, 0, 0.5), 1, "noon, clear");
  assert.equal(glareTarget(SUN_GLARE, 1, 1, 0.5), 0, "under a LightSkybox");
  assert.equal(glareTarget(SUN_GLARE, 1, 0, 0.25), 0, "before 06:30");
  assert.ok(near(glareTarget(SUN_GLARE, 1, 0, (0.2708333432674408 + 0.3125) / 2), 0.5));
  assert.equal(glareTarget(MOON_GLARE, 1, 0, 0), 1, "midnight");
  assert.equal(glareTarget(MOON_GLARE, 1, 0, 0.5), 0);
});

test("current follows the target at rise/fall per second, never past it", () => {
  assert.ok(near(glareStep(0, 1, SUN_GLARE, 0.1), 0.4));
  assert.equal(glareStep(0.9, 1, SUN_GLARE, 0.1), 1);
  assert.ok(near(glareStep(1, 0, SUN_GLARE, 0.1), 1 - 0.15151515));
  assert.equal(glareStep(0.1, 0, SUN_GLARE, 1), 0);
  assert.equal(glareStep(0.3, 0.3, SUN_GLARE, 1), 0.3);
  assert.equal(glareStep(0.3, 1, SUN_GLARE, -2), 0.3, "no time, no change");
});

test("facing: zero under the 0.7 cosine, one looking straight at it; size and alpha follow it", () => {
  assert.equal(glareFacing(SUN_GLARE, 0.2), 0);
  assert.equal(glareFacing(SUN_GLARE, 1), 1);
  assert.ok(near(glareFacing(SUN_GLARE, 0.85), 0.5, 1e-6));
  assert.equal(glareSize(SUN_GLARE, 0), 3);
  assert.equal(glareSize(SUN_GLARE, 1), 20);
  assert.equal(glareSize(MOON_GLARE, 0.4), 2);
  assert.equal(glareAlpha(SUN_GLARE, 1, 0, 1), Math.round(127.5) / 255);
  assert.equal(glareAlpha(SUN_GLARE, 1, 1, 1), 1);
  assert.equal(glareAlpha(SUN_GLARE, 0.5, 1, 0.5), Math.round(63.75) / 255, "storm alpha × current");
  assert.equal(glareAlpha(SUN_GLARE, 1, 1, 0.001), 0, "a byte of 0 draws nothing");
});

// 23.10 (7.43): 0x7efa30 reads the cloud texture's own alpha bytes under the body.
test("the glare's cloud cover is the cloud texture's alpha under the body", () => {
  const texture = new DayNightCloudTexture();
  const shading = createCloudShading();
  shading.densityByte = 0; // every level byte is over 0: cover everywhere
  for (let frame = 0; frame < 16; frame++) texture.update(0.01, shading);
  const covered = texture.densityAt(0.5, 0.5);
  assert.ok(covered > 0.5, `zenith cover ${covered}`);
  assert.equal(texture.densityAt(0.5, 0.5), texture.densities[64 * 128 + 64] * 0.0039215689);
  assert.equal(texture.densityAt(-3, 9), texture.densities[127 * 128] * 0.0039215689, "clamped to the edge like the client");
  shading.densityByte = 255; // no level reaches 255
  for (let frame = 0; frame < 16; frame++) texture.update(0.01, shading);
  assert.equal(texture.densityAt(0.5, 0.5), 0);
  assert.ok(CLOUD_FRAGMENT_SHADER.includes("texture2D(cloudMap"));
});

function source(ready = true) {
  const loaded = [];
  return {
    loaded,
    load: (path) => { loaded.push(path); const texture = new THREE.Texture(); texture.userData.path = path; return texture; },
    ready: () => ready,
  };
}

test("the sun glare ramps up while looking at it, gives way to the post sun and to a skybox", () => {
  const sky = new SkyCelestials();
  sky.setTextureSource(source());
  const input = createSkyCelestialInput();
  input.enabled = true;
  input.time = 1440;
  input.sunColour = 0xffeedd;
  const camera = new THREE.Vector3();
  const sun = sky.frame.sun;
  const step = (seconds) => { input.seconds = seconds; sky.update(input, camera); };
  step(0);
  input.viewX = sun.x; input.viewY = sun.y; input.viewZ = sun.z; // look straight at it
  step(0);
  const glare = sky.group.getObjectByName("skySunGlare");
  assert.equal(glare.visible, false, "current is still 0");
  step(0.1);
  assert.equal(glare.visible, true);
  assert.ok(near(glare.material.uniforms.celestialOpacity.value, Math.round(0.4 * 255) / 255, 1e-9));
  assert.ok(near(glare.material.uniforms.celestialSize.value, 20 * 700 / 12, 1e-6), "full size looking straight at it");
  assert.equal(glare.material.blending, THREE.CustomBlending);
  assert.equal(glare.material.blendDst, THREE.OneFactor);
  step(0.5);
  assert.equal(glare.material.uniforms.celestialOpacity.value, 1);
  input.postSun = true;
  step(0.6);
  assert.equal(glare.visible, false, "one sun");
  input.postSun = false;
  input.skyboxPresent = true;
  step(0.7);
  assert.ok(near(glare.material.uniforms.celestialOpacity.value, Math.round((1 - 0.15151515) * 255) / 255, 1e-9),
    "a skybox takes the target to 0; current falls at 1.515/s");
  input.enabled = false;
  step(0.8);
  input.enabled = true;
  input.skyboxPresent = false;
  step(0.8);
  assert.equal(sky.group.getObjectByName("skySunGlare").visible, false, "re-enabled from 0");
  sky.dispose();
});

test("the second moon is black and transparent until a storm, then a disc of the storm's last alpha", () => {
  assert.equal(moon2Alpha(0, 0), 0);
  assert.equal(moon2Alpha(0, 0.25), Math.round(0.75 * 255) / 255);
  assert.equal(moon2Alpha(0.75, 0), 0.75, "kept after the storm");
  const sky = new SkyCelestials();
  sky.setTextureSource(source());
  const input = createSkyCelestialInput();
  input.enabled = true;
  input.sunColour = 0xffffff; // band 9 tints the other two bodies, never this one
  const camera = new THREE.Vector3();
  let shownAt;
  for (let time = 0; time < 2880 && shownAt === undefined; time += 30) {
    input.time = time;
    sky.update(input, camera);
    if (sky.group.getObjectByName("skyMoon2").visible) shownAt = time;
  }
  assert.ok(shownAt !== undefined, "the second moon is above the horizon at some time of the day");
  const moon2 = sky.group.getObjectByName("skyMoon2");
  assert.equal(moon2.material.uniforms.celestialOpacity.value, 0);
  assert.deepEqual(moon2.material.uniforms.celestialColour.value.toArray(), [0, 0, 0]);
  input.storm = 0.4;
  sky.update(input, camera);
  input.storm = 0;
  sky.update(input, camera);
  assert.equal(moon2.material.uniforms.celestialOpacity.value, Math.round(0.6 * 255) / 255);
  sky.dispose();
});

test("the horizon fade replaces the body's alpha (0x7edee0), and the stars leave the warm-up", async () => {
  assert.match(CELESTIAL_FRAGMENT_SHADER, /float alpha = texel\.a \* \(height < 1\.0 \? height : celestialOpacity\);/);
  const sky = new SkyCelestials();
  const removed = [];
  sky.onStarsRemoved = (node) => removed.push(node);
  const node = new THREE.Group();
  sky.setStars(node, []);
  sky.clearStars();
  assert.deepEqual(removed, [node]);
  sky.clearStars();
  assert.equal(removed.length, 1, "only a node that was there");
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /this\.#skyCelestials\.onStarsRemoved = \(node\) => this\.#skyWarmup\.unregisterObject\(node\);/);
  sky.dispose();
});
