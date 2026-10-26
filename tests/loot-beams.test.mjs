// 26.10 (owner: «тела что можно обыскать выглядят не броско»): a small golden beam over every body the server marks
// lootable for this viewer; it fades in, fades out once looted, and draws nothing while off.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { LOOT_BEAM_FADE_IN, LOOT_BEAM_FADE_OUT, LOOT_BEAM_LIMIT, LootBeams } from "../dist/code/browser/LootBeams.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { SETTING_SECTIONS } from "../dist/code/browser/ui/SettingsSections.js";
import { RENDER_WORKER_COMMANDS } from "../dist/code/browser/RenderWorkerClientProtocol.js";

const camera = new THREE.Vector3(0, 5, 10);

/** One frame at `ms`: `bodies` (guid → [x, y, z]) are lootable. */
function frame(beams, ms, bodies) {
  beams.begin();
  for (const [guid, at] of bodies) beams.mark(guid, new THREE.Vector3(...at));
  beams.end(ms, camera);
}

test("a beam fades in over a lootable body, stands on it, and fades out once looted", () => {
  const beams = new LootBeams();
  frame(beams, 0, [[1n, [3, 0, 4]]]);
  assert.equal(beams.count, 0, "off: nothing is kept");
  assert.equal(beams.group.visible, false);

  beams.setEnabled(true);
  frame(beams, 0, [[1n, [3, 0, 4]]]);
  frame(beams, 100, [[1n, [3, 0, 4]]]);
  assert.equal(beams.count, 1);
  assert.equal(beams.group.visible, true);
  const half = beams.levelOf(1n);
  assert.ok(half > 0 && half < 1, `fading in: ${half}`);
  frame(beams, 100 + LOOT_BEAM_FADE_IN * 1000, [[1n, [3, 0, 4]]]);
  assert.equal(beams.levelOf(1n), 1);
  const glow = beams.group.children[0];
  const matrix = new THREE.Matrix4();
  glow.getMatrixAt(0, matrix);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), [3, 0, 4], "on the body");

  // Looted: the mark is gone, the beam fades rather than cuts, then is forgotten.
  const looted = 100 + LOOT_BEAM_FADE_IN * 1000;
  frame(beams, looted + 100, []);
  assert.ok(beams.levelOf(1n) > 0 && beams.levelOf(1n) < 1);
  assert.equal(beams.count, 1);
  for (let ms = looted + 150; ms <= looted + 100 + LOOT_BEAM_FADE_OUT * 1000; ms += 50) frame(beams, ms, []);
  assert.equal(beams.count, 0);
  assert.equal(beams.group.visible, false);

  beams.setEnabled(false);
  frame(beams, 5000, [[2n, [0, 0, 0]]]);
  assert.equal(beams.count, 0, "switched off: nothing drawn");
  beams.dispose();
});

test("past the limit the nearest bodies keep their beams", () => {
  const beams = new LootBeams();
  beams.setEnabled(true);
  const bodies = [];
  for (let index = 0; index < LOOT_BEAM_LIMIT + 8; index++) bodies.push([BigInt(index + 1), [index * 3, 0, 10]]);
  frame(beams, 0, bodies);
  frame(beams, 1000, bodies);
  assert.equal(beams.count, LOOT_BEAM_LIMIT);
  const glow = beams.group.children[0];
  const matrix = new THREE.Matrix4();
  let farthest = 0;
  for (let index = 0; index < beams.count; index++) {
    glow.getMatrixAt(index, matrix);
    farthest = Math.max(farthest, new THREE.Vector3().setFromMatrixPosition(matrix).x);
  }
  assert.equal(farthest, (LOOT_BEAM_LIMIT - 1) * 3, "the eight farthest go without");
  beams.dispose();
});

test("setting: on by default, off in the comparison profile, beside the missile trails, wired to the renderer", async () => {
  const definition = settingDefinition("experimentalLootBeams");
  assert.equal(definition?.fallback, true);
  assert.equal(ENHANCED_GRAPHICS_OVERRIDES.experimentalLootBeams, undefined);
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.experimentalLootBeams, false);
  const section = SETTING_SECTIONS["Эффекты"].find((entry) => entry.title === "Свет и атмосфера");
  assert.equal(section.ids[section.ids.indexOf("experimentalMissileTrails") + 1], "experimentalLootBeams");
  assert.equal(RENDER_WORKER_COMMANDS.setLootBeams, "setting");
  const source = (path) => readFile(new URL(`../src/browser/${path}`, import.meta.url), "utf8");
  for (const file of ["ui/Settings.ts", "RendererGraphicsSettings.ts"]) {
    assert.match(await source(file), /setLootBeams\?\.\(settingBoolean\(values, "experimentalLootBeams"\)\)/, file);
  }
  const renderer = await source("WorldRenderer3D.ts");
  assert.match(renderer, /if \(!object \|\| !isWorldObjectDead\(object\) \|\| !isLootable\(object\)\) continue;/);
  assert.match(renderer, /if \(this\.#lootBeams\.enabled\) this\.#updateLootBeams\(state, now\);/);
});
