import assert from "node:assert/strict";
import test from "node:test";
import {
  GROUPTYPE_LFG,
  MEMBER_FLAG_ASSISTANT,
  MEMBER_STATUS_ONLINE,
  buildGroupAccept,
  buildGroupInvite,
  buildGroupUninvite,
  parseGroupDecline,
  parseGroupInvite,
  parseGroupList,
  parsePartyCommandResult,
  partyResultText,
} from "../dist/code/world/GroupProtocol.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

const encoder = new TextEncoder();
function bytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const u8 = (value) => Uint8Array.from([value & 0xff]);
const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const u64 = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};
const cstr = (value) => bytes(encoder.encode(value), u8(0));

// Group::SendUpdateToPlayer: header, members without the receiver, leader, then the loot block.
function groupList({ groupType = 0, members = [], leader = 0n, withLoot = true }) {
  const head = [u8(groupType), u8(0), u8(0), u8(0)];
  if (groupType & GROUPTYPE_LFG) head.push(u8(0), u32(0));
  head.push(u64(0x1f50_0000_0000_0001n), u32(7), u32(members.length));
  for (const member of members) {
    head.push(cstr(member.name), u64(member.guid), u8(member.status), u8(member.subGroup), u8(member.flags), u8(member.roles));
  }
  head.push(u64(leader));
  if (members.length > 0 && withLoot) head.push(u8(1), u64(0n), u8(2), u8(0), u8(0), u8(0));
  return bytes(...head);
}

test("group list decodes members, leader and the loot block", () => {
  const payload = groupList({
    members: [
      { name: "Тралл", guid: 0x11n, status: MEMBER_STATUS_ONLINE, subGroup: 0, flags: MEMBER_FLAG_ASSISTANT, roles: 0 },
      { name: "Джайна", guid: 0x22n, status: 0, subGroup: 0, flags: 0, roles: 2 },
    ],
    leader: 0x11n,
  });
  const group = parseGroupList(payload);
  assert.equal(group.members.length, 2);
  assert.equal(group.members[0].name, "Тралл");
  assert.equal(group.members[0].online, true);
  assert.equal(group.members[0].flags, MEMBER_FLAG_ASSISTANT);
  assert.equal(group.members[1].online, false, "status without the online bit");
  assert.equal(group.leaderGuid, 0x11n);
  assert.equal(group.lootMethod, 1);
  assert.equal(group.lootThreshold, 2);
  assert.equal(group.counter, 7);
});

test("an LFG group carries two extra header fields", () => {
  const payload = groupList({
    groupType: GROUPTYPE_LFG,
    members: [{ name: "A", guid: 0x33n, status: MEMBER_STATUS_ONLINE, subGroup: 0, flags: 0, roles: 0 }],
    leader: 0x33n,
  });
  const group = parseGroupList(payload);
  assert.equal(group.groupType, GROUPTYPE_LFG);
  assert.equal(group.members[0].guid, 0x33n);
  assert.equal(group.leaderGuid, 0x33n);
});

test("a group of one has no loot block at all", () => {
  const group = parseGroupList(groupList({ members: [], leader: 0x11n }));
  assert.deepEqual(group.members, []);
  assert.equal(group.leaderGuid, 0x11n);
  assert.equal(group.lootMethod, 0);
});

test("an implausible member count is rejected", () => {
  assert.throws(() => parseGroupList(bytes(u8(0), u8(0), u8(0), u8(0), u64(1n), u32(0), u32(9999))), RangeError);
});

test("invites, declines and command results decode", () => {
  const invite = parseGroupInvite(bytes(u8(1), cstr("Тралл"), u32(0), u8(0), u32(0)));
  assert.deepEqual(invite, { canAccept: true, inviterName: "Тралл", proposedRoles: 0 });

  assert.equal(parseGroupDecline(cstr("Джайна")), "Джайна");

  const result = parsePartyCommandResult(bytes(u32(0), cstr("Кто-то"), u32(5), u32(0)));
  assert.deepEqual(result, { operation: 0, member: "Кто-то", result: 5, value: 0 });
  assert.match(partyResultText(5, "Кто-то"), /уже в группе/i);
  assert.match(partyResultText(99, ""), /99/);
});

test("client group packets match their handlers", () => {
  // PartyInviteClient::Read takes the name first, then the proposed roles.
  assert.deepEqual([...buildGroupInvite("Тралл")], [...bytes(cstr("Тралл"), u32(0))]);
  // HandleGroupAcceptOpcode skips a uint32 it never reads.
  assert.deepEqual([...buildGroupAccept()], [0, 0, 0, 0]);
  assert.deepEqual([...buildGroupUninvite(0x11n)], [...bytes(u64(0x11n), cstr(""))]);
});

function connection() {
  const packets = [];
  const sent = [];
  let wake;
  return {
    sent,
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (wake) { const resolve = wake; wake = undefined; resolve(packet); }
      else packets.push(packet);
    },
    read() { return packets.length ? Promise.resolve(packets.shift()) : new Promise((resolve) => { wake = resolve; }); },
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); },
    close() {},
  };
}

async function settle() { for (let index = 0; index < 6; index++) await new Promise(setImmediate); }

async function worldFixture() {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const world = new WorldClient(transport);
  await world.loginCharacter(13n);
  await settle();
  return { world, transport };
}

test("leaving, promoting and resetting instances are what their handlers read", async () => {
  const { world, transport } = await worldFixture();
  try {
    transport.sent.length = 0;
    world.leaveGroup();
    world.setGroupLeader(0x77n);
    world.resetInstances();
    assert.deepEqual(transport.sent.map(({ opcode, payload }) => [opcode, [...payload]]), [
      // HandleGroupDisbandOpcode and HandleResetInstancesOpcode read nothing (GroupHandler.cpp:396,
      // MiscHandler.cpp:1294); HandleGroupSetLeaderOpcode a raw guid.
      [OPCODES.CMSG_GROUP_DISBAND, []],
      [OPCODES.CMSG_GROUP_SET_LEADER, [...u64(0x77n)]],
      [OPCODES.CMSG_RESET_INSTANCES, []],
    ]);
  } finally { world.close(); }
});

test("the list that tells the player they are out ends the group; a group of one stays one", async () => {
  const { world, transport } = await worldFixture();
  try {
    let changes = 0;
    world.onGroupChanged = () => { changes += 1; };
    // 2026-09-28: a dungeon-finder group of the player and four NPCBot dungeon bots — creature GUIDs,
    // always online — as Group::SendUpdateToPlayer writes it for the player who leads it.
    const bot = (entry, low) => (0xf130n << 48n) | (BigInt(entry) << 24n) | BigInt(low);
    transport.push(OPCODES.SMSG_GROUP_LIST, groupList({
      groupType: GROUPTYPE_LFG,
      leader: 13n,
      members: [["Lotheolan", 100644], ["Ruada", 100645], ["Valaatu", 100646], ["Erion", 100647]].map(([name, entry], index) => (
        { name, guid: bot(entry, index + 1), status: MEMBER_STATUS_ONLINE, subGroup: 0, flags: 0, roles: 8 })),
    }));
    await settle();
    assert.equal(world.group?.members.length, 4);
    assert.equal(changes, 1);

    // Group::RemoveMember's answer to the leaver, byte for byte (Group.cpp:821-824); a plain leave
    // sends no SMSG_GROUP_DESTROYED with it.
    transport.push(OPCODES.SMSG_GROUP_LIST,
      bytes(u8(0x10), u8(0), u8(0), u8(0), u64(0x1f50_0000_0000_0001n), u32(8), u32(0), u64(0n)));
    await settle();
    assert.equal(world.group, undefined, "no members and no leader: the player is in no group");
    assert.equal(changes, 2, "and the seam hears it, as it does SMSG_GROUP_DESTROYED");

    transport.push(OPCODES.SMSG_GROUP_LIST, groupList({ members: [], leader: 0x11n }));
    await settle();
    assert.equal(world.group?.leaderGuid, 0x11n, "a group of one names its leader and stays a group");
    assert.equal(changes, 3);
  } finally { world.close(); }
});
