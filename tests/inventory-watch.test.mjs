import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { WorldStore } from "../dist/code/world/WorldStore.js";
import { InventoryWatch, inventoryWatch, playerInventory } from "../dist/code/browser/Inventory.js";

// In a crowd the store changes every frame, and two consumers rebuilt the player's inventory on
// every one of those flushes: the bags' redraw guard and the stock containers' signatures. Nothing a
// crowd sends can move a slot, so the watch tells them when something that can move one did.

const SELF = 0x10n;
const ITEM = 0x4000000000000101n;
const BAG = 0x4000000000000102n;
const IN_BAG = 0x4000000000000103n;

function put(state, guid, offset, value) {
  state.setField(guid, offset, Number(value & 0xffffffffn));
  state.setField(guid, offset + 1, Number(value >> 32n));
}

/** A player with one backpack item and one bag holding one item, then a crowd of 300 around. */
function crowdedWorld() {
  const state = new WorldState();
  const store = new WorldStore(state);
  const create = (guid, typeId) => {
    state.objects.set(guid, {
      guid, typeId, position: typeId >= 3 ? { x: 0, y: 0, z: 0, orientation: 0 } : undefined,
      movementFlags: 0, updateFlags: 0, targetGuid: undefined, runSpeed: undefined, turnRate: undefined,
      transport: undefined, speeds: undefined, motion: undefined, glide: undefined, transportTime: undefined,
      fields: new Map(),
    });
    store.objectCreated(guid, typeId);
  };
  create(SELF, 4);
  state.selfGuid = SELF;
  create(ITEM, 1);
  create(BAG, 2);
  create(IN_BAG, 1);
  state.setField(ITEM, UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 2589);
  state.setField(ITEM, UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 5);
  state.setField(BAG, UPDATE_FIELDS.CONTAINER_FIELD_NUM_SLOTS.offset, 4);
  put(state, BAG, UPDATE_FIELDS.CONTAINER_FIELD_SLOT_1.offset, IN_BAG);
  state.setField(IN_BAG, UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 858);
  put(state, SELF, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, ITEM);
  put(state, SELF, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 19 * 2, BAG);
  const crowd = [];
  for (let index = 0; index < 300; index += 1) {
    const guid = BigInt(0x1000 + index);
    create(guid, 4);
    crowd.push(guid);
  }
  store.flush();
  return { state, store, crowd };
}

function crowdTraffic({ state, crowd }, step) {
  for (const guid of crowd) {
    state.move(guid, { flags: 1, position: { x: step, y: Number(guid & 0xffn), z: 0, orientation: 0 } });
    state.setField(guid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 1000 - step);
    put(state, guid, UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset, BigInt(40_000 + step));
  }
  // An unknown creature's movement creates its object implicitly, without a type.
  state.move(0xF130000000001234n + BigInt(step), { flags: 0, position: { x: 1, y: 1, z: 0, orientation: 0 } });
}

test("a crowd's movement, fields and arrivals do not move the watch", () => {
  const world = crowdedWorld();
  const watch = inventoryWatch(world.store);
  assert.equal(inventoryWatch(world.store), watch, "one watch per store");
  const revision = watch.revision;
  for (let step = 1; step <= 5; step += 1) {
    crowdTraffic(world, step);
    // The player's own health and position are not inventory either.
    world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 500 + step);
    world.state.move(SELF, { flags: 1, position: { x: step, y: 0, z: 0, orientation: 0 } });
    world.store.flush();
    assert.equal(watch.revision, revision, `crowd frame ${step}`);
  }
});

test("every input of the inventory moves the watch on the flush that carries it", () => {
  const world = crowdedWorld();
  const { state, store } = world;
  const watch = new InventoryWatch(store);
  const moves = (label, change) => {
    const before = watch.revision;
    change();
    assert.equal(watch.revision, before, `${label}: nothing until the flush`);
    store.flush();
    assert.notEqual(watch.revision, before, label);
  };
  moves("a slot of the player's own", () => put(state, SELF, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 2, ITEM));
  moves("a stack count", () => state.setField(ITEM, UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 6));
  moves("a bag's own slot", () => put(state, BAG, UPDATE_FIELDS.CONTAINER_FIELD_SLOT_1.offset + 2, ITEM));
  moves("an item inside a bag", () => state.setField(IN_BAG, UPDATE_FIELDS.ITEM_FIELD_DURABILITY.offset, 10));
  moves("coinage", () => state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset, 12345));
  moves("bank bag slots bought", () => state.setField(SELF, UPDATE_FIELDS.PLAYER_BYTES_2.offset, 0x020000));
  moves("an item destroyed", () => state.destroy(IN_BAG));
  moves("an item met before its create block", () => state.setField(0x4000000000000999n, UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 6948));
  moves("the character itself", () => { state.selfGuid = undefined; });
  const beforeCrowd = watch.revision;
  crowdTraffic(world, 9);
  store.flush();
  assert.equal(watch.revision, beforeCrowd, "and still nothing for the crowd");
  // The inventory the consumers build is what the watch vouches for.
  state.selfGuid = SELF;
  store.flush();
  assert.equal(playerInventory(state)?.backpack[0]?.item?.fields.get(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset), 6);
});

test("a detached store vouches for nothing: every read is a change", () => {
  const world = crowdedWorld();
  const watch = inventoryWatch(world.store);
  const first = watch.revision;
  assert.equal(watch.revision, first);
  world.store.detach();
  assert.notEqual(watch.revision, first);
  assert.notEqual(watch.revision, watch.revision);
});
