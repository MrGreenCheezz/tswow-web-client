// Plan item 5.28 (04.10, L6): GetInstanceInfo's sixth and seventh values as Wow.exe 3.3.5a 12340 answers them
// (0x51a8c0 reads 0x00bd1980 and Map Flags & 0x100; 0x00bd1980 is written by SMSG_INSTANCE_DIFFICULTY's second
// word at 0x526bcd and by the group list's last byte at 0x6d8fd0; read 2026-10-04).
import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

const { parseGroupList } = await import("../dist/code/world/GroupProtocol.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_DYNAMIC_DIFFICULTY_MAPS } = await import("../dist/code/browser/framexml/FrameXmlInstanceDynamic.js");

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
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  return { client, connection };
}

/** Group::SendUpdateToPlayer (Group.cpp:2040-2095): the loot and difficulty block only with members. */
function groupList({ members = [], leader = 0x1234n, heroic } = {}) {
  const writer = new PacketWriter().u8(1).u8(0).u8(0).u8(0).u64(0x1f000000000001n).u32(3).u32(members.length);
  for (const member of members) writer.cString(member.name).u64(member.guid).u8(1).u8(0).u8(0).u8(0);
  writer.u64(leader);
  if (members.length > 0) {
    writer.u8(0).u64(0n).u8(2).u8(1).u8(3);
    if (heroic !== undefined) writer.u8(heroic);
  }
  return writer.toUint8Array();
}

test("the group list's last byte is read when the block is there", () => {
  assert.equal(parseGroupList(groupList({ members: [{ name: "Б", guid: 0x55n }], heroic: 1 })).raidHeroic, 1);
  assert.equal(parseGroupList(groupList({ members: [{ name: "Б", guid: 0x55n }] })).raidHeroic, undefined, "a short block");
  assert.equal(parseGroupList(groupList()).raidHeroic, undefined, "no members, no block");
});

test("0x00bd1980: the instance packet's second word, then a group list with members; never reset", async () => {
  const { client, connection } = await loggedIn();
  assert.equal(client.instancePlayerDifficulty, 0);
  connection.push(OPCODES.SMSG_INSTANCE_DIFFICULTY, new PacketWriter().u32(2).u32(1).toUint8Array());
  await settle();
  assert.deepEqual([client.instanceDifficulty, client.instancePlayerDifficulty], [2, 1]);
  connection.push(OPCODES.SMSG_NEW_WORLD, new PacketWriter().u32(571).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  await settle();
  assert.deepEqual([client.instanceDifficulty, client.instancePlayerDifficulty], [undefined, 1],
    "the client keeps the word across a world change; the next instance packet replaces it");
  connection.push(OPCODES.SMSG_GROUP_LIST, groupList({ members: [{ name: "Б", guid: 0x55n }], heroic: 0 }));
  await settle();
  assert.equal(client.instancePlayerDifficulty, 0);
  connection.push(OPCODES.SMSG_GROUP_LIST, groupList({ members: [{ name: "Б", guid: 0x55n }], heroic: 1 }));
  await settle();
  assert.equal(client.instancePlayerDifficulty, 1);
  connection.push(OPCODES.SMSG_GROUP_LIST, groupList({ members: [], leader: 0x1234n }));
  await settle();
  assert.equal(client.instancePlayerDifficulty, 1, "a list without members has no block: the word stays");
  connection.push(OPCODES.SMSG_INSTANCE_DIFFICULTY, new PacketWriter().u32(0).u32(0).toUint8Array());
  await settle();
  assert.equal(client.instancePlayerDifficulty, 0);
  client.close();
});

test("GetInstanceInfo: the player difficulty sixth, Map Flags & 0x100 seventh (Icecrown Citadel, Ruby Sanctum)", () => {
  assert.deepEqual([...FRAMEXML_DYNAMIC_DIFFICULTY_MAPS].sort((a, b) => a - b), [631, 724],
    "this dataset's Map.dbc rows with flag 0x100");
  const maps = [
    { id: 631, name: "Цитадель Ледяной Короны", instanceType: 2 },
    { id: 724, name: "Рубиновое святилище", instanceType: 2 },
    { id: 36, name: "Мертвые копи", instanceType: 1 },
  ];
  const world = {
    state: { selfGuid: 0x10n, objects: new Map() }, events: { on: () => () => {} },
    mapId: 631, dungeonDifficulty: 0, raidDifficulty: 0, instanceDifficulty: 2, instancePlayerDifficulty: 1,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {}, sendChatMessage: () => {},
    mapSource: { metadata: () => ({ maps }), location: () => undefined },
  });
  const info = () => FRAMEXML_SEAM_BINDINGS.GetInstanceInfo(seam, []);
  assert.deepEqual(info(), ["Цитадель Ледяной Короны", "raid", 3, "", 10, 1, true]);
  world.mapId = 724;
  world.instanceDifficulty = 0;
  world.instancePlayerDifficulty = 0;
  assert.deepEqual(info().slice(5), [0, true]);
  world.mapId = 36;
  world.instancePlayerDifficulty = 1;
  assert.deepEqual(info().slice(5), [1, false], "the word is answered on any map; the flag is the map's");
});
