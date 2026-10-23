// 22.10 (7.46): distant lamps glow — a cheap instanced glow on every outdoor fixture out to a few
// hundred yards, continuous with the near halo at 64 yards, night weighted, capped, enhanced only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  FAR_LIGHT_LIMIT, FAR_LIGHT_RANGE, FarLightGlows, farLightGlowRadius, farLightGlowWeight, farLightSources,
} from "../dist/code/browser/FarLightGlows.js";
import {
  LIGHT_HALO_DAY_SHARE, LIGHT_HALO_FADE, LIGHT_HALO_RADIUS, LightHalos, lightHaloWeight,
} from "../dist/code/browser/LightHalos.js";
import { lightingProfile } from "../dist/code/browser/LightingQuality.js";

const close = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

/** A Stormwind street lamp: its lit pane is an unlit `StormwindLampGlass` batch 4 yards up. */
const lampModel = () => ({
  positions: new Float32Array([0, 0, 0, 0, 0, 4, 1, 0, 4, 0, 1, 4]),
  indices: new Uint16Array([0, 1, 2, 1, 2, 3]),
  submeshes: [{ indexStart: 0, indexCount: 3 }, { indexStart: 3, indexCount: 3 }],
  batches: [
    { submesh: 0, materialFlags: 0, blendMode: 0, textures: [0], colorIndex: 65535, textureWeight: 0 },
    { submesh: 1, materialFlags: 1, blendMode: 0, textures: [1], colorIndex: 65535, textureWeight: 0 },
  ],
  textures: [{ path: "World\\Generic\\Human\\Passive Doodads\\Lamps\\StreetLamp.blp" },
    { path: "Dungeons\\Textures\\Doodads\\StormwindLampGlass.blp" }],
  particleEmitters: [], colours: [], textureWeights: [], globalSequences: new Uint32Array(),
});
const LAMP = "World\\Generic\\Human\\Passive Doodads\\Lamps\\StormwindStreetLamp01.m2";

function placement(model, x, z = 0, source = {}) {
  const visual = new THREE.Object3D();
  visual.position.set(x, 0, z);
  return { source: { id: 1, name: LAMP, ...source }, node: visual, visual, wvm: model };
}

test("the far range and the cap: a few hundred yards, a few hundred glows", () => {
  assert.ok(FAR_LIGHT_RANGE >= 200 && FAR_LIGHT_RANGE <= 300, `range ${FAR_LIGHT_RANGE}`);
  assert.ok(FAR_LIGHT_LIMIT >= 256 && FAR_LIGHT_LIMIT <= 512, `cap ${FAR_LIGHT_LIMIT}`);
  assert.ok(farLightGlowWeight(0, 100) > 0.9, "a lamp 100 yards off glows at night");
  assert.ok(farLightGlowWeight(0, 200) > 0.5, "and 200 yards off");
  assert.equal(farLightGlowWeight(0, FAR_LIGHT_RANGE), 0, "none at the range");
  assert.equal(farLightGlowWeight(0, FAR_LIGHT_RANGE + 50), 0);
  assert.ok(farLightGlowWeight(0, FAR_LIGHT_RANGE - 5) < 0.05, "faded out, not cut, at the far end");
  assert.equal(farLightGlowWeight(0, 30), 0, "the near halo's ground: no double glow");
  assert.equal(farLightGlowWeight(0, Number.NaN), 0);
});

test("no step at 64 yards: the far glow takes over exactly where the near halo fades", () => {
  const [near, far] = LIGHT_HALO_FADE;
  assert.equal(far, 64);
  let previous = lightHaloWeight(0, near - 4) + farLightGlowWeight(0, near - 4);
  for (let distance = near - 4; distance <= far + 20; distance += 0.25) {
    const sum = lightHaloWeight(0, distance) + farLightGlowWeight(0, distance);
    if (distance <= far) close(sum, 1, 1e-9);
    assert.ok(Math.abs(sum - previous) < 0.01, `step at ${distance}: ${previous} -> ${sum}`);
    previous = sum;
  }
  close(farLightGlowRadius(far), LIGHT_HALO_RADIUS);
  close(farLightGlowRadius(far - 10), LIGHT_HALO_RADIUS);
  assert.ok(farLightGlowRadius(200) > 2 * LIGHT_HALO_RADIUS, "grows with distance so a far lamp still reads");
  assert.ok(farLightGlowRadius(200) / 200 < LIGHT_HALO_RADIUS / 64, "but shrinks on screen");
});

test("night weighted like the halo: by day a lamp hardly glows", () => {
  for (const distance of [70, 120, 200]) {
    close(farLightGlowWeight(1, distance) / farLightGlowWeight(0, distance), LIGHT_HALO_DAY_SHARE, 1e-9);
  }
  assert.ok(farLightGlowWeight(0.5, 120) < farLightGlowWeight(0, 120));
});

test("one instanced draw over the halo's program, capped, nearest first, no glow within the near band", () => {
  const model = lampModel();
  const placements = new Map();
  for (let index = 0; index < 900; index++) placements.set(index, placement(model, index * 0.5));
  const glows = new FarLightGlows();
  const camera = new THREE.Vector3(0, 4, 0);
  glows.update(placements, camera, 0);
  assert.equal(glows.sourceCount, 900);
  const mesh = glows.mesh;
  assert.ok(mesh.count > 0 && mesh.count <= FAR_LIGHT_LIMIT, `drawn ${mesh.count}`);
  const centres = mesh.geometry.getAttribute("haloCentre").array;
  let nearest = Infinity, farthest = 0;
  for (let index = 0; index < mesh.count; index++) {
    nearest = Math.min(nearest, centres[index * 4]);
    farthest = Math.max(farthest, centres[index * 4]);
  }
  assert.ok(nearest > LIGHT_HALO_FADE[0], `nearest glow at ${nearest}`);
  assert.ok(farthest < FAR_LIGHT_RANGE, `farthest glow at ${farthest}`);
  // The same shader source as the near halo: three links one program for both, at load.
  const halos = new LightHalos();
  assert.equal(mesh.material.vertexShader, halos.mesh.material.vertexShader);
  assert.equal(mesh.material.fragmentShader, halos.mesh.material.fragmentShader);
  assert.equal(mesh.material.depthTest, true, "a wall in front still hides a glow");
  assert.equal(mesh.material.depthWrite, false);
  const material = mesh.material;
  glows.update(placements, camera.set(10, 4, 0), 0);
  assert.equal(mesh.material, material, "no new material while playing");
  glows.clear();
  assert.equal(mesh.count, 0, "the faithful profiles draw none");
  halos.dispose();
  glows.dispose();
});

test("the cap binds: the nearest are kept and the set fades before the first left out", () => {
  const model = lampModel();
  const placements = new Map();
  // 1,000 lamps on a spiral from 60 to 260 yards: the 385th nearest stands at 136.8.
  for (let index = 0; index < 1000; index++) {
    const angle = index * 2.39996, distance = 60 + index * 0.2;
    placements.set(index, placement(model, distance * Math.cos(angle), distance * Math.sin(angle)));
  }
  const glows = new FarLightGlows();
  glows.update(placements, new THREE.Vector3(0, 4, 0), 0);
  const mesh = glows.mesh;
  assert.ok(mesh.count > 200 && mesh.count <= FAR_LIGHT_LIMIT, `drawn ${mesh.count}`);
  const centres = mesh.geometry.getAttribute("haloCentre").array;
  const colours = mesh.geometry.getAttribute("haloColour").array;
  let farthest = 0, faintest = Infinity;
  for (let index = 0; index < mesh.count; index++) {
    const distance = Math.hypot(centres[index * 4], centres[index * 4 + 2]);
    farthest = Math.max(farthest, distance);
    if (distance > 130) faintest = Math.min(faintest, colours[index * 3]);
  }
  assert.ok(farthest < 136.8, `the nearest are kept: farthest ${farthest}`);
  assert.ok(faintest < 0.05, "and those nearest the cut have faded, so a re-pick does not pop");
  glows.dispose();
});

test("sources: a room's lamp or an interior doodad never glows (no light through walls)", () => {
  const model = lampModel();
  assert.equal(farLightSources(placement(model, 0)).length, 6);
  assert.equal(farLightSources(placement(model, 0, 0, { interior: true })).length, 0);
  assert.equal(farLightSources(placement(model, 0, 0, { localLight: [1, 1, 1] })).length, 0);
  const plain = { ...lampModel(), textures: [{ path: "a.blp" }, { path: "b.blp" }] };
  assert.equal(farLightSources(placement(plain, 0, 0, { name: "World\\Generic\\Crate01.m2" })).length, 0);
});

test("gating: enhanced lighting only; the renderer gathers incrementally", async () => {
  assert.ok(lightingProfile(2).cinematicLights > 0);
  for (const quality of [0, 1, 3]) assert.equal(lightingProfile(quality).cinematicLights, 0);
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  // 24.10 (7.50): the lamps not built yet come along (PrelitLights.ts), superseding 23.10's templates.
  assert.match(renderer, /if \(cinematic\) \{\n(?:\s+\/\/.*\n)?\s+this\.#farLightGlows\.update\(this\.#environment, /);
  // 23.10 (7.46): with the open-air test for a building's doodads (WmoOpenAirLamps.ts).
  assert.match(renderer, /this\.#zoneFogFar, this\.#prelitFar, this\.#openAirDoodad\);/);
  assert.match(renderer, /\} else this\.#farLightGlows\.clear\(\);/);
  assert.match(renderer, /this\.#scene\.add\(this\.#farLightGlows\.mesh\);/);
  // The source list is rebuilt only when the placement set changes.
  assert.match(renderer, /this\.#environment\.set\(object\.id, rendered\);\n\s+this\.#farLightGlows\.invalidate\(\);/);
  assert.match(renderer, /this\.#environment\.delete\(id\);\n\s+this\.#farLightGlows\.invalidate\(\);/);
  assert.match(renderer, /this\.#environment\.clear\(\);\n\s+this\.#farLightGlows\.invalidate\(\);/);
});
