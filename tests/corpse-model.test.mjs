import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  CORPSE_FLAG_BONES, CORPSE_FLAG_HIDE_CLOAK, CORPSE_FLAG_HIDE_HELM, CORPSE_RACE_FILES,
  corpseLook, corpseModelFor, corpseOfView, corpseSkeletonPath, corpseUnitView,
} from "../dist/code/browser/CorpseModel.js";

// 6.05 (line A7a, slice G2, 05.10): a player's corpse (type 7) drawn as its body, or as its bones.
// TrinityCore `Player::CreateCorpse` (Player.cpp:4811-4862) writes the fields; Wow.exe 0x00705b20
// (CGCorpse_C create) and 0x00705670 (its model path) read them back.

const F = (name) => UPDATE_FIELDS[name].offset;

function corpse({ race = 1, sex = 0, skin = 3, face = 4, hairStyle = 5, hairColor = 6, facial = 7,
  flags = 0, display = 49, items = {}, position = { x: 1, y: 2, z: 3, orientation: 0.5 } } = {}) {
  const fields = new Map([
    [F("OBJECT_FIELD_GUID"), 77], [F("OBJECT_FIELD_TYPE"), 0x81], [F("OBJECT_FIELD_SCALE_X"), 0x3f800000],
    [F("CORPSE_FIELD_OWNER"), 5], [F("CORPSE_FIELD_DISPLAY_ID"), display],
    [F("CORPSE_FIELD_BYTES_1"), (race << 8) | (sex << 16) | (skin << 24)],
    [F("CORPSE_FIELD_BYTES_2"), face | (hairStyle << 8) | (hairColor << 16) | (facial << 24)],
    [F("CORPSE_FIELD_FLAGS"), flags],
  ]);
  for (const [slot, [displayId, inventoryType]] of Object.entries(items)) {
    fields.set(F("CORPSE_FIELD_ITEM") + Number(slot), (displayId | (inventoryType << 24)) >>> 0);
  }
  return { guid: 0xF000_0000_0000_0042n, typeId: 7, position, movementFlags: 0, fields };
}

test("the look out of BYTES_1/BYTES_2, in Player::CreateCorpse's byte order", () => {
  const look = corpseLook(corpse({ race: 10, sex: 1, skin: 2, face: 3, hairStyle: 4, hairColor: 5, facial: 6 }));
  assert.deepEqual([look.race, look.sex, look.skin, look.face, look.hairStyle, look.hairColor, look.facialHair, look.displayId],
    [10, 1, 2, 3, 4, 5, 6, 49]);
  assert.equal(look.bones, false);
  assert.equal(corpseLook({ ...corpse(), typeId: 4 }), undefined, "only a corpse");
});

test("the worn items: displayId | inventoryType << 24 per EQUIPMENT_SLOT, as 0x00705b20 hangs them", () => {
  const look = corpseLook(corpse({ items: {
    0: [1000, 1], 2: [1002, 3], 4: [1004, 20], 14: [1014, 16], 15: [1015, 17], 16: [1016, 14], 17: [1017, 26], 18: [1018, 19],
  } }));
  assert.deepEqual(look.equipment.map((item) => [item.slot, item.displayId, item.inventoryType]),
    [[0, 1000, 1], [2, 1002, 3], [4, 1004, 20], [14, 1014, 16], [18, 1018, 19]],
    "weapons are not hung (the ranged slot is skipped outright, the hands need an item object)");
  const hidden = corpseLook(corpse({ flags: CORPSE_FLAG_HIDE_HELM | CORPSE_FLAG_HIDE_CLOAK, items: { 0: [1000, 1], 14: [1014, 16], 5: [1005, 4] } }));
  assert.deepEqual(hidden.equipment.map((item) => item.slot), [5], "hidden helm (0x08) and cloak (0x10)");
});

test("bones: the race's DeathSkeleton doodad (0x00705670), Male/Female by the sex byte", () => {
  assert.equal(CORPSE_FLAG_BONES, 1);
  const bones = corpseLook(corpse({ flags: CORPSE_FLAG_BONES, race: 5, sex: 1 }));
  assert.equal(bones.bones, true);
  assert.equal(corpseSkeletonPath(5, 1), "World\\Generic\\PassiveDoodads\\DeathSkeletons\\ScourgeFemaleDeathSkeleton.m2");
  assert.equal(corpseSkeletonPath(1, 0), "World\\Generic\\PassiveDoodads\\DeathSkeletons\\HumanMaleDeathSkeleton.m2");
  assert.equal(corpseSkeletonPath(9, 0), undefined, "no goblin skeleton in the client");
  assert.equal(corpseSkeletonPath(99, 0), undefined);
  assert.equal(corpseSkeletonPath(1, 2), undefined);
});

test("ChrRaces.ClientFileString agrees with the table, where the dataset is here", async (t) => {
  const { dbcDirectory } = await import("../tools/paths.mjs");
  const path = join(dbcDirectory(), "ChrRaces.dbc");
  if (!existsSync(path)) { t.skip("no dataset"); return; }
  const { openDbc } = await import("../dist/code/gateway/Dbc.js");
  const races = openDbc(readFileSync(path), "ChrRaces");
  for (const [race, file] of Object.entries(CORPSE_RACE_FILES)) {
    const row = races.rowOf(Number(race));
    assert.equal(races.string(row, "ClientFileString"), file, `race ${race}`);
  }
});

test("the renderer's view: a stable stand-in carrying only what the unit path may read", () => {
  const body = corpse({ items: { 7: [1007, 1], 9: [1009, 10], 11: [1011, 11], 12: [1012, 12], 13: [1013, 12] } });
  body.fields.set(F("CORPSE_FIELD_GUILD"), 9);
  const view = corpseUnitView(body);
  assert.equal(view, corpseUnitView(body), "the same object frame after frame");
  assert.equal(view.guid, body.guid);
  assert.equal(view.typeId, 7);
  assert.equal(view.position, body.position);
  assert.equal(corpseOfView(view), body);
  assert.equal(view.fields.get(F("UNIT_FIELD_DISPLAYID")), 49);
  assert.equal(view.fields.get(F("UNIT_FIELD_NATIVEDISPLAYID")), 49);
  assert.equal(view.fields.get(F("OBJECT_FIELD_SCALE_X")), 0x3f800000);
  // The corpse's own words sit where a unit's TARGET, BYTES_0 and HEALTH are: none of them may leak.
  for (const name of ["UNIT_FIELD_TARGET", "UNIT_FIELD_BYTES_0", "UNIT_FIELD_HEALTH", "UNIT_CHANNEL_SPELL", "UNIT_FIELD_MAXHEALTH"]) {
    assert.equal(view.fields.has(F(name)), false, name);
  }
  body.fields.set(F("CORPSE_FIELD_DISPLAY_ID"), 50);
  assert.equal(corpseUnitView(body).fields.get(F("UNIT_FIELD_DISPLAYID")), 50, "follows the corpse");
  assert.equal(corpseUnitView({ ...corpse(), position: undefined }), undefined);
});

test("the model: the owner's look composed like a live player's, the bones as their doodad", () => {
  const calls = [];
  const appearance = { body: [], attached: [] };
  const models = {
    generation: 1,
    get: (id) => id === 49 ? { id, model: "Character\\Human\\Male\\HumanMale.m2", scale: 1, collisionHeight: 2, mountHeight: 0, textures: "" } : undefined,
    playerAppearance: (...args) => { calls.push(args); return appearance; },
  };
  const body = corpse({ items: { 4: [1004, 20] } });
  const model = corpseModelFor(corpseUnitView(body), models);
  assert.equal(model.appearance, appearance);
  assert.equal(model.model, "Character\\Human\\Male\\HumanMale.m2");
  assert.deepEqual(calls[0].slice(0, 7), [1, 0, 3, 4, 5, 6, 7], "race, sex, skin, face, hair, colour, facial — a live player's order");
  assert.deepEqual(calls[0][7], [{ slot: 4, inventoryType: 20, displayId: 1004 }]);
  assert.equal(corpseModelFor(body, models), model, "the real corpse (a portrait) gets the same, memoised");
  const bones = corpseModelFor(corpseUnitView(corpse({ flags: CORPSE_FLAG_BONES })), models);
  assert.equal(bones.model, "World\\Generic\\PassiveDoodads\\DeathSkeletons\\HumanMaleDeathSkeleton.m2");
  assert.equal(bones.appearance, undefined);
  assert.equal(corpseModelFor(corpseUnitView(corpse({ display: 1 })), models), undefined, "display record not here yet");
});

test("the hooks: admission, the dead pose, the display request, the model, the marker", () => {
  const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  const renderer = src("browser/WorldRenderer3D.ts");
  assert.match(renderer, /candidate\.typeId === 7 \? corpseUnitView\(candidate\) : candidate/);
  assert.match(renderer, /const dead = isWorldObjectDead\(object\) \|\| object\.typeId === 7;/);
  // P1-20c: the world pass's model requests moved to UnitModelRequests.ts (events + WorldView's sweep).
  assert.match(src("browser/UnitModelRequests.ts"), /corpseDisplayRequest\(object\)/);
  assert.match(src("browser/ui/WorldView.ts"), /sweepUnitModels\(state, game\.creatureModels\)/);
  assert.match(src("browser/ui/Frames.ts"), /if \(object\.typeId === 7\) return corpseModelFor\(object, creatureModels\);/);
  assert.match(src("browser/SimpleScene.ts"), /object\.typeId === 7 && unitHeight\?\.\(object\.guid\) !== undefined/);
});
