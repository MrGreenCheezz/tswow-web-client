import assert from "node:assert/strict";
import test from "node:test";

const { EventBus } = await import("../dist/code/world/EventBus.js");
const { MEMBER_STATUS_ONLINE, MEMBER_STATUS_PVP } = await import("../dist/code/world/GroupProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { AURA_FLAGS } = await import("../dist/code/world/AuraProtocol.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam, CANNED_PARTY_AURA_FIXTURES, CANNED_PARTY_MEMBERS } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const {
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_EVENTS,
  FRAMEXML_POWER_EVENTS,
  FRAMEXML_POWER_MAX_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const {
  GROUP_UPDATE_STATUS,
  GROUP_UPDATE_CUR_HP,
  GROUP_UPDATE_MAX_HP,
  GROUP_UPDATE_POWER_TYPE,
  GROUP_UPDATE_CUR_POWER,
  GROUP_UPDATE_MAX_POWER,
  GROUP_UPDATE_LEVEL,
  GROUP_UPDATE_AURAS,
  MEMBER_STATUS_OFFLINE,
} = await import("../dist/code/world/PartyProtocol.js");

function object(guid, typeId = 4) {
  return {
    guid,
    typeId,
    position: undefined,
    movementFlags: 0,
    updateFlags: 0,
    targetGuid: undefined,
    runSpeed: undefined,
    turnRate: undefined,
    motion: undefined,
    glide: undefined,
    transport: undefined,
    speeds: undefined,
    transportTime: undefined,
    fields: new Map(),
  };
}

function set(objectState, name, value) {
  objectState.fields.set(UPDATE_FIELDS[name].offset, value);
}

function fixture() {
  const selfGuid = 0x10n;
  const partyGuids = [0x21n, 0x22n, 0x23n, 0x24n];
  const state = new WorldState();
  const store = new WorldStore(state);
  const self = object(selfGuid);
  set(self, "UNIT_FIELD_HEALTH", 4000);
  set(self, "UNIT_FIELD_MAXHEALTH", 5000);
  set(self, "UNIT_FIELD_BYTES_0", 1 | (1 << 24));
  const party1 = object(partyGuids[0]);
  set(party1, "UNIT_FIELD_HEALTH", 800);
  set(party1, "UNIT_FIELD_MAXHEALTH", 1000);
  set(party1, "UNIT_FIELD_LEVEL", 60);
  set(party1, "UNIT_FIELD_BYTES_0", 1 | (1 << 24));
  party1.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 1, 50);
  party1.fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + 1, 100);
  const party3 = object(partyGuids[2]);
  set(party3, "UNIT_FIELD_HEALTH", 600);
  set(party3, "UNIT_FIELD_MAXHEALTH", 900);
  set(party3, "UNIT_FIELD_BYTES_0", 1 | (3 << 24));
  state.selfGuid = selfGuid;
  state.objects.set(selfGuid, self);
  state.objects.set(partyGuids[0], party1);
  state.objects.set(partyGuids[2], party3);
  store.flush();

  const events = new EventBus();
  const partyAura = {
    slot: 1,
    spellId: 6673,
    flags: AURA_FLAGS.positive,
    casterLevel: 60,
    applications: 2,
  };
  const world = {
    state,
    targetGuid: undefined,
    petSpells: undefined,
    group: {
      groupType: 0,
      ownSubGroup: 0,
      ownFlags: 0,
      ownRoles: 0,
      guid: 0x99n,
      counter: 1,
      members: [
        { name: "Альфа", guid: partyGuids[0], online: true, status: MEMBER_STATUS_ONLINE, subGroup: 0, flags: 0, roles: 0 },
        { name: "Бета", guid: partyGuids[1], online: true, status: MEMBER_STATUS_ONLINE | MEMBER_STATUS_PVP, subGroup: 0, flags: 0, roles: 0 },
        { name: "Гамма", guid: partyGuids[2], online: true, status: MEMBER_STATUS_ONLINE, subGroup: 0, flags: 0, roles: 0 },
        { name: "Дельта", guid: partyGuids[3], online: false, status: MEMBER_STATUS_OFFLINE, subGroup: 0, flags: 0, roles: 0 },
      ],
      leaderGuid: partyGuids[0],
      lootMethod: 0,
      masterLooterGuid: 0n,
      lootThreshold: 0,
      dungeonDifficulty: 0,
      raidDifficulty: 0,
    },
    partyStats: new Map([
      [partyGuids[0], {
        guid: partyGuids[0], flags: GROUP_UPDATE_CUR_HP | GROUP_UPDATE_MAX_HP,
        health: 700, maxHealth: 1100,
      }],
      [partyGuids[1], {
        guid: partyGuids[1], flags: GROUP_UPDATE_STATUS | GROUP_UPDATE_CUR_HP | GROUP_UPDATE_MAX_HP
          | GROUP_UPDATE_POWER_TYPE | GROUP_UPDATE_CUR_POWER | GROUP_UPDATE_MAX_POWER
          | GROUP_UPDATE_LEVEL | GROUP_UPDATE_AURAS,
        status: MEMBER_STATUS_ONLINE, health: 500, maxHealth: 750, powerType: 1,
        power: 35, maxPower: 100, level: 58, auras: [partyAura],
      }],
      [partyGuids[2], {
        guid: partyGuids[2], flags: GROUP_UPDATE_CUR_HP, health: 600,
      }],
      [partyGuids[3], {
        guid: partyGuids[3], flags: GROUP_UPDATE_STATUS | GROUP_UPDATE_CUR_HP,
        status: MEMBER_STATUS_OFFLINE, health: 0,
      }],
    ]),
    names: new Map(),
    creatureTemplates: new Map(),
    casts: new Map(),
    // Only in-range objects expose authoritative ActiveAura polarity/application fields. The
    // out-of-range partyStats row above must not be reinterpreted as UnitBuff/UnitDebuff data.
    aurasFor: (guid) => guid === partyGuids[0] ? [partyAura] : [],
    events,
    actionButtons: [],
    cooldownState: () => undefined,
    cooldownRemaining: () => 0,
    selected: [],
    selectTarget(guid) {
      this.selected.push(guid);
    },
    onGroupChanged: undefined,
  };
  const fired = [];
  const pump = {
    now: () => 123.456,
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: (id) => ({
      id,
      name: id === 6673 ? "Боевой крик" : "Test Spell",
      rank: "",
      iconPath: "Interface\\Icons\\Ability_Warrior_BattleShout",
    }),
    monotonic: () => 1_000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  return { seam, world, state, store, events, fired, pump, selfGuid, partyGuids, partyAura };
}

test("live PartyFrame reads group slots and truthful out-of-range/offline stats", () => {
  const { seam, world, fired, pump, selfGuid, partyGuids } = fixture();
  seam.attach(pump);
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("GetNumPartyMembers"), [4]);
  assert.deepEqual(call("GetPartyMember", 1), ["Альфа"]);
  assert.deepEqual(call("GetPartyMember", 4), ["Дельта"]);
  assert.deepEqual(call("GetPartyMember", 5), []);

  assert.deepEqual(call("UnitExists", "party1"), [true]);
  assert.deepEqual(call("UnitName", "party1"), ["Альфа"]);
  assert.deepEqual(call("UnitHealth", "party1"), [800], "in-range object wins over stale stats");
  assert.deepEqual(call("UnitHealthMax", "party1"), [1000]);
  assert.deepEqual(call("UnitPowerType", "party1"), [1, "RAGE"]);
  assert.deepEqual(call("UnitPower", "party1"), [50]);
  assert.deepEqual(call("UnitPowerMax", "party1"), [100]);
  assert.deepEqual(call("UnitIsConnected", "party1"), [true]);
  assert.deepEqual(call("UnitIsVisible", "party1"), [true]);
  assert.deepEqual(call("UnitBuff", "party1", 1), [
    "Боевой крик", "", "Interface\\Icons\\Ability_Warrior_BattleShout", 2, undefined,
    0, 0, undefined, false, false, 6673,
  ]);

  assert.deepEqual(call("UnitExists", "party2"), [true], "group membership survives out of range");
  assert.deepEqual(call("UnitName", "party2"), ["Бета"]);
  assert.deepEqual(call("UnitLevel", "party2"), [58]);
  assert.deepEqual(call("UnitHealth", "party2"), [500]);
  assert.deepEqual(call("UnitHealthMax", "party2"), [750]);
  assert.deepEqual(call("UnitPowerType", "party2"), [1, "RAGE"]);
  assert.deepEqual(call("UnitPower", "party2"), [35]);
  assert.deepEqual(call("UnitPowerMax", "party2"), [100]);
  assert.deepEqual(call("UnitIsConnected", "party2"), [true]);
  assert.deepEqual(call("UnitIsVisible", "party2"), [false], "no object means out of range");
  assert.deepEqual(call("UnitIsPVP", "party2"), [true],
    "GroupMember.status remains authoritative when the party object is out of range");
  assert.deepEqual(call("UnitIsPVP", "party1"), [false]);
  assert.deepEqual(call("UnitBuff", "party2", 1), [],
    "group-update aura flags cannot truthfully classify an out-of-range buff");
  assert.deepEqual(call("UnitDebuff", "party2", 1), []);

  assert.deepEqual(call("UnitExists", "party4"), [true]);
  assert.deepEqual(call("UnitName", "party4"), ["Дельта"]);
  assert.deepEqual(call("UnitIsConnected", "party4"), [false]);
  assert.deepEqual(call("UnitIsVisible", "party4"), [false]);
  assert.deepEqual(call("UnitHealth", "party4"), [0]);
  assert.deepEqual(call("UnitHealthMax", "party4"), [0]);

  call("TargetUnit", "party2");
  assert.deepEqual(world.selected, [partyGuids[1]]);
  world.selected.length = 0;
  call("TargetUnit", "player");
  assert.deepEqual(world.selected, [selfGuid]);
  world.selected.length = 0;
  call("TargetUnit", "raid1");
  assert.deepEqual(world.selected, [], "raid is outside this bounded party seam");
  assert.equal(FRAMEXML_POWER_EVENTS[1], "UNIT_RAGE");
  assert.equal(FRAMEXML_POWER_MAX_EVENTS[1], "UNIT_MAXRAGE");
  seam.detach();
});

test("live PartyFrame publishes group/stat/store edges for the current slot only", () => {
  const { seam, world, state, store, events, fired, pump, partyGuids } = fixture();
  let previousGroupCallbackCalls = 0;
  world.onGroupChanged = () => { previousGroupCallbackCalls += 1; };
  seam.attach(pump);
  assert.deepEqual(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.partyMembers), [
    [FRAMEXML_SEAM_EVENTS.partyMembers],
  ]);
  fired.length = 0;

  events.emit("PARTY_MEMBER_STATS", { guid: partyGuids[1] });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.health, "party2"],
    [FRAMEXML_SEAM_EVENTS.maxHealth, "party2"],
    [FRAMEXML_SEAM_EVENTS.unitDisplayPower, "party2"],
    [FRAMEXML_POWER_EVENTS[1], "party2"],
    [FRAMEXML_POWER_MAX_EVENTS[1], "party2"],
    [FRAMEXML_SEAM_EVENTS.unitLevel, "party2"],
    [FRAMEXML_SEAM_EVENTS.aura, "party2"],
  ]);
  fired.length = 0;

  state.setField(partyGuids[0], UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 650);
  store.flush();
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.health, "party1"]]);
  fired.length = 0;

  world.group.members = [world.group.members[0], world.group.members[2], world.group.members[3]];
  world.onGroupChanged();
  assert.equal(previousGroupCallbackCalls, 1);
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.partyMembers],
    [FRAMEXML_SEAM_EVENTS.partyLeaderChanged],
  ]);
  fired.length = 0;
  events.emit("PARTY_MEMBER_STATS", { guid: partyGuids[1] });
  assert.deepEqual(fired, [], "removed member cannot repaint a reused slot");
  events.emit("PARTY_MEMBER_STATS", { guid: partyGuids[2] });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.health, "party2"]]);

  seam.detach();
  fired.length = 0;
  world.onGroupChanged();
  events.emit("PARTY_MEMBER_STATS", { guid: partyGuids[2] });
  assert.deepEqual(fired, [], "detach removes group and stats edges");
});

test("canned PartyFrame exposes four deterministic party slots without changing player state", () => {
  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({
    now: () => 100,
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("GetNumPartyMembers"), [CANNED_PARTY_MEMBERS.length]);
  assert.deepEqual(call("GetPartyMember", 1), [CANNED_PARTY_MEMBERS[0].name]);
  assert.deepEqual(call("GetPartyMember", 4), [CANNED_PARTY_MEMBERS[3].name]);
  assert.deepEqual(call("GetPartyMember", 5), []);
  assert.deepEqual(call("UnitName", "party1"), [CANNED_PARTY_MEMBERS[0].name]);
  assert.deepEqual(call("UnitHealth", "party1"), [CANNED_PARTY_MEMBERS[0].health]);
  assert.deepEqual(call("UnitHealthMax", "party1"), [CANNED_PARTY_MEMBERS[0].healthMax]);
  assert.deepEqual(call("UnitPowerType", "party1"), [CANNED_PARTY_MEMBERS[0].powerType, "RAGE"]);
  assert.deepEqual(call("UnitPower", "party1"), [CANNED_PARTY_MEMBERS[0].power]);
  assert.deepEqual(call("UnitPowerMax", "party1"), [CANNED_PARTY_MEMBERS[0].powerMax]);
  assert.deepEqual(call("UnitBuff", "party1", 1), [
    CANNED_PARTY_AURA_FIXTURES.helpful.name,
    CANNED_PARTY_AURA_FIXTURES.helpful.rank,
    CANNED_PARTY_AURA_FIXTURES.helpful.texture,
    CANNED_PARTY_AURA_FIXTURES.helpful.count,
    CANNED_PARTY_AURA_FIXTURES.helpful.debuffType,
    CANNED_PARTY_AURA_FIXTURES.helpful.duration,
    100 + CANNED_PARTY_AURA_FIXTURES.helpful.expirationOffset,
    CANNED_PARTY_AURA_FIXTURES.helpful.unitCaster,
    CANNED_PARTY_AURA_FIXTURES.helpful.isStealable,
    CANNED_PARTY_AURA_FIXTURES.helpful.shouldConsolidate,
    CANNED_PARTY_AURA_FIXTURES.helpful.spellId,
  ]);
  assert.deepEqual(call("UnitDebuff", "party1", 1), [
    CANNED_PARTY_AURA_FIXTURES.harmful.name,
    CANNED_PARTY_AURA_FIXTURES.harmful.rank,
    CANNED_PARTY_AURA_FIXTURES.harmful.texture,
    CANNED_PARTY_AURA_FIXTURES.harmful.count,
    CANNED_PARTY_AURA_FIXTURES.harmful.debuffType,
    CANNED_PARTY_AURA_FIXTURES.harmful.duration,
    100 + CANNED_PARTY_AURA_FIXTURES.harmful.expirationOffset,
    CANNED_PARTY_AURA_FIXTURES.harmful.unitCaster,
    CANNED_PARTY_AURA_FIXTURES.harmful.isStealable,
    CANNED_PARTY_AURA_FIXTURES.harmful.shouldConsolidate,
    CANNED_PARTY_AURA_FIXTURES.harmful.spellId,
  ]);
  assert.deepEqual(call("UnitBuff", "party2", 1), [], "canned party fixture is bounded to party1");
  assert.deepEqual(call("UnitIsConnected", "party4"), [CANNED_PARTY_MEMBERS[3].connected]);
  assert.deepEqual(call("UnitIsVisible", "party4"), [CANNED_PARTY_MEMBERS[3].visible]);
  assert.deepEqual(call("UnitName", "player"), ["Игрок"], "player remains independent");
  assert.ok(fired.some(([event]) => event === FRAMEXML_SEAM_EVENTS.partyMembers));
  seam.detach();
});
