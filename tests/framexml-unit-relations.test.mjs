import assert from "node:assert/strict";
import test from "node:test";

// Combat and the group's relations for the stock UI (FrameXmlUnitRelations.ts): the pure group
// reads, the binding table over a seam double, and LiveWorldSeam's own answers and combat edges
// (PLAYER_ENTER/LEAVE_COMBAT from the player's swing, PLAYER_REGEN_* from UNIT_FLAG_IN_COMBAT).
const {
  FRAMEXML_UNIT_RELATION_BINDINGS, frameXmlGroupHas, frameXmlGroupLeader, frameXmlRaidIndex, frameXmlRaidOfficer,
  frameXmlUnitFlagsInCombat,
} = await import("../dist/code/browser/framexml/FrameXmlUnitRelations.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const SELF = 0x10n;
const ALLY = 0x21n;
const HEALER = 0x22n;
const STRANGER = 0x99n;
const member = (guid, name, flags = 0) => ({ guid, name, online: true, status: 1, subGroup: 0, flags, roles: 0 });
const party = { groupType: 0, leaderGuid: ALLY, ownFlags: 0, members: [member(ALLY, "Ролан"), member(HEALER, "Эйра")] };
const raid = { groupType: 0x02, leaderGuid: SELF, ownFlags: 0, members: [member(ALLY, "Ролан", 0x01), member(HEALER, "Эйра")] };

test("the group reads: membership with the player, a 0-based raid index in the seam's order, leader and officers", () => {
  assert.equal(frameXmlGroupHas(party, SELF, ALLY), true);
  assert.equal(frameXmlGroupHas(party, SELF, SELF), true, "the player is in their own group");
  assert.equal(frameXmlGroupHas(party, SELF, STRANGER), false);
  assert.equal(frameXmlGroupHas(undefined, SELF, SELF), false, "alone, nobody is in a party");
  assert.equal(frameXmlRaidIndex(party, SELF, ALLY), undefined, "a party is not a raid");
  assert.equal(frameXmlRaidIndex(raid, SELF, ALLY), 0, "GetRaidRosterInfo(UnitInRaid + 1): 0-based");
  assert.equal(frameXmlRaidIndex(raid, SELF, HEALER), 1);
  assert.equal(frameXmlRaidIndex(raid, SELF, SELF), 2, "the player is the row after the listed members");
  assert.equal(frameXmlRaidIndex(raid, SELF, STRANGER), undefined);
  assert.equal(frameXmlGroupLeader(party, ALLY), true);
  assert.equal(frameXmlGroupLeader(party, SELF), false);
  assert.equal(frameXmlRaidOfficer(raid, SELF, SELF), true, "the leader");
  assert.equal(frameXmlRaidOfficer(raid, SELF, ALLY), true, "an assistant");
  assert.equal(frameXmlRaidOfficer(raid, SELF, HEALER), false);
  assert.equal(frameXmlRaidOfficer({ ...raid, leaderGuid: ALLY, ownFlags: 0x01 }, SELF, SELF), true, "the header's own assistant flag");
  assert.equal(frameXmlRaidOfficer(party, SELF, ALLY), false, "officers are a raid's");
  assert.equal(frameXmlUnitFlagsInCombat(0x00080000), true);
  assert.equal(frameXmlUnitFlagsInCombat(0x00000008), false);
  assert.equal(frameXmlUnitFlagsInCombat(undefined), false);
});

test("the bindings compose cooperation, assistance and death from the seam's own unit answers", () => {
  const players = new Set(["player", "target", "party1"]);
  const friends = new Set(["player|target", "player|party1", "player|npc"]);
  const seam = {
    unitIsPlayer: (unit) => players.has(unit),
    unitIsFriend: (left, right) => friends.has(`${left}|${right}`),
    unitIsDead: (unit) => unit === "party1",
    unitIsGhost: (unit) => unit === "target",
  };
  const call = (name, ...args) => FRAMEXML_UNIT_RELATION_BINDINGS[name](seam, args);
  assert.deepEqual(call("UnitCanCooperate", "player", "target"), [true], "a friendly player: TRADE and INVITE show");
  assert.deepEqual(call("UnitCanCooperate", "player", "npc"), [false], "a friendly creature trades with nobody");
  assert.deepEqual(call("UnitCanCooperate", "player", "focus"), [false]);
  assert.deepEqual(call("UnitCanCooperate", "PLAYER", "Target"), [true], "tokens are case-insensitive");
  assert.deepEqual(call("UnitCanAssist", "player", "npc"), [true]);
  assert.deepEqual(call("UnitCanAssist", "player", "focus"), [false]);
  assert.deepEqual(call("UnitIsDeadOrGhost", "party1"), [true]);
  assert.deepEqual(call("UnitIsDeadOrGhost", "target"), [true]);
  assert.deepEqual(call("UnitIsDeadOrGhost", "player"), [false]);
  assert.deepEqual(call("UnitAffectingCombat", "player"), [false], "a seam without the member answers «no»");
  assert.deepEqual(call("UnitInRaid", "player"), [], "nil, not false");
});

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const set = this.#listeners.get(name) ?? new Set();
    this.#listeners.set(name, set);
    set.add(listener);
    return () => set.delete(listener);
  }
  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const IN_COMBAT = 0x00080000;

function fixture() {
  const player = { guid: SELF, typeId: 4, fields: new Map([[FLAGS, 0x08]]) };
  const target = { guid: ALLY, typeId: 4, fields: new Map([[FLAGS, IN_COMBAT]]) };
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, player], [ALLY, target]]) },
    selfName: "Тестовый",
    targetGuid: ALLY,
    attacking: false,
    group: raid,
    partyStats: new Map(),
    auras: new Map(),
    aurasFor: () => [],
    events: new FakeEvents(),
    actionButtons: [],
    casts: new Map(),
    cooldownRemaining: () => 0,
    names: new Map(),
    creatureTemplates: new Map(),
    totems: new Map(),
  };
  const fired = [];
  let now = 0;
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => now };
  const flagListeners = [];
  const store = {
    field: (subject, name, listener) => {
      if (subject === "self" && name === "UNIT_FIELD_FLAGS") flagListeners.push(listener);
      return () => {};
    },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    monotonic: () => now * 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  return {
    seam, world, player, target, fired, pump, call,
    setFlags(object, flags) {
      object.fields.set(FLAGS, flags);
      if (object === player) for (const listener of flagListeners) listener(player, SELF);
    },
    advance(seconds) { now += seconds; },
  };
}

const combatEvents = (fired) => fired.filter(([name]) => /^PLAYER_(ENTER|LEAVE)_COMBAT$|^PLAYER_REGEN_/.test(name)).map(([name]) => name);

test("the live seam publishes the player's swing and combat flag as the stock combat events", () => {
  const { seam, world, player, fired, pump, call, setFlags, advance } = fixture();
  seam.attach(pump);
  seam.tick(0);
  assert.deepEqual(combatEvents(fired), [], "out of combat at attach: nothing to announce");
  world.attacking = true;
  advance(0.016);
  seam.tick(0.016);
  assert.deepEqual(combatEvents(fired), ["PLAYER_ENTER_COMBAT"], "SMSG_ATTACK_START for the player: PlayerFrame.inCombat");
  setFlags(player, 0x08 | IN_COMBAT);
  assert.deepEqual(combatEvents(fired), ["PLAYER_ENTER_COMBAT", "PLAYER_REGEN_DISABLED"], "the flag's store edge, at once");
  assert.deepEqual(call("InCombatLockdown"), [true]);
  assert.deepEqual(call("UnitAffectingCombat", "player"), [true]);
  world.attacking = false;
  setFlags(player, 0x08);
  advance(0.1);
  seam.tick(0.2);
  assert.deepEqual(combatEvents(fired), ["PLAYER_ENTER_COMBAT", "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED", "PLAYER_LEAVE_COMBAT"]);
  assert.deepEqual(call("InCombatLockdown"), [false]);

  // A double without a store subscription still reaches the edge on the 60 ms poll.
  player.fields.set(FLAGS, IN_COMBAT);
  seam.tick(0.3);
  assert.equal(combatEvents(fired).at(-1), "PLAYER_REGEN_DISABLED");
});

test("5.21 every SMSG_ATTACK_STOP for the player is a PLAYER_LEAVE_COMBAT, a refused request included", () => {
  // Wow.exe 0x756800 case 0x144 → 0x756770 clears the attack target and the request word and fires
  // PLAYER_LEAVE_COMBAT (event 0x9c) whether or not PLAYER_ENTER_COMBAT came first. The stock attack
  // button lit by ActionButton's PostClick goes dark on that event (ActionButton.lua:404-406).
  const { seam, world, fired, pump, advance } = fixture();
  seam.attach(pump);
  seam.tick(0);
  world.attackStops = 1;
  advance(0.016);
  seam.tick(0.016);
  assert.deepEqual(combatEvents(fired), ["PLAYER_LEAVE_COMBAT"], "HandleAttackSwingOpcode refused the target");
  advance(0.016);
  seam.tick(0.032);
  assert.deepEqual(combatEvents(fired), ["PLAYER_LEAVE_COMBAT"], "one event per packet");
  world.attackStops = 2;
  world.attacking = true;
  advance(0.016);
  seam.tick(0.048);
  assert.deepEqual(combatEvents(fired), ["PLAYER_LEAVE_COMBAT", "PLAYER_LEAVE_COMBAT", "PLAYER_ENTER_COMBAT"],
    "a stop and a start inside one frame keep their order");
  world.attacking = false;
  world.attackStops = 3;
  advance(0.016);
  seam.tick(0.064);
  assert.equal(combatEvents(fired).filter((name) => name === "PLAYER_LEAVE_COMBAT").length, 3,
    "a swing that ended by packet is announced once");
});

test("the live seam answers combat of any unit in sight and the group's relations, by token or by name", () => {
  const { seam, pump, call } = fixture();
  seam.attach(pump);
  assert.deepEqual(call("UnitAffectingCombat", "target"), [true], "UNIT_FLAG_IN_COMBAT on the target's object");
  assert.deepEqual(call("UnitAffectingCombat", "focus"), [false], "no focus, no combat");
  assert.deepEqual(call("UnitInRaid", "target"), [0], "the target is the first listed member");
  assert.deepEqual(call("UnitInRaid", "player"), [2]);
  assert.deepEqual(call("UnitInRaid", "Эйра"), [1], "the calendar's invite list asks by name");
  assert.deepEqual(call("UnitInRaid", "эйра"), [1], "case aside");
  assert.deepEqual(call("UnitInRaid", "Незнакомец"), []);
  assert.deepEqual(call("UnitInParty", "Тестовый"), [true], "the player's own name");
  assert.deepEqual(call("UnitIsPartyLeader", "player"), [true]);
  assert.deepEqual(call("UnitIsPartyLeader", "target"), [false]);
  assert.deepEqual(call("UnitIsRaidOfficer", "target"), [true], "Ролан is an assistant");
  assert.deepEqual(call("UnitIsRaidOfficer", "Эйра"), [false]);
});
