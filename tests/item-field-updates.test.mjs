import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import {
  itemEnchantTimeUpdatePacket, settle, socketGemsResultPacket, travelClient,
} from "./fixtures/world-packets.mjs";

// 1.25 (2). SMSG_ITEM_ENCHANT_TIME_UPDATE and SMSG_SOCKET_GEMS_RESULT correct an item's fields
// outside an update block. Writing into `fields` directly skipped `revision` and the observer, so
// the WorldStore never heard and an open item window kept the old enchantment until reopened. And
// an item this client never saw must not be invented by the correction.
const SELF = 0x1234n;
const ITEM = 0x4000_0000_0000_0101n;
const STRANGER = 0x4000_0000_0000_0999n;
const ENCHANTMENT = UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset;

function spy(state) {
  const calls = [];
  state.observer = {
    fieldsChanged: (guid, indices) => calls.push({ guid, indices: [...indices] }),
    objectCreated: (guid) => calls.push({ created: guid }),
    objectDestroyed: () => {},
    objectMoved: () => {},
    selfChanged: () => {},
  };
  return calls;
}

test("patchField corrects a known object and reports it, and invents nothing", () => {
  const state = new WorldState();
  state.setField(ITEM, ENCHANTMENT, 7);
  const calls = spy(state);
  const revision = state.revision;
  assert.equal(state.patchField(ITEM, ENCHANTMENT + 1, 60_000), true);
  assert.equal(state.objects.get(ITEM).fields.get(ENCHANTMENT + 1), 60_000);
  assert.equal(state.revision, revision + 1);
  assert.deepEqual(calls, [{ guid: ITEM, indices: [ENCHANTMENT + 1] }]);
  assert.equal(state.patchField(STRANGER, ENCHANTMENT, 1), false);
  assert.equal(state.objects.has(STRANGER), false, "a correction is not a create");
  assert.equal(state.revision, revision + 1);
  assert.equal(calls.length, 1);
});

test("an enchantment's remaining time reaches the store as a field change", async () => {
  const { client, connection } = await travelClient([], SELF);
  client.state.setField(ITEM, UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 2589);
  const calls = spy(client.state);
  const events = [];
  client.events.on("ITEM_ENCHANT_TIME_UPDATE", (update) => events.push(update));
  try {
    // Player::AddEnchantmentDuration hands the time left in whole seconds (ItemHandler.cpp:851).
    connection.push(OPCODES.SMSG_ITEM_ENCHANT_TIME_UPDATE, itemEnchantTimeUpdatePacket({ item: ITEM, slot: 1, seconds: 90, player: SELF }));
    connection.push(OPCODES.SMSG_ITEM_ENCHANT_TIME_UPDATE, itemEnchantTimeUpdatePacket({ item: STRANGER, slot: 0, seconds: 30, player: SELF }));
    await settle();
    const duration = ENCHANTMENT + 1 * 3 + 1;
    assert.deepEqual(calls, [{ guid: ITEM, indices: [duration] }]);
    assert.equal(client.state.objects.get(ITEM).fields.get(duration), 90_000, "milliseconds, like the field");
    assert.equal(client.state.objects.has(STRANGER), false);
    assert.deepEqual(events.map((event) => event.itemGuid), [ITEM, STRANGER], "the event still speaks for both");
  } finally {
    client.close();
  }
});

test("socketed gems reach the store as field changes", async () => {
  const { client, connection } = await travelClient([], SELF);
  client.state.setField(ITEM, UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 40_000);
  const calls = spy(client.state);
  const events = [];
  client.events.on("SOCKET_GEMS_RESULT", (result) => events.push(result));
  try {
    // Item::SendUpdateSockets: SOCK_ENCHANTMENT_SLOT (2) … BONUS_ENCHANTMENT_SLOT (5), id words.
    connection.push(OPCODES.SMSG_SOCKET_GEMS_RESULT, socketGemsResultPacket(ITEM, [3312, 3313, 0, 3314]));
    connection.push(OPCODES.SMSG_SOCKET_GEMS_RESULT, socketGemsResultPacket(STRANGER, [1, 2, 3, 4]));
    await settle();
    const slots = [2, 3, 4, 5].map((slot) => ENCHANTMENT + slot * 3);
    assert.deepEqual(calls.flatMap((call) => call.indices), slots);
    assert.ok(calls.every((call) => call.guid === ITEM));
    assert.deepEqual(slots.map((index) => client.state.objects.get(ITEM).fields.get(index)), [3312, 3313, 0, 3314]);
    assert.equal(client.state.objects.has(STRANGER), false);
    assert.equal(events.length, 2);
  } finally {
    client.close();
  }
});
