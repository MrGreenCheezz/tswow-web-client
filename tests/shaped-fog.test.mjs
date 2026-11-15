// 15.11 (7.66): the fog Wow.exe shapes on maps from 530 up (DistanceFog.ts, WmoRoomFog.ts). The numbers are the stand's
// frames (WowOracle runs/fog6-*.tsv: VS c30 = −1/(end−start), end/(end−start), density; PS c2 the colour).

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  encodeShapedFogFar, installShapedFogChunks, shapedFogDensity, shapedFogEnd, shapedFogMap, shapedZoneFog, WOW_FAR_CLIP,
} from "../dist/code/browser/DistanceFog.js";
import { mixZoneIntoRoomFog, shapeWmoRoomFog } from "../dist/code/browser/WmoRoomFog.js";

const close = (actual, expected, label, eps = 0.01) => assert.ok(Math.abs(actual - expected) < eps, `${label}: ${actual} vs ${expected}`);
const zoneOf = (end, share) => shapedZoneFog(end, share, WOW_FAR_CLIP, { near: 0, far: 0, density: 1 });

test("0x007816f0: the maps whose fog is shaped are those from 530 up", () => {
  for (const map of [530, 543, 564, 571]) assert.equal(shapedFogMap(map), true, String(map));
  // The Black Morass (269) is a TBC instance and drew linear (fog6-m269-air: 277.78, density 1).
  for (const map of [0, 1, 34, 249, 269]) assert.equal(shapedFogMap(map), false, String(map));
  assert.equal(shapedFogMap(undefined), false);
});

test("0x007ecd80/0x007f16f0 on the stand: the zone's fog of a shaped map", () => {
  let fog = zoneOf(666.6667, 0.5); // fog6-o-netherstorm, LightParams 384
  close(fog.near, 638.5, "Netherstorm start");
  assert.equal(fog.far, 1277);
  close(fog.density, 3.3333, "Netherstorm density", 1e-3);
  fog = zoneOf(1527.7778, 0.8); // fog6-o-nagrand, LightParams 396
  close(fog.near, 1021.6, "Nagrand start");
  close(fog.density, 3.6389, "Nagrand density", 1e-3);
  fog = zoneOf(388.8889, 0); // fog6-bt-air-out, LightParams 604
  assert.equal(fog.near, 0);
  close(fog.density, 2.7222, "Black Temple density", 1e-3);
  fog = zoneOf(666.6667, -0.2); // a negative share: start 0 and the gap is past 500, so 1.5 (fog6-n-dragonblight)
  assert.equal(fog.near, 0);
  assert.equal(fog.density, 1.5);
  fog = zoneOf(20, 0.5); // under 1000/36 yards: not shaped
  assert.equal(fog.density, 1);
  assert.equal(fog.far, 20);
});

test("0x007ed1b0 on the stand: a room's fog on a shaped map, and the zone mix with its density", () => {
  // Dalaran, the Violet Citadel lobby: record 0 (117,147,168, 222.2 × 0.25) whole: 55.55 to 1277 at 5.1667.
  let room = { r: 117 / 255, g: 147 / 255, b: 168 / 255, near: 55.5556, far: 222.2222, density: 1 };
  shapeWmoRoomFog(room, 1277);
  close(room.near, 55.55, "lobby start");
  assert.equal(room.far, 1277);
  close(room.density, 5.1667, "lobby density", 1e-3);
  // Black Temple's sewer mouth (fog6-bt-sewermouth-high): record 1 shaped, the zone's (32,30,14, 0, 2.7222) mixed in at 0.86.
  room = { r: 64 / 255, g: 122 / 255, b: 99 / 255, near: 126.3889, far: 361.1111, density: 1 };
  shapeWmoRoomFog(room, 1277);
  close(room.density, 4.4181, "bossroom density (fog6-bt-bossroom)", 1e-3);
  const btZone = { r: 32 / 255, g: 30 / 255, b: 14 / 255, near: 0, far: 1277, density: 2.7222 };
  mixZoneIntoRoomFog(btZone, room, 0.86);
  assert.deepEqual([room.r, room.g, room.b].map((v) => Math.round(v * 255)), [59, 108, 86]);
  close(room.near, 108.66, "sewer mouth start", 0.05);
  close(room.density, 4.1801, "sewer mouth density", 2e-3);
  // Dalaran's bank by its door (fog6-n-dal-bank): the zone 104,82,122 from 319.25 at 1.5, k 0.9585.
  room = { r: 117 / 255, g: 147 / 255, b: 168 / 255, near: 55.5556, far: 222.2222, density: 1 };
  shapeWmoRoomFog(room, 1277);
  mixZoneIntoRoomFog({ r: 104 / 255, g: 82 / 255, b: 122 / 255, near: 319.25, far: 1277, density: 1.5 }, room, 0.9585);
  assert.deepEqual([room.r, room.g, room.b].map((v) => Math.round(v * 255)), [116, 143, 165]);
  close(room.near, 66.49, "bank start", 0.05);
  close(room.density, 5.0146, "bank density", 2e-3);
});

test("0x007ecd00: the density from a fog's gap", () => {
  close(shapedFogDensity(0, 0), 7, "no gap");
  assert.equal(shapedFogDensity(0, 501), 1.5, "past 500 yards");
  close(shapedFogDensity(0, 250, 450), 1.5, "a far clip under 700 narrows the span to far clip − 200");
});

test("the end never passes the ground WebClient draws", () => {
  assert.equal(shapedFogEnd(true), 1277, "with the WDL horizon (≥ 2,133 yards) the original's far clip");
  assert.equal(shapedFogEnd(false), 480, "without it a tenth inside the near ring's one tile");
});

test("the shaders' encoding of a shaped far distance survives a float uniform", () => {
  for (const [far, density] of [[1277, 1.5], [1277, 5.1667], [480, 7], [1277, 2.7222]]) {
    const encoded = Math.fround(encodeShapedFogFar(far, density));
    assert.ok(encoded < 0);
    assert.equal(Math.floor(-encoded), far);
    close(((-encoded) % 1) * 16, density, `density ${density}`, 3e-3);
  }
});

test("three's fog chunks call the shaped fog, linear path unchanged, idempotent", () => {
  const before = THREE.ShaderChunk.fog_fragment;
  installShapedFogChunks();
  installShapedFogChunks();
  assert.match(THREE.ShaderChunk.fog_fragment, /float fogFactor = wowFogFactor\( fogNear, fogFar, vFogDepth \);/);
  assert.doesNotMatch(THREE.ShaderChunk.fog_fragment, /smoothstep\( fogNear, fogFar, vFogDepth \)/);
  assert.equal(THREE.ShaderChunk.fog_pars_fragment.split("float wowShapedFogFactor").length, 2);
  assert.match(THREE.ShaderChunk.fog_pars_fragment, /fogFar < 0\.0 \? wowShapedFogFactor\( fogNear, fogFar, depth \) : smoothstep\( fogNear, fogFar, depth \)/,
    "a linear (positive) far keeps three's smoothstep: maps under 530 are drawn as before");
  assert.ok(before.length > 0);
});
