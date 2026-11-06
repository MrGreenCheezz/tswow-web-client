// 06.11 (9.05): a name a roster carries is shown at once but is no name answer. Out of sight, Wow.exe 3.3.5a
// answers UnitRace/UnitClass (0x60fd40/0x60fec0 → 0x67d770) and GetRaidRosterInfo's class (0x573690) from the
// name cache entry, so a group member has to be asked. The group list used to write race, sex and class 0 as
// if they were an answer, which also stopped the query for good.
import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { NameCache } from "../dist/code/world/NameQueryProtocol.js";

const answer = (guid, name, race, gender, classId) => ({ guid, known: true, name, realm: "", race, gender, classId, declined: [] });

test("a seeded name is shown but asked for once; an answer ends the asking and outranks a later seed", () => {
  const names = new NameCache();
  names.seed(0x21n, "Аня");
  assert.equal(names.get(0x21n), "Аня");
  assert.equal(names.details(0x21n), undefined, "a group list knows no race, sex or class");
  assert.equal(names.shouldQuery(0x21n), true, "the seed does not count as an answer");
  assert.equal(names.shouldQuery(0x21n), false, "one query at a time");
  assert.equal(names.accept(answer(0x21n, "Аня", 4, 1, 5)), true);
  assert.equal(names.shouldQuery(0x21n), false, "answered");
  names.seed(0x21n, "Аня", { race: 0, gender: 0, classId: 0 });
  assert.deepEqual(names.details(0x21n), { race: 4, gender: 1, classId: 5 }, "a roster row never replaces an answer");
  assert.equal(names.invalidate(0x21n), true);
  assert.equal(names.shouldQuery(0x21n), true, "a rename is asked again");
});

test("a guild roster row's sex and class are kept until an answer brings the race", () => {
  const names = new NameCache();
  names.seed(0x22n, "Боря", { race: 0, gender: 0, classId: 9 });
  assert.deepEqual(names.details(0x22n), { race: 0, gender: 0, classId: 9 });
  assert.equal(names.shouldQuery(0x22n), true);
  names.accept(answer(0x22n, "Боря", 10, 0, 9));
  assert.deepEqual(names.details(0x22n), { race: 10, gender: 0, classId: 9 });
  names.clear();
  assert.equal(names.get(0x22n), undefined);
  assert.equal(names.shouldQuery(0x22n), true, "clear forgets the answers too");
});

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

/** Group::SendUpdateToPlayer (Group.cpp:2040-2095), as tests/framexml-instance-player-difficulty.test.mjs writes it. */
function groupList(members, leader = 0x1234n) {
  const writer = new PacketWriter().u8(1).u8(0).u8(0).u8(0).u64(0x1f000000000001n).u32(3).u32(members.length);
  for (const member of members) writer.cString(member.name).u64(member.guid).u8(1).u8(0).u8(0).u8(0);
  writer.u64(leader);
  if (members.length > 0) writer.u8(0).u64(0n).u8(2).u8(1).u8(3).u8(0);
  return writer.toUint8Array();
}

test("a group list asks each member's name once; the answer then names them out of sight", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  const queried = () => connection.sent.filter((packet) => packet.opcode === OPCODES.CMSG_NAME_QUERY).length;
  const before = queried();
  const members = [{ name: "Аня", guid: 0x55n }, { name: "Боря", guid: 0x56n }];
  connection.push(OPCODES.SMSG_GROUP_LIST, groupList(members));
  await settle();
  assert.equal(client.names.get(0x55n), "Аня", "the list's name is shown at once");
  assert.equal(client.names.details(0x55n), undefined, "and is not taken for an answer");
  assert.equal(queried() - before, 2, "one query per member");
  connection.push(OPCODES.SMSG_GROUP_LIST, groupList(members));
  await settle();
  assert.equal(queried() - before, 2, "a second list asks nothing while the first queries are out");
  connection.push(OPCODES.SMSG_NAME_QUERY_RESPONSE,
    new PacketWriter().packedGuid(0x55n).u8(0).cString("Аня").cString("").u8(4).u8(1).u8(5).u8(0).toUint8Array());
  await settle();
  assert.deepEqual(client.names.details(0x55n), { race: 4, gender: 1, classId: 5 });
  connection.push(OPCODES.SMSG_GROUP_LIST, groupList(members));
  await settle();
  assert.deepEqual(client.names.details(0x55n), { race: 4, gender: 1, classId: 5 }, "the next list keeps the answer");
  assert.equal(queried() - before, 2);
  client.close();
});
