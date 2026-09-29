import assert from "node:assert/strict";
import test from "node:test";

// The group commands of the unit menus, SecureTemplates and the raid slash commands
// (FrameXmlGroupCommands.ts) over the live seam and a recording world: who a token or a name is,
// which packet goes out, and GetPartyAssignment's client-shaped 1/nil.
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_GROUP_COMMAND_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlGroupCommands.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const SELF = 0x10n;
const TANK = 0x21n;
const HEALER = 0x22n;
const ROGUE = 0x23n;
const STRANGER = 0x99n;
const member = (guid, name, flags = 0) => ({ guid, name, online: true, status: 1, subGroup: 0, flags, roles: 0 });

function fixture(group) {
  const calls = [];
  const objects = new Map([
    [SELF, { guid: SELF, typeId: 4, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x08]]) }],
    [STRANGER, { guid: STRANGER, typeId: 4, fields: new Map() }],
  ]);
  const world = {
    state: { selfGuid: SELF, objects },
    selfName: "Тестовый",
    targetGuid: STRANGER,
    group,
    partyStats: new Map(),
    auras: new Map(),
    aurasFor: () => [],
    actionButtons: [],
    casts: new Map(),
    cooldownRemaining: () => 0,
    names: new Map([[STRANGER, "Чужак"]]),
    creatureTemplates: new Map(),
    totems: new Map(),
    setPartyAssistant(guid, apply) { calls.push(["assistant", guid, apply]); },
    assignPartyRole(assignment, apply, guid) { calls.push(["assignment", assignment, apply, guid]); },
    reportPvpAfk(guid) { calls.push(["afk", guid]); },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  return { seam, world, calls, call };
}

const raid = () => ({
  groupType: 0x02, ownSubGroup: 0, ownFlags: 0x04, ownRoles: 0, guid: 0x900n, counter: 1,
  members: [member(TANK, "Бронн", 0x02 | 0x01), member(HEALER, "Эйра"), member(ROGUE, "Тень")],
  leaderGuid: SELF, lootMethod: 0, masterLooterGuid: 0n, lootThreshold: 2, dungeonDifficulty: 0, raidDifficulty: 0,
});

test("PromoteToAssistant/DemoteAssistant find the member by name, name-realm or unit token", () => {
  const { calls, call } = fixture(raid());
  assert.deepEqual(call("PromoteToAssistant", "Эйра", 1), [], "no return value");
  call("PromoteToAssistant", "эЙРА-Гордунни", 1);
  call("DemoteAssistant", "raid1", 1);
  call("DemoteAssistant", "RAID3");
  assert.deepEqual(calls, [
    ["assistant", HEALER, true], ["assistant", HEALER, true], ["assistant", TANK, false], ["assistant", ROGUE, false],
  ], "UnitPopup.lua:1333-1337 pass the name, SecureTemplates the token; the realm suffix is dropped");
  // A party's `party<n>` tokens (the seam resolves them only outside a raid).
  const party = fixture({ ...raid(), groupType: 0 });
  party.call("SetPartyAssignment", "MAINTANK", "party2");
  assert.deepEqual(party.calls, [["assignment", 0, true, HEALER]]);
});

test("SetPartyAssignment/ClearPartyAssignment send MSG_PARTY_ASSIGNMENT with the core's assignment numbers", () => {
  const { calls, call } = fixture(raid());
  call("SetPartyAssignment", "MAINTANK", "Тень", 1);
  call("SetPartyAssignment", "MAINASSIST", "raid2", 1);
  call("SetPartyAssignment", "maintank", "Эйра");
  call("ClearPartyAssignment", "MAINASSIST", "Тестовый", 1);
  assert.deepEqual(calls, [
    ["assignment", 0, true, ROGUE], ["assignment", 1, true, HEALER],
    ["assignment", 0, true, HEALER], ["assignment", 1, false, SELF],
  ], "GROUP_ASSIGN_MAINTANK = 0, GROUP_ASSIGN_MAINASSIST = 1 (Group.h); the player by their own name");
  calls.length = 0;
  // `/clearmaintank` (ChatFrame.lua:1265-1269) names nobody: the holder's flag is the one cleared.
  call("ClearPartyAssignment", "MAINTANK");
  call("ClearPartyAssignment", "MAINASSIST");
  assert.deepEqual(calls, [["assignment", 0, false, TANK], ["assignment", 1, false, SELF]],
    "the main tank from the list, the main assist from the header's own flags");
});

test("ClearPartyAssignment on somebody who does not hold the role sends nothing: the core would clear the holder", () => {
  // HandlePartyAssignmentOpcode (GroupHandler.cpp:670-679) takes the flag from everybody before it
  // applies the packet's guid, and /maintankoff, /mainassistoff and SecureTemplates' `clear` action
  // call ClearPartyAssignment unchecked.
  const { calls, call } = fixture(raid());
  call("ClearPartyAssignment", "MAINTANK", "Тень");
  call("ClearPartyAssignment", "MAINASSIST", "Бронн");
  call("ClearPartyAssignment", "maintank", "raid3");
  assert.deepEqual(calls, [], "Бронн is the main tank, not the main assist; Тень is neither");
  call("ClearPartyAssignment", "MAINTANK", "Бронн");
  assert.deepEqual(calls, [["assignment", 0, false, TANK]]);
});

test("GetPartyAssignment answers the client's 1 or nil from the list's flags and the player's own", () => {
  const { call } = fixture(raid());
  assert.deepEqual(call("GetPartyAssignment", "MAINTANK", "Бронн", 1), [1]);
  assert.deepEqual(call("GetPartyAssignment", "MAINASSIST", "Бронн", 1), [], "0x02 is the tank bit, not the assist's");
  assert.deepEqual(call("GetPartyAssignment", "MAINTANK", "raid2"), []);
  assert.deepEqual(call("GetPartyAssignment", "MAINASSIST", "player"), [1], "ownFlags 0x04");
  assert.deepEqual(call("GetPartyAssignment", "mainassist", "Тестовый"), [1]);
  assert.deepEqual(call("GetPartyAssignment", "MAINTANK", "Никто"), []);
  assert.deepEqual(call("GetPartyAssignment", "LEADER", "Бронн"), [], "an unknown assignment");
});

test("an unknown name, an unknown assignment, a stranger or no group sends nothing", () => {
  const { calls, call, world } = fixture(raid());
  call("PromoteToAssistant", "Никто", 1);
  call("PromoteToAssistant", "target", 1);
  call("PromoteToAssistant", undefined);
  call("SetPartyAssignment", "LEADER", "Тень");
  call("SetPartyAssignment", "MAINTANK");
  call("ReportPlayerIsPVPAFK", "Чужак");
  assert.deepEqual(calls, [], "the target is not in the group: the server would drop it anyway");
  world.group = undefined;
  call("PromoteToAssistant", "Тень", 1);
  call("ClearPartyAssignment", "MAINTANK");
  assert.deepEqual(calls, []);
  assert.deepEqual(call("GetPartyAssignment", "MAINTANK", "Тень"), []);
});

test("ReportPlayerIsPVPAFK reports a raid member by the name the menu or the scoreboard row carries", () => {
  const { calls, call } = fixture(raid());
  // UnitPopup.lua:1349-1350 passes `fullname`; WorldStateFrame.lua:941-951 the score row's name,
  // offered only for `UnitInRaid(self.name)`.
  call("ReportPlayerIsPVPAFK", "Тень");
  call("ReportPlayerIsPVPAFK", "Бронн-Свежеватель Душ");
  assert.deepEqual(calls, [["afk", ROGUE], ["afk", TANK]]);
});

test("every group command is the seam's own binding, not shadowed by a later key; no model answers nil", () => {
  for (const [name, binding] of Object.entries(FRAMEXML_GROUP_COMMAND_BINDINGS)) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], binding, name);
    assert.deepEqual(binding({}, ["MAINTANK", "Тень", 1]), [], `${name} without a model`);
  }
  assert.deepEqual(Object.keys(FRAMEXML_GROUP_COMMAND_BINDINGS).sort(), [
    "ClearPartyAssignment", "DemoteAssistant", "GetPartyAssignment", "PromoteToAssistant",
    "ReportPlayerIsPVPAFK", "SetPartyAssignment",
  ]);
});
