import assert from "node:assert/strict";
import test from "node:test";
import { itemTooltipFor } from "../dist/code/browser/ui/ItemTooltip.js";
import { game } from "../dist/code/browser/game/Context.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

function template(entry, overrides = {}) {
  return {
    found: true, entry, name: `Предмет ${entry}`, quality: 2, itemClass: 4, inventoryType: 0,
    itemLevel: 0, flags: 0, maxCount: 0, bonding: 0, containerSlots: 0,
    damage: [{ min: 0, max: 0 }], delay: 0, resistances: [0, 0, 0, 0, 0, 0, 0], stats: [],
    requiredLevel: 1, maxDurability: 0, spells: [], requiredSkill: 0, requiredSkillRank: 0,
    requiredReputationFaction: 0, requiredReputationRank: 0, allowableClass: 0, allowableRace: 0,
    sockets: [], socketBonus: 0, gemProperties: 0, startQuest: 0, description: "",
    sellPrice: 0, stackable: 1, ...overrides,
  };
}

function itemObject(guid, entry) {
  return {
    guid, typeId: 1,
    fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry]]),
  };
}

function equipField(fields, slot, guid) {
  const base = UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + slot * 2;
  fields.set(base, Number(guid & 0xffffffffn));
  fields.set(base + 1, Number(guid >> 32n));
}

function fakeWorld(templates, equipped) {
  const fields = new Map();
  for (const [slot, guid] of equipped) equipField(fields, slot, guid);
  const objects = new Map([[1n, { guid: 1n, typeId: 4, fields }]]);
  for (const [slot, guid] of equipped) {
    const entry = equippedEntries.get(guid);
    objects.set(guid, itemObject(guid, entry));
  }
  return {
    state: { selfGuid: 1n, objects },
    itemTemplate: (entry) => templates.get(entry),
  };
}

const equippedEntries = new Map();
function linesOf(content) {
  return content.lines.map((line) => (typeof line === "string" ? line : line.text));
}

test("a chest tooltip names what is worn, with its item level", () => {
  equippedEntries.clear();
  equippedEntries.set(0x100n, 1000);
  const templates = new Map([
    [1001, template(1001, { name: "Кираса претендента", inventoryType: 5, itemLevel: 200 })],
    [1000, template(1000, { name: "Старая кираса", inventoryType: 5, itemLevel: 187 })],
  ]);
  game.world = { ...fakeWorld(templates, [[4, 0x100n]]) };
  try {
    const text = linesOf(itemTooltipFor(1001)).join("\n");
    assert.match(text, /Сейчас надето: Старая кираса, ур\. предмета 187/);
  } finally {
    game.world = undefined;
  }
});

test("two-slot kinds name both slots and an equipped item is not compared with itself", () => {
  equippedEntries.clear();
  equippedEntries.set(0x101n, 1002);
  const templates = new Map([
    [1003, template(1003, { name: "Кольцо претендента", inventoryType: 11, itemLevel: 200 })],
    [1002, template(1002, { name: "Старое кольцо", inventoryType: 11, itemLevel: 150 })],
  ]);
  game.world = { ...fakeWorld(templates, [[10, 0x101n]]) };
  try {
    const text = linesOf(itemTooltipFor(1003)).join("\n");
    assert.match(text, /Сейчас надето \(палец 1\): Старое кольцо/);
    assert.match(text, /Сейчас надето \(палец 2\): —/);
    const self = linesOf(itemTooltipFor(1002, { equipped: true })).join("\n");
    assert.doesNotMatch(self, /Сейчас надето/);
  } finally {
    game.world = undefined;
  }
});

test("a non-equippable item gets no worn line", () => {
  equippedEntries.clear();
  const templates = new Map([
    [1004, template(1004, { name: "Реагент", inventoryType: 0 })],
  ]);
  game.world = { ...fakeWorld(templates, []) };
  try {
    const text = linesOf(itemTooltipFor(1004)).join("\n");
    assert.doesNotMatch(text, /Сейчас надето/);
  } finally {
    game.world = undefined;
  }
});
