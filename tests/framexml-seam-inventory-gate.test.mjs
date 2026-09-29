import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { WorldStore } from "../dist/code/world/WorldStore.js";
import { EventBus } from "../dist/code/world/EventBus.js";

const { FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");

// The stock containers' BAG_UPDATE and the quest log's QUEST_LOG_UPDATE are computed from
// signatures that walk the whole inventory and every quest's text. `WorldStore.any` fires on every
// flush with any change at all — in a crowd, every frame — and used to rebuild both each time.

const SELF = 0x10n;
const ITEM = 0x4000000000000201n;

function object(guid, typeId) {
  return {
    guid, typeId, position: typeId >= 3 ? { x: 0, y: 0, z: 0, orientation: 0 } : undefined,
    movementFlags: 0, updateFlags: 0, targetGuid: undefined, runSpeed: undefined, turnRate: undefined,
    transport: undefined, speeds: undefined, motion: undefined, glide: undefined, transportTime: undefined,
    fields: new Map(),
  };
}

function live() {
  const state = new WorldState();
  const store = new WorldStore(state);
  state.objects.set(SELF, object(SELF, 4));
  state.selfGuid = SELF;
  state.objects.set(ITEM, object(ITEM, 1));
  store.objectCreated(ITEM, 1);
  state.setField(ITEM, UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 13446);
  state.setField(ITEM, UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 2);
  state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, Number(ITEM & 0xffffffffn));
  state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 1, Number(ITEM >> 32n));
  const crowd = [];
  for (let index = 0; index < 200; index += 1) {
    const guid = BigInt(0x2000 + index);
    state.objects.set(guid, object(guid, 4));
    crowd.push(guid);
  }
  store.flush();
  // Every container signature asks the template cache about each carried entry.
  let templateReads = 0;
  const templates = new Map([[13446, { entry: 13446, found: true, name: "Зелье", quality: 1, bagFamily: 0 }]]);
  const itemTemplates = new Map(templates);
  itemTemplates.get = (entry) => { templateReads += 1; return templates.get(entry); };
  let now = 1000;
  const world = {
    state,
    actionButtons: [], casts: new Map(), events: new EventBus(), itemTemplates,
    questTemplates: new Map(), creatureTemplates: new Map(), gameObjectTemplates: new Map(),
    knownSpells: [], auras: new Map(), aurasFor: () => [],
    cooldownRemaining: () => 0,
  };
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    monotonic: () => now,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    itemTexture: () => undefined,
  });
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => now / 1000 });
  store.flush();
  fired.length = 0;
  return {
    state, store, crowd, seam, fired, templates, questTemplates: world.questTemplates,
    get templateReads() { return templateReads; },
    advance(ms) { now += ms; },
    emit(name, payload) { world.events.emit(name, payload); },
  };
}

test("a crowd's flush does not rebuild the containers, an inventory change does at once", () => {
  const world = live();
  const readsBefore = world.templateReads;
  for (let step = 1; step <= 20; step += 1) {
    for (const guid of world.crowd) {
      world.state.move(guid, { flags: 1, position: { x: step, y: 0, z: 0, orientation: 0 } });
      world.state.setField(guid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100 + step);
    }
    world.advance(16);
    world.store.flush();
  }
  assert.equal(world.templateReads, readsBefore, "twenty crowd frames, no container signature");
  assert.deepEqual(world.fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.bagUpdate), []);

  world.state.setField(ITEM, UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 3);
  world.store.flush();
  assert.ok(world.templateReads > readsBefore, "the stack change is looked at");
  assert.deepEqual(world.fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.bagUpdate),
    [[FRAMEXML_SEAM_EVENTS.bagUpdate, 0]], "and repaints the backpack on the same flush");
  world.seam.detach();
});

test("an item answer about somebody else's gear rebuilds nothing; one about a carried item does", () => {
  const world = live();
  const readsBefore = world.templateReads;
  for (let entry = 50_000; entry < 50_200; entry += 1) world.emit("QUERY_CACHE_CHANGED", { kind: "item", id: entry });
  assert.equal(world.templateReads, readsBefore, "two hundred foreign answers, no container signature");
  assert.deepEqual(world.fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.bagUpdate), []);
  world.templates.set(13446, { entry: 13446, found: true, name: "Зелье", quality: 3, bagFamily: 0 });
  world.emit("QUERY_CACHE_CHANGED", { kind: "item", id: 13446 });
  assert.deepEqual(world.fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.bagUpdate),
    [[FRAMEXML_SEAM_EVENTS.bagUpdate, 0]], "the carried potion's new quality repaints its bag at once");
  world.seam.detach();
});

function crowdFrame(world, step) {
  for (const guid of world.crowd) world.state.move(guid, { flags: 1, position: { x: step, y: 0, z: 0, orientation: 0 } });
  world.store.flush();
}

test("a quest counter still reaches QUEST_LOG_UPDATE on its own flush", () => {
  const world = live();
  crowdFrame(world, 1);
  world.advance(10);
  world.fired.length = 0;
  world.state.setField(SELF, UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset, 62);
  world.store.flush();
  assert.ok(world.fired.some(([event]) => event === FRAMEXML_SEAM_EVENTS.questLogUpdate),
    "the quest log word is the quest signature's own input");
  world.seam.detach();
});

test("a cache change with no edge of its own is still published within the seam's 60 ms poll", () => {
  const world = live();
  world.state.setField(SELF, UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset, 62);
  world.store.flush();
  world.fired.length = 0;
  // The template lands in the cache without any event of its own.
  world.questTemplates.set(62, {
    questId: 62, title: "Волки у ворот", objectives: [], itemObjectives: [], rewardItems: [], rewardChoiceItems: [],
  });
  world.advance(20);
  crowdFrame(world, 2);
  assert.deepEqual(world.fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.questLogUpdate), [],
    "inside the poll interval a crowd frame does not rebuild the quest signature");
  world.advance(50);
  crowdFrame(world, 3);
  assert.equal(world.fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.questLogUpdate).length, 1,
    "past it the new title reaches the quest log");
  world.seam.detach();
});
