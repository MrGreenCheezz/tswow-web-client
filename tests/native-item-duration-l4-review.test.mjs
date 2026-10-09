import assert from "node:assert/strict";
import test from "node:test";

// L4-review (04.10), plan item 5.22: the native bags' tooltip of a timed item shows the time the item
// object has left (ITEM_FIELD_DURATION, Wow.exe 0x006277f0 → 0x007070b0), not its record's whole
// Duration. `ItemSlots.js` resolves `Dom.ts` handles at import time, so the document stub goes
// first (the order trade-offer.test.mjs uses).
const fakeNode = () => ({
  children: [], dataset: {}, className: "", textContent: "", hidden: false, disabled: false, value: "", type: "",
  style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  append() {}, appendChild(child) { return child; }, replaceChildren() {},
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  querySelector: () => fakeNode(), querySelectorAll: () => [],
});
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.document = {
  createElement: fakeNode, createElementNS: () => fakeNode(), body: fakeNode(), getElementById: fakeNode,
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
};
const { itemTooltip } = await import("../dist/code/browser/ui/ItemSlots.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

test("L4-review 5.22: a native bag tooltip counts down the item's own time, not the record's Duration", () => {
  const template = {
    found: true, entry: 9, name: "Временный посох", quality: 1, itemClass: 2, subClass: 10, flags: 0, flags2: 0, inventoryType: 17,
    bonding: 0, stackable: 1, maxCount: 0, startQuest: 0, containerSlots: 0, damage: [{ min: 0, max: 0, type: 0 }], delay: 0,
    resistances: [0, 0, 0, 0, 0, 0, 0], block: 0, stats: [], sockets: [], socketBonus: 0, gemProperties: 0,
    maxDurability: 0, allowableClass: 0, allowableRace: 0, requiredLevel: 0, requiredSkill: 0, requiredSkillRank: 0,
    requiredReputationFaction: 0, requiredReputationRank: 0, itemLevel: 0, spells: [], description: "", sellPrice: 0,
    duration: 7200, pageText: 0, randomProperty: 0, randomSuffix: 0, scalingStatValue: 0, itemSet: 0,
  };
  const state = new WorldState();
  const item = { guid: 0x201n, typeId: 1, fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 9], [UPDATE_FIELDS.ITEM_FIELD_DURATION.offset, 150],
  ]) };
  state.objects.set(item.guid, item);
  const previous = game.world;
  game.world = { state, itemTemplate: (entry) => (entry === 9 ? template : undefined) };
  try {
    const content = itemTooltip({ index: 0, guid: item.guid, item, bag: 255, slot: 23 }, "");
    const texts = (content?.lines ?? []).map((line) => (typeof line === "string" ? line : line.text));
    assert.ok(texts.includes("Срок действия: 3 минуты"), `⌈150 / 60⌉ = 3 minutes left: ${texts.join(" / ")}`);
    assert.ok(!texts.includes("Исчезнет через 2 ч."), "not the record's two hours");
  } finally { game.world = previous; }
});
