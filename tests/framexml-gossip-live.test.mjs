import assert from "node:assert/strict";
import test from "node:test";

// LiveWorldSeam's gossip wiring over a fake world: GetGossipAvailableQuests/GetGossipActiveQuests
// grey a quest row by the player's own level (UnitLevel("player"), UNIT_FIELD_LEVEL) against
// GetQuestGreenRange, as UIParent.lua's GetQuestDifficultyColor does — the packet carries the
// quest's level (GossipDef.cpp) and no trivial bit.
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

/** An innkeeper's page: a level-5 quest to take, a level-scaled one (-1), a level-58 one to turn in. */
const PAGE = Object.freeze({
  guid: 77n, menuId: 1, textId: 1, options: [],
  quests: [
    { id: 60, icon: 2, level: 5, flags: 0, repeatable: false, title: "Кобольдские свечи" },
    { id: 61, icon: 2, level: -1, flags: 0, repeatable: false, title: "Праздничный огонь" },
    { id: 47, icon: 4, level: 58, flags: 0, repeatable: false, title: "Золотая пыль" },
  ],
});

function fixture(level) {
  const player = { guid: 1n, typeId: 4, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, level]]) };
  const npc = { guid: 77n, typeId: 3, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 295]]) };
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, player], [77n, npc]]) },
    gameObjectTemplates: new Map(),
    names: { get: () => undefined, declined: () => undefined },
    creatureTemplates: new Map([[295, { found: true, name: "Трактирщик Фарли" }]]),
    itemTemplates: new Map(),
    casts: new Map(),
    events: { on() { return () => {}; } },
    gossip: undefined,
    selectGossipOption() {}, closeGossip() {}, openQuest() {},
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  seam.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; }, now: () => 0 });
  world.gossip = PAGE;
  seam.gossip.owned = true;
  return { seam, fired, player };
}

/** Each row's `isTrivial` (the third value of every group). */
const trivial = (values, width) => values.filter((_, index) => index % width === 2);

test("a quest the player has outgrown is drawn trivial: more than GetQuestGreenRange() levels below", () => {
  const { seam, fired, player } = fixture(60);
  try {
    assert.ok(fired.some(([event]) => event === "GOSSIP_SHOW"), "the page was shown to stock");
    // Level 60: the green range is 12 (Formulas.h), so level 5 is grey and 58 is not; -1 scales.
    assert.deepEqual(trivial(call("GetGossipAvailableQuests", seam), 5), [true, false]);
    assert.deepEqual(trivial(call("GetGossipActiveQuests", seam), 4), [false]);
    // Level 10: range 5, 10 - 5 = 5 is still green; at 11 the level-5 quest turns grey.
    player.fields.set(UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 10);
    assert.deepEqual(trivial(call("GetGossipAvailableQuests", seam), 5), [false, false]);
    player.fields.set(UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 11);
    assert.deepEqual(trivial(call("GetGossipAvailableQuests", seam), 5), [true, false]);
  } finally {
    seam.detach();
  }
});
