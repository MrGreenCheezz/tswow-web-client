// 06.11 (3.69): a sign, a plaque or a book (game object type 9, TEXT) is read by the client itself, as Wow.exe does:
// the type-9 helper's use (0x0070C850) opens the reader instead of sending CMSG_GAMEOBJ_USE, and 0x0070F680
// still sends the report. Its reach is the helper's own 5.5555553 yards (0x00A33570), not the default five.
import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  GO_TYPE_GOOBER, GO_TYPE_TEXT, interactionDistance, interactiveGameObjectType, usableByHand,
} from "../dist/code/world/GameObjectProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const SIGN = 0xF110000180000903n;

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
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

async function client() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(connection);
  await world.loginCharacter(0x1234n);
  await settle();
  connection.sent.length = 0;
  return { connection, world };
}

test("a text object is offered to the hand, at the helper's own reach, and never to the server's use", () => {
  assert.equal(interactiveGameObjectType(GO_TYPE_TEXT), true);
  assert.equal(usableByHand(GO_TYPE_TEXT), false, "GameObject::Use has no case for type 9");
  assert.equal(interactionDistance(GO_TYPE_TEXT), 5.5555553);
  assert.equal(interactiveGameObjectType(GO_TYPE_GOOBER), true, "a goober stays the server's");
});

test("reading a text object opens the reader on it and sends the report alone", async () => {
  const { connection, world } = await client();
  world.state.objects.set(SIGN, { guid: SIGN, typeId: 5, fields: new Map([[ENTRY, 3290]]) });
  const opened = [];
  world.events.on("ITEM_TEXT_OPENED", (event) => opened.push(event));
  world.readGameObject(SIGN);
  assert.deepEqual(opened, [{ kind: "object", guid: SIGN }]);
  assert.equal(world.openPageObject, SIGN);
  const names = connection.sent.map(({ opcode }) => opcode);
  assert.equal(names.includes(OPCODES.CMSG_GAMEOBJ_USE), false, "Wow.exe's type-9 helper sends no use");
  const report = connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_GAMEOBJ_REPORT_USE);
  assert.equal(report.length, 1);
  assert.equal(new PacketReader(report[0].payload).u64(), SIGN);
  const query = connection.sent.find(({ opcode }) => opcode === OPCODES.CMSG_GAMEOBJECT_QUERY);
  assert.ok(query, "the page is in the template, which is asked for when it is not cached");
  assert.equal(new PacketReader(query.payload).u32(), 3290);
});

test("nothing is read off an object that is gone or is not a game object", async () => {
  const { connection, world } = await client();
  const opened = [];
  world.events.on("ITEM_TEXT_OPENED", (event) => opened.push(event));
  world.readGameObject(SIGN);
  world.state.objects.set(0x77n, { guid: 0x77n, typeId: 3, fields: new Map([[ENTRY, 1]]) });
  world.readGameObject(0x77n);
  assert.deepEqual(opened, []);
  assert.deepEqual(connection.sent, []);
});
