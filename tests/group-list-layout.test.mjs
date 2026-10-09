// Plan item 5.28, review of L6 (04.10): SMSG_GROUP_LIST byte for byte as TrinityCore writes it
// (Group::SendUpdateToPlayer, Group.cpp:2040-2093): u8 type, u8 subgroup, u8 flags, u8 roles, [LFG: u8 + u32],
// u64 group guid, u32 counter, u32 count, per member (cstring name, u64 guid, u8 online, u8 group, u8 flags,
// u8 roles), u64 leader, then only with members: u8 loot method, u64 master looter, u8 threshold,
// u8 dungeon difficulty, u8 raid difficulty, u8 «raid difficulty ≥ 10 heroic». The L6 `raidHeroic` byte is the
// packet's last; every field before it must read as before.
import assert from "node:assert/strict";
import test from "node:test";

const { parseGroupList, GROUPTYPE_RAID, GROUPTYPE_LFG, LOOT_METHOD_MASTER } = await import("../dist/code/world/GroupProtocol.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");

function packet({ type, lfg = false, members, leader, block, heroic }) {
  const writer = new PacketWriter().u8(type | (lfg ? GROUPTYPE_LFG : 0)).u8(3).u8(1).u8(4);
  if (lfg) writer.u8(2).u32(285);
  writer.u64(0x1f50_0000_0000_0042n).u32(17).u32(members.length);
  for (const member of members) {
    writer.cString(member.name).u64(member.guid).u8(member.status).u8(member.subGroup).u8(member.flags).u8(member.roles);
  }
  writer.u64(leader);
  if (block) {
    writer.u8(block.method).u64(block.master).u8(block.threshold).u8(block.dungeon).u8(block.raid);
    if (heroic !== undefined) writer.u8(heroic);
  }
  return writer.toUint8Array();
}

function members(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: index % 2 ? `Член${index}` : `M${"x".repeat(index)}`, guid: 0x100n + BigInt(index),
    status: index % 3 ? 1 : 3, subGroup: Math.floor(index / 5), flags: index % 4, roles: index % 8,
  }));
}

function expectList(state, { type, lfg = false, members: list, leader, block, heroic }) {
  assert.equal(state.groupType, type | (lfg ? GROUPTYPE_LFG : 0));
  assert.deepEqual([state.ownSubGroup, state.ownFlags, state.ownRoles], [3, 1, 4]);
  assert.equal(state.guid, 0x1f50_0000_0000_0042n);
  assert.equal(state.counter, 17);
  assert.deepEqual(state.members.map((member) => [member.name, member.guid, member.status, member.subGroup, member.flags, member.roles]),
    list.map((member) => [member.name, member.guid, member.status, member.subGroup, member.flags, member.roles]));
  assert.equal(state.leaderGuid, leader);
  if (block) {
    assert.deepEqual([state.lootMethod, state.masterLooterGuid, state.lootThreshold, state.dungeonDifficulty, state.raidDifficulty],
      [block.method, block.master, block.threshold, block.dungeon, block.raid]);
  } else {
    assert.deepEqual([state.lootMethod, state.masterLooterGuid, state.lootThreshold], [0, 0n, 0]);
  }
  assert.equal(state.raidHeroic, heroic);
}

test("raid lists of 1..39 others with the full 13-byte block: every field, then the heroic byte", () => {
  for (let count = 1; count <= 39; count++) {
    for (const lfg of [false, true]) {
      const shape = {
        type: GROUPTYPE_RAID, lfg, members: members(count), leader: 0x100n + BigInt(count - 1),
        block: { method: LOOT_METHOD_MASTER, master: 0x0000_0000_0000_0ab1n, threshold: 3, dungeon: 1, raid: count % 4 },
        heroic: count % 4 >= 2 ? 1 : 0,
      };
      expectList(parseGroupList(packet(shape)), shape);
    }
  }
});

test("a party list, a list cut after the raid difficulty, and a list without members", () => {
  const party = { type: 0, members: members(4), leader: 0x101n,
    block: { method: 2, master: 0x101n, threshold: 2, dungeon: 0, raid: 0 }, heroic: 0 };
  expectList(parseGroupList(packet(party)), party);
  const short = { ...party, heroic: undefined };
  expectList(parseGroupList(packet(short)), short);
  const alone = { type: 0, members: [], leader: 0x77n, block: undefined, heroic: undefined };
  expectList(parseGroupList(packet(alone)), alone);
});
