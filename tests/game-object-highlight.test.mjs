// 05.11 (7.60): which game objects answer the pointer. Every row of the table was measured on Wow.exe, one template at a time
// on the same model (F:\WowOracle\tools\go-hover.mjs); the rule is 0x0070F580 and what it calls.
import assert from "node:assert/strict";
import test from "node:test";

import {
  gameObjectCanHighlight, gameObjectHighlightWordOff, gameObjectInteractable, gameObjectMayHighlight,
} from "../dist/code/world/GameObjectHighlight.js";
import { UPDATE_FIELDS as F } from "../dist/code/generated/updateFields.js";

const SELF = 1n;

function facts({ type, data = [], flags = 0, dynamic = 0, hostile = false, createdBy, questInLog, channel, noTemplate = false, creatorOpen = false, creatorThere = true }) {
  const template = noTemplate ? undefined : { entry: 50, type, displayId: 1, name: "x", iconName: "", castBarCaption: "", size: 1, data };
  const object = {
    guid: 500n, typeId: 5, position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map([
      [F.GAMEOBJECT_BYTES_1.offset, type << 8],
      [F.GAMEOBJECT_FLAGS.offset, flags],
      [F.GAMEOBJECT_DYNAMIC.offset, dynamic],
      ...(createdBy === undefined ? [] : [
        [F.OBJECT_FIELD_CREATED_BY.offset, Number(createdBy & 0xffffffffn)],
        [F.OBJECT_FIELD_CREATED_BY.offset + 1, Number(createdBy >> 32n)],
      ]),
    ]),
  };
  const self = {
    guid: SELF, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map([
      ...(questInLog === undefined ? [] : [[F.PLAYER_QUEST_LOG_1_1.offset + 25, questInLog]]),
      ...(channel === undefined ? [] : [
        [F.UNIT_FIELD_CHANNEL_OBJECT.offset, Number(channel & 0xffffffffn)],
        [F.UNIT_FIELD_CHANNEL_OBJECT.offset + 1, Number(channel >> 32n)],
      ]),
    ]),
  };
  return {
    self, object, type, template, hostile,
    creatorOpen: () => creatorOpen,
    objectOf: () => (creatorThere ? { guid: createdBy, typeId: 4, fields: new Map() } : undefined),
  };
}

const MEASURED = [
  // Wow.exe's tooltip came up.
  ["door", { type: 0, data: [0, 81] }, true],
  ["door, friendly faction", { type: 0, data: [0, 81] }, true],
  ["door, FLAG 0x4 with dynamic 0x1", { type: 0, data: [0, 81], flags: 4, dynamic: 1 }, true],
  ["trap, lock 12, hostile", { type: 6, data: [12], hostile: true }, true],
  ["generic, highlight 1", { type: 5, data: [0, 1] }, true],
  ["spell focus", { type: 8 }, true],
  ["goober", { type: 10 }, true],
  ["chest", { type: 3 }, true],
  ["fishing hole", { type: 25 }, true],
  ["aura generator", { type: 30 }, true],
  ["capture point, highlight 1", { type: 29, data: [...new Array(19).fill(0), 1] }, true],
  ["chair", { type: 7 }, true],
  ["quest giver", { type: 2 }, true],
  ["text", { type: 9 }, true],
  ["camera", { type: 13 }, true],
  ["ritual", { type: 18 }, true],
  ["mailbox", { type: 19 }, true],
  ["spell caster", { type: 22 }, true],
  ["meeting stone", { type: 23 }, true],
  ["flag stand", { type: 24 }, true],
  ["flag drop", { type: 26 }, true],
  ["mini game", { type: 27 }, true],
  ["barber chair", { type: 32 }, true],
  ["guild bank", { type: 34 }, true],
  ["duel flag", { type: 16 }, true],
  ["binder", { type: 4 }, true],
  ["area damage", { type: 12 }, true],
  // It did not.
  ["door, hostile faction", { type: 0, data: [0, 81], hostile: true }, false],
  ["door, FLAG 0x10", { type: 0, data: [0, 81], flags: 0x10 }, false],
  ["door, FLAG 0x1", { type: 0, data: [0, 81], flags: 0x1 }, false],
  ["door, FLAG 0x4 and dynamic 0", { type: 0, data: [0, 81], flags: 4 }, false],
  ["door, dynamic 0x4", { type: 0, data: [0, 81], dynamic: 4 }, false],
  ["trap, no lock", { type: 6 }, false],
  ["trap, no lock, hostile: Onyxia's lava fissure", { type: 6, data: [0, 80, 0, 17731, 0, 10], hostile: true }, false],
  ["trap, lock 12, no faction", { type: 6, data: [12] }, false],
  ["generic, highlight 0", { type: 5 }, false],
  ["generic, floating tooltip word alone", { type: 5, data: [1] }, false],
  ["spell focus, quest not in the log", { type: 8, data: [0, 0, 0, 0, 11111] }, false],
  ["goober, quest not in the log", { type: 10, data: [0, 11111] }, false],
  ["chest, quest not in the log", { type: 3, data: [0, 0, 0, 0, 0, 0, 0, 0, 11111] }, false],
  ["chair, only its creator's", { type: 7, data: [0, 0, 1] }, false],
  ["fishing node, not the player's", { type: 17 }, false],
  ["capture point, highlight 0", { type: 29 }, false],
  ["transport", { type: 11 }, false],
  ["map object", { type: 14 }, false],
  ["mo transport", { type: 15 }, false],
  ["auction", { type: 20 }, false],
  ["dungeon difficulty", { type: 31 }, false],
  ["destructible", { type: 33 }, false],
  ["trap door", { type: 35 }, false],
];

for (const [name, input, expected] of MEASURED) {
  test(`Wow.exe's answer: ${name}`, () => {
    assert.equal(gameObjectCanHighlight(facts(input)), expected);
  });
}

test("a quest-bound object answers once the quest is in the log, whatever its state", () => {
  const goober = { type: 10, data: [0, 11111] };
  assert.equal(gameObjectCanHighlight(facts(goober)), false);
  // The second slot: the walk covers the whole log.
  assert.equal(gameObjectCanHighlight(facts({ ...goober, questInLog: 11111 })), true);
  assert.equal(gameObjectCanHighlight(facts({ ...goober, questInLog: 22222 })), false);
});

test("a chair of the player's own, and the player's bobber, answer", () => {
  assert.equal(gameObjectCanHighlight(facts({ type: 7, data: [0, 0, 1], createdBy: SELF })), true);
  assert.equal(gameObjectCanHighlight(facts({ type: 17, channel: 500n })), true);
});

test("a player's trap asks after its setter; a creature's does not", () => {
  const trap = { type: 6, data: [12], hostile: true };
  assert.equal(gameObjectCanHighlight(facts({ ...trap, createdBy: 7n, creatorThere: false })), false, "the setter is out of view");
  assert.equal(gameObjectCanHighlight(facts({ ...trap, createdBy: 7n })), false, "no fight to be had with the setter");
  assert.equal(gameObjectCanHighlight(facts({ ...trap, createdBy: 7n, creatorOpen: true })), true);
  assert.equal(gameObjectCanHighlight(facts({ ...trap, createdBy: 0xF130000000000007n, creatorThere: false })), true, "a creature's guid");
});

test("without a template only what needs none can answer", () => {
  assert.equal(gameObjectCanHighlight(facts({ type: 0, noTemplate: true })), true);
  assert.equal(gameObjectCanHighlight(facts({ type: 6, hostile: true, noTemplate: true })), false);
  assert.equal(gameObjectCanHighlight(facts({ type: 5, noTemplate: true })), false);
});

test("a name without a cursor: the types Wow.exe names and gives no cursor", () => {
  for (const type of [5, 8, 16, 25, 29, 30]) {
    assert.equal(gameObjectInteractable(facts({ type, data: [0, 1, ...new Array(17).fill(0), 1] })), false, `type ${type}`);
  }
});

test("the renderer's box goes by type and flags alone", () => {
  for (const type of [0, 3, 5, 6, 8, 25, 29, 30, 34]) assert.equal(gameObjectMayHighlight(type, 0), true, `type ${type}`);
  for (const type of [11, 14, 15, 20, 21, 28, 31, 33, 35]) assert.equal(gameObjectMayHighlight(type, 0), false, `type ${type}`);
  assert.equal(gameObjectMayHighlight(0, 0x10), false, "an interactable type flagged out of it");
  assert.equal(gameObjectMayHighlight(8, 0x10), true, "0x008A1420 reads no flags");
  assert.equal(gameObjectHighlightWordOff(5, undefined), false, "not known yet");
  assert.equal(gameObjectHighlightWordOff(5, { data: [0, 0] }), true);
  assert.equal(gameObjectHighlightWordOff(5, { data: [0, 1] }), false);
  assert.equal(gameObjectHighlightWordOff(0, { data: [] }), false);
});
