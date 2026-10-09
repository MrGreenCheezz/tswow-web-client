import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");

/** 5.28: parsed state that now has a correct lifetime and an event for its consumers. */

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  return { client, connection };
}

const heard = (client, name) => {
  const events = [];
  client.events.on(name, (payload) => events.push(payload));
  return events;
};

test("5.28 the instance difficulty belongs to the map: SMSG_NEW_WORLD forgets it", async () => {
  const { client, connection } = await loggedIn();
  // Player::SendInitialPacketsBeforeAddToMap: u32 GetMap()->GetDifficulty(), u32 dynamic.
  connection.push(OPCODES.SMSG_INSTANCE_DIFFICULTY, new PacketWriter().u32(1).u32(0).toUint8Array());
  await settle();
  assert.equal(client.instanceDifficulty, 1);
  connection.push(OPCODES.SMSG_NEW_WORLD, new PacketWriter().u32(571).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  await settle();
  assert.equal(client.instanceDifficulty, undefined, "a heroic's mode must not outlive the heroic");
  connection.push(OPCODES.SMSG_INSTANCE_DIFFICULTY, new PacketWriter().u32(0).u32(0).toUint8Array());
  await settle();
  assert.equal(client.instanceDifficulty, 0);
  client.close();
});

test("5.28 SMSG_TAXINODE_STATUS is announced and readable per flight master", async () => {
  const { client, connection } = await loggedIn();
  const events = heard(client, "TAXI_NODE_STATUS_CHANGED");
  connection.push(OPCODES.SMSG_TAXINODE_STATUS, new PacketWriter().u64(0xf130000aaan).u8(1).toUint8Array());
  await settle();
  assert.deepEqual(events, [{ guid: 0xf130000aaan, known: true }]);
  assert.equal(client.taxiNodeKnown(0xf130000aaan), true);
  assert.equal(client.taxiNodeKnown(1n), undefined);
  client.close();
});

test("5.28 SMSG_LOOT_LIST is announced and both owners are asked for by name", async () => {
  const { client, connection } = await loggedIn();
  const events = heard(client, "LOOT_LIST_CHANGED");
  connection.sent.length = 0;
  // Loot::NotifyLootList / Unit.cpp: u64 corpse, packed master looter, packed round-robin owner.
  connection.push(OPCODES.SMSG_LOOT_LIST, new PacketWriter().u64(0xf1300000bbn).packedGuid(0x21n).packedGuid(0n).toUint8Array());
  await settle();
  assert.deepEqual(events, [{ corpseGuid: 0xf1300000bbn }]);
  assert.equal(client.lootOwners?.masterLooterGuid, 0x21n);
  assert.equal(connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_NAME_QUERY).length, 1,
    "the master looter is named; an empty owner is not asked for");
  client.close();
});

test("5.28 an item's text arrives with its own event and rides along when the item is read", async () => {
  const { client, connection } = await loggedIn();
  const received = heard(client, "ITEM_TEXT_RECEIVED");
  const opened = heard(client, "ITEM_TEXT_OPENED");
  connection.push(OPCODES.SMSG_ITEM_TEXT_QUERY_RESPONSE,
    new PacketWriter().u8(0).u64(0x4000000000000077n).cString("Дорогой друг…").toUint8Array());
  await settle();
  assert.deepEqual(received, [{ guid: 0x4000000000000077n }]);
  assert.equal(client.itemText(0x4000000000000077n), "Дорогой друг…");
  connection.push(OPCODES.SMSG_READ_ITEM_OK, new PacketWriter().u64(0x4000000000000077n).toUint8Array());
  await settle();
  assert.deepEqual(opened, [{ kind: "item", guid: 0x4000000000000077n, text: "Дорогой друг…" }]);
  client.close();
});

test("5.28 GetInstanceInfo reads the map's difficulty, not the player's choice (Wow.exe 0x51a8c0)", () => {
  const maps = [{ id: 631, name: "Цитадель Ледяной Короны", instanceType: 2 }];
  const world = {
    state: { selfGuid: 0x10n, objects: new Map() }, events: { on: () => () => {} },
    mapId: 631, dungeonDifficulty: 0, raidDifficulty: 0, instanceDifficulty: 1,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {}, sendChatMessage: () => {},
    mapSource: { metadata: () => ({ maps }), location: () => undefined },
  });
  const info = () => FRAMEXML_SEAM_BINDINGS.GetInstanceInfo(seam, []);
  // 5.28 (04.10, L6): the seventh value is Map Flags & 0x100, set for Icecrown Citadel.
  assert.deepEqual(info(), ["Цитадель Ледяной Короны", "raid", 2, "", 25, 0, true],
    "the server put the raid in 25-player mode although the selection says 10");
  world.instanceDifficulty = undefined;
  assert.deepEqual(info()[2], 1, "before the map's packet the selection is all there is");
});
