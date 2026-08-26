import assert from "node:assert/strict";
import test from "node:test";
import {
  allMembers, groupMenuItems, hasLootRules, isRaid, mayManage, memberOf, selfMember, subGroupOptions,
} from "../dist/code/browser/ui/GroupModel.js";
import {
  GROUPTYPE_RAID, LOOT_METHOD_MASTER, MEMBER_FLAG_ASSISTANT, MEMBER_FLAG_MAINTANK,
  buildGroupAssistantLeader, buildGroupChangeSubGroup, buildGroupRaidConvert, buildGroupSetLeader,
  buildLootMethod, buildRequestPartyMemberStats, lootMethodName, lootThresholdName,
} from "../dist/code/world/GroupProtocol.js";

const SELF = 1n;
const OTHER = 2n;

function member(guid, extra = {}) {
  return { name: `И${guid}`, guid, online: true, status: 1, subGroup: 0, flags: 0, roles: 0, ...extra };
}

function group(extra = {}) {
  return {
    groupType: 0, ownSubGroup: 0, ownFlags: 0, ownRoles: 0, guid: 9n, counter: 1,
    members: [member(OTHER)], leaderGuid: SELF, lootMethod: 0, masterLooterGuid: 0n,
    lootThreshold: 2, dungeonDifficulty: 0, raidDifficulty: 0, ...extra,
  };
}

test("the leader may manage, and in a raid so may an assistant", () => {
  assert.equal(mayManage(group(), SELF), true, "leader");
  assert.equal(mayManage(group({ leaderGuid: OTHER }), SELF), false, "a plain party member may not");
  // The player's own assistant bit is in the header, because `members` never contains the player.
  const raid = group({ groupType: GROUPTYPE_RAID, leaderGuid: OTHER, ownFlags: MEMBER_FLAG_ASSISTANT });
  assert.equal(mayManage(raid, SELF), true, "an assistant may, but only in a raid");
  assert.equal(mayManage(group({ leaderGuid: OTHER, ownFlags: MEMBER_FLAG_ASSISTANT }), SELF), false);
});

test("a party offers converting to a raid and a raid offers subgroups", () => {
  const party = groupMenuItems({ group: group(), selfGuid: SELF, targetGuid: OTHER, targetName: "И2" });
  assert.ok(party.some((entry) => entry.id === "convert"));
  assert.ok(!party.some((entry) => entry.id === "subgroup"));

  const raid = groupMenuItems({
    group: group({ groupType: GROUPTYPE_RAID }), selfGuid: SELF, targetGuid: OTHER, targetName: "И2",
  });
  assert.ok(raid.some((entry) => entry.id === "subgroup"));
  assert.ok(!raid.some((entry) => entry.id === "convert"));
  assert.equal(isRaid(group({ groupType: GROUPTYPE_RAID })), true);
});

test("a member who is not the leader gets a greyed kick rather than none at all", () => {
  const rows = groupMenuItems({
    group: group({ leaderGuid: OTHER }), selfGuid: SELF, targetGuid: OTHER, targetName: "И2",
  });
  const kick = rows.find((entry) => entry.id === "kick");
  assert.ok(kick, "the row is there");
  assert.equal(kick.enabled, false, "greyed, so the player can see why nothing happens");
  assert.equal(kick.danger, true);
});

test("nobody is offered a kick on themselves", () => {
  const rows = groupMenuItems({ group: group(), selfGuid: SELF, targetGuid: SELF, targetName: "И1" });
  assert.equal(rows.find((entry) => entry.id === "kick").enabled, false);
  assert.equal(rows.find((entry) => entry.id === "leader").enabled, false);
});

test("a solo group has no loot rules, and the menu does not pretend it does", () => {
  // SMSG_GROUP_LIST writes the loot block only when there are members; with none, all three
  // fields read zero, which would print «Свободно для всех, бедное качество».
  const solo = group({ members: [] });
  assert.equal(hasLootRules(solo), false);
  const rows = groupMenuItems({ group: solo, selfGuid: SELF, targetGuid: OTHER, targetName: "И2" });
  assert.ok(!rows.some((entry) => entry.id === "loot"));
  assert.equal(hasLootRules(group()), true);
});

test("the player's own row is synthesized, because the packet leaves it out", () => {
  const raid = group({ groupType: GROUPTYPE_RAID, ownSubGroup: 3, ownFlags: MEMBER_FLAG_MAINTANK });
  const self = selfMember(raid, SELF, "Аллея");
  assert.equal(self.subGroup, 3);
  assert.equal(self.flags, MEMBER_FLAG_MAINTANK);

  const rows = allMembers(raid, SELF, "Аллея");
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.guid === SELF), "the player is in the list they are managing");
  assert.equal(memberOf(raid, OTHER)?.guid, OTHER);
  assert.equal(memberOf(raid, SELF), undefined, "and is still not in the packet's own list");
});

test("there are eight subgroups, numbered from zero on the wire", () => {
  assert.deepEqual(subGroupOptions(), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("the loot rules have names, and an unknown one says its number", () => {
  assert.equal(lootMethodName(LOOT_METHOD_MASTER), "Ответственный за добычу");
  assert.equal(lootMethodName(99), "Способ 99");
  assert.equal(lootThresholdName(4), "Эпический");
});

test("making somebody leader sends a raw guid and nothing else", () => {
  const payload = buildGroupSetLeader(0x1122334455667788n);
  assert.equal(payload.length, 8);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  assert.equal(view.getBigUint64(0, true), 0x1122334455667788n);
});

test("converting to a raid carries no body at all", () => {
  assert.equal(buildGroupRaidConvert().length, 0);
});

test("the loot method carries the master and the threshold with it", () => {
  // The server reads all three out of one packet and refuses a method above NEED_BEFORE_GREED,
  // so they cannot be changed one at a time.
  const payload = buildLootMethod(LOOT_METHOD_MASTER, 0x42n, 3);
  assert.equal(payload.length, 16);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  assert.equal(view.getUint32(0, true), LOOT_METHOD_MASTER);
  assert.equal(view.getBigUint64(4, true), 0x42n);
  assert.equal(view.getUint32(12, true), 3);
});

test("the assistant flag goes on and off with one byte", () => {
  assert.equal(buildGroupAssistantLeader(0x42n, true).at(8), 1);
  assert.equal(buildGroupAssistantLeader(0x42n, false).at(8), 0);
  assert.equal(buildGroupAssistantLeader(0x42n, true).length, 9);
});

test("a subgroup move goes by name, because that is what the server reads", () => {
  const payload = buildGroupChangeSubGroup("Аллея", 3);
  assert.equal(payload.at(payload.length - 1), 3, "the subgroup is the last byte");
  assert.equal(payload.at(payload.length - 2), 0, "and the name before it is null terminated");
  assert.equal(buildRequestPartyMemberStats(0x42n).length, 8);
});
