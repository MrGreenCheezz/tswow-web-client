import assert from "node:assert/strict";
import test from "node:test";
import {
  GAMEOBJECT_SPAWN_FADE_MS, GAMEOBJECT_TYPE_DUNGEON_DIFFICULTY, gameObjectModelAlpha, gameObjectModelAlphaOf, gameObjectSpawnAlpha,
} from "../dist/code/browser/GameObjectSpawnFade.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

// 15.11 (6.11, fade9): a new game object fades in as Wow.exe does (.runtime/re-2026-11-15/fade9): 0x00712f30 → 0x00744a50,
// its byte from 0 to the behaviour's alpha (+0x3c) over 1000 ms in whole bytes; DUNGEON_DIFFICULTY's alpha is 0.5 unless
// GAMEOBJECT_DYNAMIC has 0x2 (0x0070dd50).

test("6.11 a new game object's alpha walks 0 → 255 over 1000 ms in whole bytes", () => {
  assert.equal(GAMEOBJECT_SPAWN_FADE_MS, 1000);
  assert.equal(gameObjectSpawnAlpha(undefined, 5000), 1, "no stamp: drawn as it is");
  assert.equal(gameObjectSpawnAlpha(1000, 1000), 0, "the first frame from nothing");
  assert.equal(gameObjectSpawnAlpha(1000, 1400), Math.trunc(255 * 400 / 1000) / 255,
    "not done at 0.4 s (this client's old window was 400 ms)");
  assert.equal(gameObjectSpawnAlpha(1000, 1500), 127 / 255);
  assert.equal(gameObjectSpawnAlpha(1000, 1999), 254 / 255);
  assert.equal(gameObjectSpawnAlpha(1000, 2000), 1);
  assert.equal(gameObjectSpawnAlpha(1000, 900), 0, "a clock running backwards cannot unpaint");
});

test("6.11 the alpha a game object fades in to: 1, and 0.5 for a dungeon difficulty object without the animate flag", () => {
  assert.equal(gameObjectModelAlpha(0, 0), 1, "a door");
  assert.equal(gameObjectModelAlpha(3, 0), 1, "a chest");
  assert.equal(gameObjectModelAlpha(GAMEOBJECT_TYPE_DUNGEON_DIFFICULTY, 0), 0.5);
  assert.equal(gameObjectModelAlpha(GAMEOBJECT_TYPE_DUNGEON_DIFFICULTY, 0x2), 1);
  assert.equal(gameObjectModelAlpha(GAMEOBJECT_TYPE_DUNGEON_DIFFICULTY, undefined), 0.5);
  // Its byte walks to 128 and stays there.
  assert.equal(gameObjectSpawnAlpha(0, 500, 0.5), 64 / 255);
  assert.equal(gameObjectSpawnAlpha(0, 1000, 0.5), 128 / 255);
  assert.equal(gameObjectSpawnAlpha(0, 60000, 0.5), 128 / 255);
  assert.equal(gameObjectSpawnAlpha(undefined, 0, 0.5), 128 / 255);
});

test("6.11 the type byte and GAMEOBJECT_DYNAMIC are read off the wire", () => {
  const object = (type, dynamic) => ({
    fields: new Map([
      [UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, (type << 8) | 1],
      [UPDATE_FIELDS.GAMEOBJECT_DYNAMIC.offset, dynamic],
    ]),
  });
  assert.equal(gameObjectModelAlphaOf(object(31, 0xffff0000)), 0.5, "the high half is not the flag");
  assert.equal(gameObjectModelAlphaOf(object(31, 0xffff0002)), 1);
  assert.equal(gameObjectModelAlphaOf(object(0, 0)), 1);
});
