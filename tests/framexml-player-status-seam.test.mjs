import assert from "node:assert/strict";
import test from "node:test";

// The player-status C API (FrameXmlPlayerStatus.ts) over the live seam and a fake world: the inn
// bit, rested experience, AFK/DND, the party leader's slot, dungeon-finder roles, the loot pass
// switch, raid marks, and the events stock registers for each.
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const {
  FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS, FRAMEXML_SEAM_NAMES, FRAMEXML_SEAM_PRELUDE,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const {
  FRAMEXML_PLAYER_STATUS_BINDINGS, frameXmlGroupRoles, frameXmlPartyLeaderIndex, frameXmlRaidTargetIndex,
  frameXmlRestState, frameXmlXpExhaustion,
} = await import("../dist/code/browser/framexml/FrameXmlPlayerStatus.js");
const { FRAMEXML_NEUTRAL_CONSTANTS, FRAMEXML_NEUTRAL_PRELUDE } =
  await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const {
  PLAYER_FLAGS_AFK, PLAYER_FLAGS_DND, PLAYER_FLAGS_GHOST, PLAYER_FLAGS_RESTING,
} = await import("../dist/code/world/Fields.js");
const { MEMBER_STATUS_AFK, MEMBER_STATUS_DND, buildOptOutOfLoot } = await import("../dist/code/world/PartyProtocol.js");
const { GROUPTYPE_RAID } = await import("../dist/code/world/GroupProtocol.js");
const { LFG_ROLE_DAMAGE, LFG_ROLE_HEALER, LFG_ROLE_TANK } = await import("../dist/code/world/LfgProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(name);
    };
  }

  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }

  listenerCount(name) {
    return this.#listeners.get(name)?.size ?? 0;
  }
}

/** The store's half: one listener per named player field, and the field-change event bus. */
class FakeStore {
  listeners = new Map();
  events = new FakeEvents();

  field(_subject, name, listener) {
    this.listeners.set(name, listener);
    return () => {
      if (this.listeners.get(name) === listener) this.listeners.delete(name);
    };
  }

  emit(name, object, guid) {
    this.listeners.get(name)?.(object, guid);
  }
}

const SELF_GUID = 0x10n;

function object(guid, typeId) {
  return { guid, typeId, fields: new Map() };
}

const setField = (state, name, value) => state.fields.set(UPDATE_FIELDS[name].offset, value);

function member(guid, name, roles = 0) {
  return { name, guid, online: true, status: 1, subGroup: 0, flags: 0, roles };
}

function group(overrides = {}) {
  return {
    groupType: 0, ownSubGroup: 0, ownFlags: 0, ownRoles: 0, guid: 0x900n, counter: 1,
    members: [], leaderGuid: SELF_GUID, lootMethod: 0, masterLooterGuid: 0n, lootThreshold: 2,
    dungeonDifficulty: 0, raidDifficulty: 0, ...overrides,
  };
}

function fixture() {
  const self = object(SELF_GUID, 4);
  setField(self, "UNIT_FIELD_HEALTH", 4000);
  setField(self, "UNIT_FIELD_MAXHEALTH", 5000);
  setField(self, "UNIT_FIELD_BYTES_0", 1 | (1 << 24));
  const objects = new Map([[SELF_GUID, self]]);
  const store = new FakeStore();
  const worldEvents = new FakeEvents();
  const optOutCalls = [];
  const world = {
    state: { selfGuid: SELF_GUID, objects },
    targetGuid: undefined,
    group: undefined,
    partyStats: new Map(),
    raidTargets: new Map(),
    totems: new Map(),
    optOutOfLoot: false,
    setOptOutOfLoot(passOnLoot) {
      // As WorldClient: the last request is the state, the server echoes nothing.
      optOutCalls.push(passOnLoot);
      this.optOutOfLoot = passOnLoot;
    },
    casts: new Map(),
    actionButtons: [],
    events: worldEvents,
    aurasFor: () => [],
    cooldownState: () => undefined,
    cooldownRemaining: () => 0,
    names: new Map(),
    creatureTemplates: new Map(),
  };
  let focusGuid;
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    focusGuid: () => focusGuid,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const fired = [];
  const pump = {
    fire(event, ...args) {
      fired.push([event, ...args]);
      return 1;
    },
    now: () => 100,
  };
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  return {
    seam, world, self, objects, store, worldEvents, fired, pump, call, optOutCalls,
    setFocus: (guid) => { focusGuid = guid; },
  };
}

test("IsResting is the inn bit of PLAYER_FLAGS, and each bit family fires its own stock event", () => {
  const { seam, self, store, fired, pump, call } = fixture();
  seam.attach(pump);
  fired.length = 0;
  assert.deepEqual(call("IsResting"), [false], "no flags yet: not resting");
  assert.deepEqual(call("UnitIsAFK", "player"), [], "the client's nil, not false");
  assert.deepEqual(call("UnitIsDND", "player"), []);

  setField(self, "PLAYER_FLAGS", PLAYER_FLAGS_RESTING);
  store.emit("PLAYER_FLAGS", self, SELF_GUID);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.resting]], "PLAYER_UPDATE_RESTING for the inn bit alone");
  assert.deepEqual(call("IsResting"), [true]);

  fired.length = 0;
  setField(self, "PLAYER_FLAGS", PLAYER_FLAGS_RESTING | PLAYER_FLAGS_GHOST);
  store.emit("PLAYER_FLAGS", self, SELF_GUID);
  assert.deepEqual(fired, [], "the ghost bit is nobody's edge here");

  setField(self, "PLAYER_FLAGS", PLAYER_FLAGS_GHOST | PLAYER_FLAGS_AFK);
  store.emit("PLAYER_FLAGS", self, SELF_GUID);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.resting], [FRAMEXML_SEAM_EVENTS.playerFlags, "player"]],
    "leaving the inn and going AFK in one word: both edges, in stock's order");
  assert.deepEqual(call("IsResting"), [false]);
  assert.deepEqual(call("UnitIsAFK", "player"), [1], "BNet.lua:295 compares `UnitIsAFK(\"player\") == 1`");
  assert.deepEqual(call("UnitIsDND", "player"), []);

  fired.length = 0;
  setField(self, "PLAYER_FLAGS", PLAYER_FLAGS_DND);
  store.emit("PLAYER_FLAGS", self, SELF_GUID);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.playerFlags, "player"]], "AFK to DND is one flags edge");
  assert.deepEqual(call("UnitIsDND", "player"), [1]);
  assert.deepEqual(call("UnitIsAFK", "player"), []);

  seam.detach();
  fired.length = 0;
  setField(self, "PLAYER_FLAGS", PLAYER_FLAGS_RESTING);
  store.emit("PLAYER_FLAGS", self, SELF_GUID);
  assert.deepEqual(fired, [], "detach drops the subscription");
  assert.equal(store.listeners.has("PLAYER_FLAGS"), false);
  assert.equal(store.listeners.has("PLAYER_REST_STATE_EXPERIENCE"), false);
});

test("GetXPExhaustion is nil without rested experience, and GetRestState follows the same word", () => {
  const { seam, self, store, fired, pump, call } = fixture();
  seam.attach(pump);
  fired.length = 0;
  assert.deepEqual(call("GetXPExhaustion"), [], "nil: ExhaustionTick_OnEvent tests `not exhaustionThreshold`");
  assert.deepEqual(call("GetRestState"), [2, "Normal", 1], "2 paints the experience bar purple (MainMenuBar.lua:354)");
  setField(self, "PLAYER_REST_STATE_EXPERIENCE", 0);
  store.emit("PLAYER_REST_STATE_EXPERIENCE", self, SELF_GUID);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.exhaustion]], "UPDATE_EXHAUSTION on the field");
  assert.deepEqual(call("GetXPExhaustion"), [], "a spent bonus is still nil, not 0");
  assert.deepEqual(call("GetRestState"), [2, "Normal", 1]);

  fired.length = 0;
  setField(self, "PLAYER_REST_STATE_EXPERIENCE", 12500);
  store.emit("PLAYER_REST_STATE_EXPERIENCE", self, SELF_GUID);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.exhaustion]]);
  assert.deepEqual(call("GetXPExhaustion"), [12500]);
  assert.deepEqual(call("GetRestState"), [1, "Rested", 2], "1 paints it blue: rested, double experience");
  assert.deepEqual(call("IsResting"), [false], "the bonus is carried out of the inn; the inn bit is separate");
  seam.detach();
});

test("UnitIsAFK/UnitIsDND: a player in view by its flags, a party member out of range by its stats, a creature never", () => {
  const { seam, world, objects, pump, call } = fixture();
  seam.attach(pump);
  const target = object(0x20n, 4);
  setField(target, "PLAYER_FLAGS", PLAYER_FLAGS_DND);
  objects.set(0x20n, target);
  world.targetGuid = 0x20n;
  assert.deepEqual(call("UnitIsDND", "target"), [1]);
  assert.deepEqual(call("UnitIsAFK", "target"), []);
  const creature = object(0x30n, 3);
  objects.set(0x30n, creature);
  world.targetGuid = 0x30n;
  assert.deepEqual(call("UnitIsAFK", "target"), [], "a creature has no PLAYER_FLAGS");
  assert.deepEqual(call("UnitIsDND", "target"), []);

  // Анна is in the group list but not in view: only SMSG_PARTY_MEMBER_STATS' status byte says.
  world.group = group({ members: [member(0x21n, "Анна"), member(0x22n, "Борис")] });
  world.partyStats.set(0x21n, { guid: 0x21n, flags: 0, status: MEMBER_STATUS_AFK });
  world.partyStats.set(0x22n, { guid: 0x22n, flags: 0, status: MEMBER_STATUS_DND });
  assert.deepEqual(call("UnitIsAFK", "party1"), [1]);
  assert.deepEqual(call("UnitIsDND", "party1"), []);
  assert.deepEqual(call("UnitIsDND", "party2"), [1]);
  assert.deepEqual(call("UnitIsAFK", "party3"), [], "an empty slot is nobody");
  assert.deepEqual(call("UnitIsAFK", "mouseover"), [], "no unit at all");
  // In view, the object's own word wins over a stale status byte.
  const anna = object(0x21n, 4);
  objects.set(0x21n, anna);
  assert.deepEqual(call("UnitIsAFK", "party1"), []);
  setField(anna, "PLAYER_FLAGS", PLAYER_FLAGS_AFK);
  assert.deepEqual(call("UnitIsAFK", "party1"), [1]);
  assert.equal(seam.unitIsAFK("party1"), true, "the seam's own answer stays a boolean");
  seam.detach();
});

test("GetPartyLeaderIndex names the leader's party slot, 0 for the player, a raid or no group", () => {
  const { seam, world, pump, call } = fixture();
  seam.attach(pump);
  assert.deepEqual(call("GetPartyLeaderIndex"), [0], "no group");
  world.group = group({ members: [member(0x21n, "Анна"), member(0x22n, "Борис")] });
  assert.deepEqual(call("GetPartyLeaderIndex"), [0], "the player leads");
  world.group = group({ leaderGuid: 0x22n, members: [member(0x21n, "Анна"), member(0x22n, "Борис")] });
  assert.deepEqual(call("GetPartyLeaderIndex"), [2], "party2 leads: PartyMemberFrame.lua:189 shows the crown on row 2");
  world.group = group({ leaderGuid: 0x21n, members: [member(0x21n, "Анна"), member(0x22n, "Борис")] });
  assert.deepEqual(call("GetPartyLeaderIndex"), [1]);
  world.group = group({ groupType: GROUPTYPE_RAID, leaderGuid: 0x21n, members: [member(0x21n, "Анна")] });
  assert.deepEqual(call("GetPartyLeaderIndex"), [0], "a raid's party rows are its sub-group, which this seam does not alias");
  assert.equal(frameXmlPartyLeaderIndex(undefined, SELF_GUID), 0);
  assert.equal(frameXmlPartyLeaderIndex(group({ leaderGuid: 0x99n, members: [member(0x21n, "Анна")] }), SELF_GUID), 0,
    "a leader the list does not carry is nobody's slot");
  seam.detach();
});

test("UnitGroupRolesAssigned reads the dungeon finder's role bytes: the header's for the player, the list's for a member", () => {
  const { seam, world, objects, pump, call } = fixture();
  seam.attach(pump);
  assert.deepEqual(call("UnitGroupRolesAssigned", "player"), [false, false, false], "no group, no role");
  world.group = group({
    ownRoles: LFG_ROLE_TANK,
    members: [member(0x21n, "Анна", LFG_ROLE_HEALER), member(0x22n, "Борис", LFG_ROLE_DAMAGE), member(0x23n, "Вика")],
  });
  assert.deepEqual(call("UnitGroupRolesAssigned", "player"), [true, false, false]);
  assert.deepEqual(call("UnitGroupRolesAssigned", "party1"), [false, true, false]);
  assert.deepEqual(call("UnitGroupRolesAssigned", "party2"), [false, false, true]);
  assert.deepEqual(call("UnitGroupRolesAssigned", "party3"), [false, false, false], "a member without a role");
  assert.deepEqual(call("UnitGroupRolesAssigned", "party4"), [false, false, false], "an empty slot");
  const creature = object(0x30n, 3);
  objects.set(0x30n, creature);
  world.targetGuid = 0x30n;
  assert.deepEqual(call("UnitGroupRolesAssigned", "target"), [false, false, false], "not a member");
  world.targetGuid = SELF_GUID;
  assert.deepEqual(call("UnitGroupRolesAssigned", "target"), [true, false, false], "the player by any token");
  assert.deepEqual(frameXmlGroupRoles(LFG_ROLE_TANK | LFG_ROLE_DAMAGE), [true, false, true]);
  assert.deepEqual(frameXmlGroupRoles(undefined), [false, false, false]);
  seam.detach();
});

test("the player's own role byte changing with the group list raises PLAYER_ROLES_ASSIGNED once", () => {
  const { seam, world, fired, pump } = fixture();
  seam.attach(pump);
  assert.equal(typeof world.onGroupChanged, "function", "the seam takes the group callback");
  fired.length = 0;
  world.group = group({ ownRoles: LFG_ROLE_HEALER, members: [member(0x21n, "Анна", LFG_ROLE_TANK)] });
  world.onGroupChanged();
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.playerRolesAssigned),
    [[FRAMEXML_SEAM_EVENTS.playerRolesAssigned]], "PlayerFrame_UpdateRolesAssigned runs on it (PlayerFrame.lua:242)");
  assert.ok(fired.some(([event]) => event === FRAMEXML_SEAM_EVENTS.partyMembers), "the roster edge still fires");
  fired.length = 0;
  world.group = group({ ownRoles: LFG_ROLE_HEALER, members: [member(0x21n, "Анна", LFG_ROLE_DAMAGE)] });
  world.onGroupChanged();
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.playerRolesAssigned), [],
    "a member's role is the roster's edge, not the player's");
  fired.length = 0;
  world.group = undefined;
  world.onGroupChanged();
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.playerRolesAssigned),
    [[FRAMEXML_SEAM_EVENTS.playerRolesAssigned]], "leaving the group drops the role");
  seam.detach();
  assert.equal(world.onGroupChanged, undefined, "detach gives the callback back");
});

test("GetOptOutOfLoot/SetOptOutOfLoot keep the world's flag and send the one-word packet", () => {
  const { seam, pump, call, optOutCalls } = fixture();
  seam.attach(pump);
  assert.deepEqual(call("GetOptOutOfLoot"), [false], "the server's default");
  assert.deepEqual(call("SetOptOutOfLoot", 1), [], "UnitPopup.lua:1305 passes 1");
  assert.deepEqual(optOutCalls, [true]);
  assert.deepEqual(call("GetOptOutOfLoot"), [true]);
  assert.deepEqual(call("SetOptOutOfLoot", undefined), [], "UnitPopup.lua:1308 passes nil");
  assert.deepEqual(optOutCalls, [true, false]);
  assert.deepEqual(call("GetOptOutOfLoot"), [false]);
  assert.deepEqual([...buildOptOutOfLoot(true)], [1, 0, 0, 0], "CMSG_OPT_OUT_OF_LOOT: uint32 passOnLoot");
  assert.deepEqual([...buildOptOutOfLoot(false)], [0, 0, 0, 0]);
  seam.detach();
});

test("GetRaidTargetIndex numbers the world's marks 1..8, and MSG_RAID_TARGET_UPDATE fires RAID_TARGET_UPDATE", () => {
  const { seam, world, objects, worldEvents, fired, pump, call } = fixture();
  seam.attach(pump);
  fired.length = 0;
  const target = object(0x20n, 3);
  objects.set(0x20n, target);
  world.targetGuid = 0x20n;
  assert.deepEqual(call("GetRaidTargetIndex", "target"), [], "unmarked: nil");
  world.raidTargets.set(7, 0x20n);
  world.raidTargets.set(0, SELF_GUID);
  worldEvents.emit("RAID_TARGET_UPDATE", { icon: 7 });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.raidTarget]], "TargetFrame_OnEvent re-reads the index on it");
  assert.deepEqual(call("GetRaidTargetIndex", "target"), [8], "the skull is icon 7 on the wire");
  assert.deepEqual(call("GetRaidTargetIndex", "player"), [1]);
  assert.deepEqual(call("GetRaidTargetIndex", "focus"), [], "no unit, no mark");
  assert.equal(frameXmlRaidTargetIndex(world.raidTargets, 0x99n), undefined);
  assert.equal(frameXmlRaidTargetIndex(undefined, 0x20n), undefined);
  assert.equal(FRAMEXML_SEAM_NAMES.includes("SetRaidTarget"), false,
    "SetRaidTarget stays the chat API's (FrameXmlChatApi.ts): one name, one owner");
  assert.equal(worldEvents.listenerCount("RAID_TARGET_UPDATE"), 1);
  seam.detach();
  assert.equal(worldEvents.listenerCount("RAID_TARGET_UPDATE"), 0);
});

test("\"focus-target\" is the focus's target, with its own unit events and a portrait edge", () => {
  const { seam, self, objects, store, fired, pump, call, setFocus } = fixture();
  const focus = object(0x40n, 3);
  setField(focus, "UNIT_FIELD_HEALTH", 500);
  setField(focus, "UNIT_FIELD_MAXHEALTH", 900);
  setField(focus, "UNIT_FIELD_TARGET", 0x77n);
  const focusTarget = object(0x77n, 3);
  setField(focusTarget, "UNIT_FIELD_HEALTH", 300);
  setField(focusTarget, "UNIT_FIELD_MAXHEALTH", 600);
  objects.set(0x40n, focus);
  objects.set(0x77n, focusTarget);
  setFocus(0x40n);
  seam.attach(pump);
  fired.length = 0;
  assert.deepEqual(call("UnitExists", "focus-target"), [true], "TargetFrame_OnUpdate polls this to show FocusFrameToT");
  assert.deepEqual(call("UnitGUID", "focus-target"), ["0x0000000000000077"]);
  assert.deepEqual(call("UnitHealth", "focus-target"), [300]);
  assert.deepEqual(call("UnitHealthMax", "focus-target"), [600]);
  assert.deepEqual(call("UnitIsUnit", "focus-target", "focus"), [false]);

  store.events.emit("UNIT_HEALTH", { guid: 0x77n });
  assert.deepEqual(fired.filter(([, unit]) => unit === "focus-target"), [[FRAMEXML_SEAM_EVENTS.health, "focus-target"]],
    "UnitFrame_OnEvent compares arg1 with self.unit");
  fired.length = 0;
  store.events.emit("UNIT_TARGET", { guid: 0x40n });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.unitTarget, "focus"]],
    "FocusFrame's UNIT_TARGET runs TargetofTarget_Update on its row");
  fired.length = 0;
  store.events.emit("UNIT_DISPLAY_ID", { guid: SELF_GUID });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.unitPortrait, "player"]],
    "the player's display id is CharacterMicroButton's and PlayerFrame's UNIT_PORTRAIT_UPDATE");
  fired.length = 0;
  store.events.emit("UNIT_DISPLAY_ID", { guid: 0x77n });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.unitPortrait, "focus-target"]]);
  fired.length = 0;
  store.events.emit("UNIT_DISPLAY_ID", { guid: 0x99n });
  assert.deepEqual(fired, [], "a stranger's display id names no unit token");

  setField(focus, "UNIT_FIELD_TARGET", 0n);
  assert.deepEqual(call("UnitExists", "focus-target"), [false], "the focus targets nothing");
  setField(focus, "UNIT_FIELD_TARGET", 0x77n);
  setFocus(undefined);
  assert.deepEqual(call("UnitExists", "focus-target"), [false], "no focus, no focus target");
  assert.deepEqual(call("UnitExists", "player"), [true]);
  assert.equal(self.guid, SELF_GUID);
  seam.detach();
});

test("the seam's answers replace the neutral floor's for the Lua globals", () => {
  const vm = new GlueLuaVm();
  const { seam, self, world, objects } = fixture();
  setField(self, "PLAYER_FLAGS", PLAYER_FLAGS_AFK | PLAYER_FLAGS_RESTING);
  setField(self, "PLAYER_REST_STATE_EXPERIENCE", 9000);
  world.group = group({ ownRoles: LFG_ROLE_HEALER, leaderGuid: 0x21n, members: [member(0x21n, "Анна", LFG_ROLE_TANK)] });
  world.raidTargets.set(3, SELF_GUID);
  objects.set(0x21n, object(0x21n, 4));
  try {
    // The F2 floor answers UnitIsAFK/UnitIsDND with a constant false («no unit»); the boot's `_G`
    // metamethod reads `__fxNeutralImpl[name]` before that constant table, and the seam prelude
    // is what puts the binding there.
    for (const name of ["UnitIsAFK", "UnitIsDND"]) {
      assert.deepEqual(FRAMEXML_NEUTRAL_CONSTANTS.find((entry) => entry.name === name)?.values, [false]);
    }
    vm.setGlobal("__fxNeutralImpl", {});
    vm.setGlobal("__fxAddonModules", []);
    assert.equal(vm.execute(FRAMEXML_NEUTRAL_PRELUDE, "@player-status:neutral").ok, true);
    const floor = vm.execute("__afkFloor = __fxNeutralImpl.UnitIsAFK", "@player-status:floor");
    assert.equal(floor.ok, true, floor.error);
    assert.equal(vm.getGlobal("__afkFloor"), undefined, "no implementation before the seam prelude");
    for (const name of Object.keys(FRAMEXML_PLAYER_STATUS_BINDINGS)) {
      vm.registerGlobal(`__fxSeam_${name}`, (args) => FRAMEXML_SEAM_BINDINGS[name](seam, args));
    }
    vm.setGlobal("__fxSeamNames", [...FRAMEXML_SEAM_NAMES]);
    assert.equal(vm.execute(FRAMEXML_SEAM_PRELUDE, "@player-status:seam").ok, true);
    const run = vm.execute(`
      __resting = __fxNeutralImpl.IsResting()
      __afk = __fxNeutralImpl.UnitIsAFK("player")
      __dnd = __fxNeutralImpl.UnitIsDND("player")
      __rested = __fxNeutralImpl.GetXPExhaustion()
      __leader = __fxNeutralImpl.GetPartyLeaderIndex()
      __tank, __healer, __damage = __fxNeutralImpl.UnitGroupRolesAssigned("player")
      __partyTank = __fxNeutralImpl.UnitGroupRolesAssigned("party1")
      __mark = __fxNeutralImpl.GetRaidTargetIndex("player")
      __noMark = __fxNeutralImpl.GetRaidTargetIndex("party1")
      __optOutBefore = __fxNeutralImpl.GetOptOutOfLoot()
      __fxNeutralImpl.SetOptOutOfLoot(1)
      __optOutAfter = __fxNeutralImpl.GetOptOutOfLoot()
      __fxNeutralImpl.SetOptOutOfLoot(nil)
      __optOutCleared = __fxNeutralImpl.GetOptOutOfLoot()
    `, "@player-status:seam-calls");
    assert.equal(run.ok, true, run.error);
    assert.equal(vm.getGlobal("__resting"), true);
    assert.equal(vm.getGlobal("__afk"), 1, "the seam's answer, not the floor's, and the client's 1");
    assert.equal(vm.getGlobal("__dnd"), undefined, "nil, as the client answers");
    assert.equal(vm.getGlobal("__rested"), 9000);
    assert.equal(vm.getGlobal("__leader"), 1);
    assert.deepEqual([vm.getGlobal("__tank"), vm.getGlobal("__healer"), vm.getGlobal("__damage")], [false, true, false]);
    assert.equal(vm.getGlobal("__partyTank"), true);
    assert.equal(vm.getGlobal("__mark"), 4);
    assert.equal(vm.getGlobal("__noMark"), undefined, "nil for an unmarked unit");
    assert.deepEqual([vm.getGlobal("__optOutBefore"), vm.getGlobal("__optOutAfter"), vm.getGlobal("__optOutCleared")],
      [false, true, false]);
  } finally {
    vm.close();
  }
});

test("every player-status name is the seam's own, and a seam without the members answers «no»", () => {
  for (const [name, binding] of Object.entries(FRAMEXML_PLAYER_STATUS_BINDINGS)) {
    assert.ok(FRAMEXML_SEAM_NAMES.includes(name), `${name} is a seam name`);
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], binding, `${name} is not shadowed by a later key`);
  }
  const bare = {};
  assert.deepEqual(FRAMEXML_PLAYER_STATUS_BINDINGS.IsResting(bare, []), [false]);
  assert.deepEqual(FRAMEXML_PLAYER_STATUS_BINDINGS.GetXPExhaustion(bare, []), []);
  assert.deepEqual(FRAMEXML_PLAYER_STATUS_BINDINGS.UnitIsAFK(bare, ["player"]), []);
  assert.deepEqual(FRAMEXML_PLAYER_STATUS_BINDINGS.UnitIsDND(bare, ["player"]), []);
  assert.deepEqual(FRAMEXML_PLAYER_STATUS_BINDINGS.GetPartyLeaderIndex(bare, []), [0]);
  assert.deepEqual(FRAMEXML_PLAYER_STATUS_BINDINGS.UnitGroupRolesAssigned(bare, ["player"]), [false, false, false]);
  assert.deepEqual(FRAMEXML_PLAYER_STATUS_BINDINGS.GetOptOutOfLoot(bare, []), [false]);
  assert.deepEqual(FRAMEXML_PLAYER_STATUS_BINDINGS.SetOptOutOfLoot(bare, [1]), []);
  assert.deepEqual(FRAMEXML_PLAYER_STATUS_BINDINGS.GetRaidTargetIndex(bare, ["target"]), []);
  // Player.h:354-359, measured: 0x1 is the group leader, so AFK is 0x2 and DND 0x4.
  assert.deepEqual([PLAYER_FLAGS_AFK, PLAYER_FLAGS_DND, PLAYER_FLAGS_GHOST, PLAYER_FLAGS_RESTING], [0x2, 0x4, 0x10, 0x20]);
  assert.deepEqual([MEMBER_STATUS_AFK, MEMBER_STATUS_DND], [0x40, 0x80]);
  assert.equal(frameXmlXpExhaustion(0), undefined);
  assert.equal(frameXmlXpExhaustion(undefined), undefined);
  assert.equal(frameXmlXpExhaustion(1), 1);
  assert.deepEqual(frameXmlRestState(0), [2, "Normal", 1]);
  assert.deepEqual(frameXmlRestState(10), [1, "Rested", 2]);
  assert.equal(frameXmlRaidTargetIndex(new Map([[0, 5n]]), 5n), 1);
  assert.equal(frameXmlRaidTargetIndex(new Map([[0, 5n]]), 0n), undefined);
});
