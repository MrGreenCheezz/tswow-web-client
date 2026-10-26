// 26.10 (6.27, test version, owner: «Шлейфы снарядов… Интересно»): a soft glowing ribbon behind each missile with
// particles, in their colour, fading over a quarter of a second; none for arrows and bullets; off by default.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { MISSILE_TRAIL_SECONDS, MissileTrails, missileTrailColour } from "../dist/code/browser/MissileTrails.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { SETTING_SECTIONS } from "../dist/code/browser/ui/SettingsSections.js";
import { RENDER_WORKER_COMMANDS } from "../dist/code/browser/RenderWorkerClientProtocol.js";

const ramp = (values, components) => ({ components, times: new Float32Array(values.length / components), values: Float32Array.from(values) });
const emitter = (colour, opacity) => ({ color: ramp(colour, 3), opacity: ramp(opacity, 1) });

test("the colour is the missile's particles', weighted by their opacity, its brightest channel at 1; none without particles", () => {
  assert.equal(missileTrailColour({ particleEmitters: [] }), undefined, "an arrow keeps the client's look");
  const fire = missileTrailColour({ particleEmitters: [emitter([1, 0.5, 0.1, 0.8, 0.2, 0], [1, 0])] });
  assert.deepEqual([fire.r, fire.g, fire.b].map((value) => Math.round(value * 100) / 100), [1, 0.5, 0.1], "the faded key does not count");
  const frost = missileTrailColour({ particleEmitters: [emitter([0.2, 0.4, 0.8], [1]), emitter([0.1, 0.2, 0.4], [1])] });
  assert.equal(frost.b, 1);
});

test("a trail follows the missile, fades over its life after the missile lands, and draws nothing while off", () => {
  const trails = new MissileTrails();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 5, 10);
  const missile = {};
  const colour = new THREE.Color(1, 0.5, 0.1);
  const at = new THREE.Vector3();
  trails.sample(missile, at.set(0, 0, 0), 0, colour, 1);
  trails.update(0, camera);
  assert.equal(trails.count, 0, "off: nothing is kept");
  assert.equal(trails.mesh.visible, false);

  trails.setEnabled(true);
  for (let frame = 0; frame <= 10; frame++) trails.sample(missile, at.set(frame * 0.5, 1, 0), frame * 16, colour, 1);
  trails.update(160, camera);
  assert.equal(trails.count, 1);
  assert.equal(trails.mesh.visible, true);
  assert.ok(trails.mesh.geometry.drawRange.count > 0);
  const colours = trails.mesh.geometry.getAttribute("trailColour").array;
  const alphas = [];
  for (let point = 0; point < 11; point++) alphas.push(colours[point * 8 + 3]);
  assert.ok(alphas[10] > alphas[0], "brightest at the head");

  trails.sample({}, at.set(9, 9, 9), 160, undefined, 1);
  assert.equal(trails.count, 1, "a missile without a colour gets no trail");
  trails.update(160 + MISSILE_TRAIL_SECONDS * 1000 + 20, camera);
  assert.equal(trails.count, 0, "landed: gone once its last point has aged out");
  assert.equal(trails.mesh.visible, false);
  trails.dispose();
});

test("setting: off by default, outside the enhanced preset, off in the comparison profile, next to the density one", async () => {
  const definition = settingDefinition("experimentalMissileTrails");
  assert.equal(definition?.fallback, false);
  assert.equal(ENHANCED_GRAPHICS_OVERRIDES.experimentalMissileTrails, undefined);
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.experimentalMissileTrails, false);
  const section = SETTING_SECTIONS["Эффекты"].find((entry) => entry.title === "Свет и атмосфера");
  assert.equal(section.ids[section.ids.indexOf("experimentalSpellDensity") + 1], "experimentalMissileTrails");
  assert.equal(RENDER_WORKER_COMMANDS.setMissileTrails, "setting");
  const source = (path) => readFile(new URL(`../src/browser/${path}`, import.meta.url), "utf8");
  for (const file of ["ui/Settings.ts", "RendererGraphicsSettings.ts"]) {
    assert.match(await source(file), /setMissileTrails\?\.\(settingBoolean\(values, "experimentalMissileTrails"\)\)/, file);
  }
  const renderer = await source("WorldRenderer3D.ts");
  assert.match(renderer, /if \(colour\) this\.#missileTrails\.sample\(visual, visual\.node\.position, now, colour, instance\.scale\);/);
  assert.match(renderer, /this\.#missileTrails\.update\(now, this\.#camera\);/);
});
