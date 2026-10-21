// 12.10 7.33 — the instance portals of Northrend are game objects of type 31, one per difficulty on
// the same spot (Gundrak: `Doodad_InstanceNewPortal_Purple01`, data 604/0, and `…_Purple_Skull01`,
// 604/1). Wow.exe shows only the one for the current difficulty (0x00710a50 → 0x0077f2f0); the
// renderer drew both. See src/world/DungeonDifficultyObject.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GO_TYPE_DUNGEON_DIFFICULTY, dungeonDifficultyObjectShown,
} from "../dist/code/world/DungeonDifficultyObject.js";

const maps = new Map([[604, 1], [631, 2]]); // Gundrak a dungeon, Icecrown Citadel a raid
const instanceType = (mapId) => maps.get(mapId);
const template = (mapId, difficulty) => ({ type: GO_TYPE_DUNGEON_DIFFICULTY, data: [mapId, difficulty, ...new Array(22).fill(0)] });

test("a dungeon's portal shows in its own difficulty only (0x00710a50 → 0x005138d0)", () => {
  const normal = template(604, 0), heroic = template(604, 1);
  assert.equal(dungeonDifficultyObjectShown(31, normal, instanceType, 0), true);
  assert.equal(dungeonDifficultyObjectShown(31, heroic, instanceType, 0), false, "the skull portal hides in normal");
  assert.equal(dungeonDifficultyObjectShown(31, normal, instanceType, 1), false);
  assert.equal(dungeonDifficultyObjectShown(31, heroic, instanceType, 1), true);
  // A map the table does not know takes the dungeon rule too.
  assert.equal(dungeonDifficultyObjectShown(31, template(9999, 1), instanceType, 0), false);
});

test("what is not known stays drawn: no template yet, another type, a raid's portals", () => {
  assert.equal(dungeonDifficultyObjectShown(31, undefined, instanceType, 1), true, "template still on its way");
  assert.equal(dungeonDifficultyObjectShown(5, template(604, 1), instanceType, 0), true, "not type 31");
  assert.equal(dungeonDifficultyObjectShown(31, { type: 5, data: [604, 1] }, instanceType, 0), true, "template of another type");
  // The raid rule needs Map.dbc flags and MapDifficulty.dbc, which the browser does not carry.
  for (const difficulty of [0, 1, 2, 3]) {
    assert.equal(dungeonDifficultyObjectShown(31, template(631, difficulty), instanceType, 0), true, `raid portal ${difficulty}`);
  }
});

test("the renderer keeps a hidden object resident but unpinned and invisible; the loop pushes the rule", () => {
  const renderer = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const pass = renderer.slice(renderer.indexOf("  #updateGameObjects("), renderer.indexOf("    const admission = selectGameObjectAdmissionWithTransports"));
  assert.match(pass, /const shown = !this\.#inputs\.hiddenGameObjects\.has\(object\.guid\);/); // 22.10 ARC-2 S2a
  assert.match(pass, /const isPinned = shown && pinned\.has\(object\.guid\);/);
  assert.match(pass, /const visible = shown && \(isPinned \|\| radius === undefined/);
  const loop = readFileSync(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  assert.match(loop, /renderInputs\.build\(\{[^}]*gameObjectShown: loopGameObjectShown,/); // 22.10 ARC-2 S2a
  assert.match(loop, /world\.group\?\.dungeonDifficulty \?\? world\.dungeonDifficulty/);
});
