// 15.11 (sky8, 7.04): the glare's occlusion and the light it takes away, as Wow.exe 12340 has them — the occlusion
// (vtable +8 = 0x009ac3c0: the query 0x009abe00 or the ray 0x009abc60) asked only for a target that is not 0, the
// glare's +0xa4 = max(view · toGlare, 0.7)^10 × current (0x007ef911), and the next light build's
// round((1 − 0.35 × it) × 255) on the ambient and direct bytes (0x007816f0, 0.35 at 0x00a3e860).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  GLARE_LIGHT_DIMMING, SUN_GLARE, dimLightSampleByGlare, glareDimming, glareLightByte, occludedGlareTarget,
} from "../dist/code/browser/SkyGlare.js";
import { glareOnScreen, glareRayClear, glareRays, sceneToWorldDirection } from "../dist/code/browser/SkyGlareOcclusion.js";
import { SkyCelestials, createSkyCelestialInput } from "../dist/code/browser/SkyCelestials.js";

const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

test("the dimming: the facing cosine to the tenth, times current; the light byte it leaves", () => {
  assert.equal(glareDimming(SUN_GLARE, 1, 1), 1, "straight at a full glare");
  assert.ok(near(glareDimming(SUN_GLARE, -1, 1), Math.pow(0.699999988079071, 10)), "looking away: 0.7^10");
  assert.ok(near(glareDimming(SUN_GLARE, 0.9, 0.5), Math.pow(0.9, 10) * 0.5));
  assert.equal(glareDimming(SUN_GLARE, 1, 0), 0, "no glare, no dimming");
  assert.ok(near(GLARE_LIGHT_DIMMING, 0.35, 1e-7));
  assert.equal(glareLightByte(0), 255);
  assert.equal(glareLightByte(1), Math.round(0.6500000059604645 * 255));
  // Looking away from a full glare still takes the byte to 252 — two levels of 176.
  assert.equal(glareLightByte(Math.pow(0.699999988079071, 10)), 252);
});

test("the dimmed light: ambient and direct only, the same object when nothing is taken", () => {
  const colour = (r, g, b) => ({ r, g, b });
  const sample = {
    colours: { ambient: colour(0.4, 0.5, 0.6), diffuse: colour(1, 0.8, 0.6), fog: colour(0.3, 0.3, 0.3) },
    fogEnd: 500,
  };
  assert.equal(dimLightSampleByGlare(sample, 0), sample);
  const dimmed = dimLightSampleByGlare(sample, 1);
  const factor = glareLightByte(1) / 255;
  assert.ok(near(dimmed.colours.ambient.g, 0.5 * factor) && near(dimmed.colours.diffuse.r, factor));
  assert.equal(dimmed.colours.fog, sample.colours.fog, "the fog is not the light 0x007816f0 scales");
  assert.equal(sample.colours.diffuse.r, 1, "the page's sample is left alone");
});

test("the occlusion is asked only of a target that is not 0", () => {
  assert.equal(occludedGlareTarget(0, 1), 0);
  assert.equal(occludedGlareTarget(0.8, 0), 0);
  assert.equal(occludedGlareTarget(0.8, 1), 0.8);
});

test("the ray: the ground and the models between the eye and the far clip hide the glare (0x009abc60)", () => {
  const eye = { x: 0, y: 0, z: 2 };
  const flat = { heightAt: () => 0 };
  assert.equal(glareRayClear(eye, { x: 0.6, y: 0, z: 0.8 }, 1277, flat), true, "open sky over flat ground");
  const ridge = { heightAt: (x) => (x > 300 && x < 320 ? 400 : 0) };
  assert.equal(glareRayClear(eye, { x: 0.8, y: 0, z: 0.6 }, 1277, ridge), false, "a ridge 300 yards out, 400 high");
  assert.equal(glareRayClear(eye, { x: 0.6, y: 0, z: 0.8 }, 1277, ridge), true, "over its top");
  assert.equal(glareRayClear(eye, { x: 0.8, y: 0, z: 0.6 }, 200, ridge), true, "past the far clip it does not count");
  let asked;
  const roof = { heightAt: () => undefined, firstHit: (from, to) => { asked = [from, to]; return { t: 0.01 }; } };
  assert.equal(glareRayClear(eye, { x: 0, y: 0, z: 1 }, 1277, roof), false, "a roof");
  assert.ok(near(asked[0].z, 2.5) && near(asked[1].z, 1279), "from half a yard out to the far clip");
});

test("the page's rays follow the client's sun and moon, and ask nothing of a glare that cannot show", () => {
  const out = { sun: -1, moon: -1 };
  const everything = { heightAt: () => 1e6 };
  glareRays(1440, { x: 0, y: 0, z: 0 }, 1277, everything, out);
  assert.deepEqual(out, { sun: 0, moon: 1 }, "noon: the sun is asked, the moon's day curve is 0");
  glareRays(0, { x: 0, y: 0, z: 0 }, 1277, everything, out);
  assert.deepEqual(out, { sun: 1, moon: 0 }, "midnight");
  const world = sceneToWorldDirection({ x: 0.1, y: 0.9, z: -0.3 }, { x: 0, y: 0, z: 0 });
  assert.deepEqual(world, { x: 0.1, y: 0.3, z: 0.9 }, "scene (x, z, −y) back to world (x, y, z)");
});

test("off the screen counts nothing, as the query's pixels do", () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 2000);
  camera.position.set(5, 3, 1);
  camera.lookAt(5, 3, 0);
  camera.updateMatrixWorld(true);
  assert.equal(glareOnScreen(camera, { x: 0, y: 0, z: -1 }), true, "straight ahead");
  assert.equal(glareOnScreen(camera, { x: 0, y: 0, z: 1 }), false, "behind");
  assert.equal(glareOnScreen(camera, { x: 0, y: 1, z: 0 }), false, "overhead, out of a 60° view");
});

test("in the sky: a hidden sun never builds a glare and takes no light; a visible one does", () => {
  const sky = new SkyCelestials();
  const input = createSkyCelestialInput();
  input.enabled = true;
  input.time = 1440;
  input.sunColour = 0xffeedd;
  const position = new THREE.Vector3();
  const sun = sky.frame.sun;
  const step = (seconds) => { input.seconds = seconds; sky.update(input, position); };
  step(0);
  input.viewX = sun.x; input.viewY = sun.y; input.viewZ = sun.z; // look straight at it
  input.sunRay = 0;
  for (let second = 1; second <= 3; second++) step(second);
  assert.equal(sky.sunGlareDimming, 0, "behind the world");
  input.sunRay = 1;
  // The camera looks at the sun as well: on the screen.
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 2000);
  camera.lookAt(sun.x, sun.y, sun.z);
  camera.updateMatrixWorld(true);
  input.camera = camera;
  for (let second = 4; second <= 6; second++) step(second);
  assert.ok(near(sky.sunGlareDimming, 1, 1e-6), `straight into a clear sun, got ${sky.sunGlareDimming}`);
  // Turned away, the sun off the screen: the target falls to 0 and so does the dimming.
  camera.lookAt(-sun.x, -sun.y, -sun.z);
  camera.updateMatrixWorld(true);
  input.viewX = -sun.x; input.viewY = -sun.y; input.viewZ = -sun.z;
  for (let second = 7; second <= 9; second++) step(second);
  assert.equal(sky.sunGlareDimming, 0);
  input.enabled = false;
  step(10);
  assert.equal(sky.sunGlareDimming, 0);
  sky.dispose();
});
