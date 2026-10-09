// 05.10-sun (7.04, 7.07): on the classic preset (lighting quality 0) the key light and the visible
// sun follow Wow.exe 12340 — one fixed north-west bearing (45°), the key light's elevation a
// triangle between 37° (00:00, 12:00) and 20° (06:00, 18:00) from the table 0x7eea90 fills, and
// the sun body rising ~06:10 and setting ~20:30 on that same bearing. Enhanced/cinematic keep
// `sunDirection` / `godRaySunDirection` (pinned by sun.test.mjs and god-rays.test.mjs).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  KEY_LIGHT_AZIMUTH, KEY_LIGHT_POLAR, classicKeyLightDirection, classicSunDirection,
} from "../dist/code/browser/ClassicSun.js";
import { computeCelestialFrame, createCelestialFrame } from "../dist/code/browser/SkyCelestials.js";

const hour = (h) => h * 120;
const deg = (radians) => radians * 180 / Math.PI;
const elevation = (v) => deg(Math.asin(v.y));
const near = (a, b, eps, message) => assert.ok(Math.abs(a - b) <= eps, `${message}: ${a} vs ${b}`);
const f32 = (value) => Math.fround(value);

test("the key-light tables are the client's (0x7eea90: four keys, 127°/110° polar, 225° azimuth)", () => {
  assert.deepEqual([...KEY_LIGHT_POLAR].map(f32), [0, 2.2165682315826416, 0.25, 1.9198622703552246,
    0.5, 2.2165682315826416, 0.75, 1.9198622703552246].map(f32));
  assert.deepEqual([...KEY_LIGHT_AZIMUTH].map(f32), [0, 3.9269909858703613, 0.25, 3.9269909858703613,
    0.5, 3.9269909858703613, 0.75, 3.9269909858703613].map(f32));
});

test("the key light stands north-west at 37° at midnight and noon, 20° at 06:00 and 18:00", () => {
  const v = { x: 0, y: 0, z: 0 };
  for (const [h, want] of [[0, 37], [6, 20], [12, 37], [18, 20], [3, 28.5], [15, 28.5], [24, 37]]) {
    classicKeyLightDirection(hour(h), v);
    near(elevation(v), want, 1e-3, `elevation at ${h}:00`);
    // Scene: +X north, +Z east. North-west is +X and −Z in equal parts.
    assert.ok(v.x > 0 && v.z < 0, `north-west at ${h}:00`);
    near(v.x, -v.z, 1e-6, `45° bearing at ${h}:00`);
    near(Math.hypot(v.x, v.y, v.z), 1, 1e-9, `unit at ${h}:00`);
  }
});

test("the key light never pops: no switch at dusk or dawn, never under the ground", () => {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  classicKeyLightDirection(0, a);
  let worst = 0;
  for (let time = 1; time <= 2880; time++) {
    classicKeyLightDirection(time, b);
    worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
    assert.ok(b.y > 0.3, `above the ground at ${time}`);
    a.x = b.x; a.y = b.y; a.z = b.z;
  }
  // 17° over 720 half-minutes: well under a thousandth of a radian per half-minute.
  assert.ok(worst < 1e-3, `largest step ${worst}`);
  assert.ok(Number.isFinite(classicKeyLightDirection(Number.NaN, b).y));
});

test("the visible sun is the sky's own body: same bearing, up ~06:10, down ~20:30", () => {
  const sun = { x: 0, y: 0, z: 0 };
  const frame = createCelestialFrame();
  for (let time = 0; time < 2880; time += 7) {
    classicSunDirection(time, sun);
    computeCelestialFrame(time / 2880, 0, frame);
    near(sun.x, frame.sun.x, 1e-12, `x at ${time}`);
    near(sun.y, frame.sun.y, 1e-12, `y at ${time}`);
    near(sun.z, frame.sun.z, 1e-12, `z at ${time}`);
  }
  assert.ok(classicSunDirection(hour(6.1), sun).y < 0, "06:06 still down");
  assert.ok(classicSunDirection(hour(6.25), sun).y > 0, "06:15 up");
  assert.ok(classicSunDirection(hour(20.45), sun).y > 0, "20:27 still up");
  assert.ok(classicSunDirection(hour(20.6), sun).y < 0, "20:36 down");
  classicSunDirection(hour(9), sun);
  const key = classicKeyLightDirection(hour(9), { x: 0, y: 0, z: 0 });
  near(Math.atan2(-sun.z, sun.x), Math.atan2(-key.z, key.x), 1e-6, "the drawn sun and the shading share one bearing");
  assert.ok(classicSunDirection(hour(0), sun).y < 0, "midnight: no sun, so no classic shafts from it");
});

test("renderer hooks: quality 0 takes the client's key light and sun, the others keep theirs", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const update = source.slice(source.indexOf("  updateLighting(sample"), source.indexOf("  #syncCinematicLight("));
  assert.match(update, /05\.10-sun/);
  // 05.10-7.20: the quality-0 branches ask `lightingClassicLook`, true for 0 and the comparison
  // level 3, false for the enhanced presets 1 and 2.
  const { lightingClassicLook } = await import("../dist/code/browser/LightingQuality.js");
  assert.deepEqual([0, 1, 2].map(lightingClassicLook), [true, false, false]);
  assert.match(update, /lightingClassicLook\(this\.#lightingProfile\.quality\)[^\n]*\n\s*\? classicKeyLightDirection\(time, this\.#classicKeyLight\)\s*\n\s*: sunDirection\(time\)/);
  // The shadow light is placed from the same direction (the cascades read #sunOffset).
  assert.match(update, /#sunOffset\.set\(direction\.x, direction\.y, direction\.z\)/);
  const cinematic = source.slice(source.indexOf("  #syncCinematicLight("), source.indexOf("  setCinematicProfile("));
  assert.match(cinematic, /#visibleSun\(this\.#cinematicSun\)/);
  const rays = source.slice(source.indexOf("  #prepareGodRays("), source.indexOf("  #prepareGodRays(") + 600);
  assert.match(rays, /#visibleSun\(this\.#godRaySun\)/);
  const visible = source.slice(source.indexOf("  #visibleSun("), source.indexOf("  #visibleSun(") + 500);
  assert.match(visible, /lightingClassicLook\(this\.#lightingProfile\.quality\)[^\n]*\n\s*\? classicSunDirection\(this\.#lightTime, target\)\s*\n?\s*: godRaySunDirection\(this\.#lightTime, target\)/);
  // Indoors still wins afterwards: the room's light direction is applied after the key light.
  assert.ok(update.indexOf("setWorldLightIndoor") > update.indexOf("classicKeyLightDirection"));
});
