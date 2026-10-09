import assert from "node:assert/strict";
import test from "node:test";

// The mechanics the boot census listed as called and unanswered (FrameXmlThreat.ts,
// FrameXmlQuestAbandon.ts, FrameXmlChatWindowFlags.ts, FrameXmlMechanics.ts), over a fake world
// through the live seam and over the canned seam: which answer each C API gives from which world
// data, which packets the commands become, and which Lua events the world's edges turn into.

const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FrameXmlThreatModel, FRAMEXML_THREAT_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlThreat.js");
const { CANNED_PLAYER_THREAT } = await import("../dist/code/browser/framexml/FrameXmlThreatCanned.js");
const { FrameXmlChatWindowFlags } = await import("../dist/code/browser/framexml/FrameXmlChatWindowFlags.js");
const { FRAMEXML_ADDON_CHAT_TYPES } = await import("../dist/code/browser/framexml/FrameXmlMechanics.js");
const { ThreatTables } = await import("../dist/code/world/ThreatProtocol.js");
const {
  CHAT_MSG_BATTLEGROUND, CHAT_MSG_GUILD, CHAT_MSG_PARTY, CHAT_MSG_RAID, CHAT_MSG_WHISPER,
} = await import("../dist/code/world/ChatProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

/** The census rows this lane answers; every one must now be a seam name, not a neutral stub. */
const CENSUS_NAMES = [
  "UnitThreatSituation", "UnitDetailedThreatSituation", "IsThreatWarningEnabled", "HasKey",
  "SetAbandonQuest", "AbandonQuest", "GetAbandonQuestName", "GetAbandonQuestItems", "GetQuestTimers",
  "IsMacClient", "NoPlayTime", "PartialPlayTime", "UnitIsTalking", "GetArenaTeam", "GetPossessInfo",
  "IsPossessBarVisible", "SetChatWindowLocked", "SetChatWindowUninteractable", "SetChatWindowDocked",
  "SendAddonMessage", "GetBattlefieldWinner", "RequestBattlefieldPositions", "FillLocalizedClassList",
  "RegisterStaticConstants",
];

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) { listeners = new Set(); this.#listeners.set(name, listeners); }
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
}

function pump() {
  const events = [];
  return { events, fire(event, ...args) { events.push([event, ...args]); return 1; }, now: () => 0 };
}

const SELF = 0x10n;
const OTHER = 0x11n;
const TARGET = 0xf130_0000_0000_0101n;
const FOCUS = 0xf130_0000_0000_0102n;

function object(guid, typeId, position, fields = []) {
  return { guid, typeId, position, movementFlags: 0, updateFlags: 0, fields: new Map(fields) };
}

function fakeWorld() {
  const objects = new Map([
    [SELF, object(SELF, 4, { x: 0, y: 0, z: 0, orientation: 0 })],
    [OTHER, object(OTHER, 4, { x: 1, y: 0, z: 0, orientation: 0 })],
    [TARGET, object(TARGET, 3, { x: 0, y: 0, z: 0, orientation: 0 })],
    [FOCUS, object(FOCUS, 3, { x: 3, y: 0, z: 0, orientation: 0 })],
  ]);
  return {
    state: { selfGuid: SELF, objects },
    targetGuid: TARGET,
    events: new FakeEvents(),
    threat: new ThreatTables(),
    totems: new Map(),
    casts: new Map(),
    actionButtons: [],
    aurasFor: () => [],
    cooldownRemaining: () => 0,
    cooldownState: () => ({ start: 0, duration: 0, enable: 0 }),
    names: new Map(),
    creatureTemplates: new Map(),
    itemTemplates: new Map(),
    questTemplates: new Map(),
    arenaTeams: new Map(),
    arenaTeamStats: new Map(),
    channels: new Map(),
    chatLog: [],
    worldStateContext: undefined,
    mapId: undefined,
    group: undefined,
    selfName: "Игрок",
    displayName: (guid) => `0x${guid.toString(16)}`,
    sent: [],
    abandonQuest(slot) { this.sent.push(["abandon", slot]); },
    sendAddonMessage(type, prefix, message, target) { this.sent.push(["addon", type, prefix, message, target]); },
    requestArenaTeam(teamId) { this.sent.push(["arenaTeam", teamId]); },
    requestFlagCarriers() { this.sent.push(["positions"]); },
  };
}

function liveSeam(world, spells = new Map()) {
  return new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => spells.get(id), monotonic: () => 0,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
}

test("every census name is answered by the seam binding table", () => {
  for (const name of CENSUS_NAMES) {
    assert.equal(typeof FRAMEXML_SEAM_BINDINGS[name], "function", name);
    assert.ok(FRAMEXML_SEAM_NAMES.includes(name), `${name} is reported as a seam answer`);
  }
});

test("UnitThreatSituation answers the five client statuses from the creature's list and its victim", () => {
  const world = fakeWorld();
  const seam = liveSeam(world);
  const table = (entries, highestGuid) => world.threat.apply({ guid: TARGET, highestGuid, entries });

  assert.deepEqual(call(seam, "UnitThreatSituation", "player", "target"), [], "no list: nil, the corpus' hidden branch");
  table([{ guid: OTHER, threat: 10_000 }], OTHER);
  assert.deepEqual(call(seam, "UnitThreatSituation", "player", "target"), [], "on nobody's list: nil");
  table([{ guid: SELF, threat: 5_000 }, { guid: OTHER, threat: 10_000 }], OTHER);
  assert.deepEqual(call(seam, "UnitThreatSituation", "player", "target"), [0], "below the tank");
  table([{ guid: SELF, threat: 10_000 }, { guid: OTHER, threat: 10_000 }], OTHER);
  assert.deepEqual(call(seam, "UnitThreatSituation", "player", "target"), [1], "at the tank's threat, not tanking");
  table([{ guid: SELF, threat: 10_000 }, { guid: OTHER, threat: 12_000 }], SELF);
  assert.deepEqual(call(seam, "UnitThreatSituation", "player", "target"), [2], "the victim with someone above");
  table([{ guid: SELF, threat: 12_000 }, { guid: OTHER, threat: 10_000 }], SELF);
  assert.deepEqual(call(seam, "UnitThreatSituation", "player", "target"), [3], "the victim with the most threat");
  world.threat.clear(TARGET);
  table([{ guid: SELF, threat: 12_000 }, { guid: OTHER, threat: 10_000 }], undefined);
  assert.deepEqual(call(seam, "UnitThreatSituation", "player", "target"), [3], "no victim heard yet: the top entry tanks");
  assert.deepEqual(call(seam, "UnitThreatSituation", "player", "focus"), [], "the focus has no list");
  assert.deepEqual(call(seam, "UnitThreatSituation", "nobody", "target"), [], "an unknown unit is nil");

  // One argument: the worst standing across every list the unit is on.
  world.threat.apply({ guid: FOCUS, highestGuid: OTHER, entries: [{ guid: SELF, threat: 1_000 }, { guid: OTHER, threat: 9_000 }] });
  assert.deepEqual(call(seam, "UnitThreatSituation", "player"), [3]);
  world.threat.clear(TARGET);
  assert.deepEqual(call(seam, "UnitThreatSituation", "player"), [0]);
  world.threat.clear(FOCUS);
  assert.deepEqual(call(seam, "UnitThreatSituation", "player"), []);
});

test("UnitDetailedThreatSituation scales by the melee or ranged pull threshold and keeps the wire value", () => {
  const world = fakeWorld();
  const seam = liveSeam(world);
  world.threat.apply({ guid: TARGET, highestGuid: OTHER, entries: [{ guid: SELF, threat: 5_500 }, { guid: OTHER, threat: 10_000 }] });
  let [isTanking, status, scaled, raw, value] = call(seam, "UnitDetailedThreatSituation", "player", "target");
  assert.deepEqual([isTanking, status, value], [false, 0, 5_500]);
  assert.ok(Math.abs(raw - 55) < 1e-9, `5500 of the tank's 10000 → ${raw}%`);
  assert.ok(Math.abs(scaled - 50) < 1e-9, `standing next to it: 55% of 110% → ${scaled}`);
  world.state.objects.get(SELF).position = { x: 40, y: 0, z: 0, orientation: 0 };
  [isTanking, status, scaled, raw, value] = call(seam, "UnitDetailedThreatSituation", "player", "target");
  assert.ok(Math.abs(scaled - 55 * 100 / 130) < 1e-9, `forty yards away: 55% of 130% → ${scaled}`);
  world.threat.apply({ guid: TARGET, highestGuid: SELF, entries: [{ guid: SELF, threat: 12_000 }, { guid: OTHER, threat: 10_000 }] });
  assert.deepEqual(call(seam, "UnitDetailedThreatSituation", "player", "target"), [true, 3, 100, 100, 12_000]);
  assert.deepEqual(call(seam, "UnitDetailedThreatSituation", "player", "focus"), [], "no list: every value nil");
});

test("the world's THREAT_CHANGED edge becomes UNIT_THREAT_LIST_UPDATE(mob) and UNIT_THREAT_SITUATION_UPDATE(unit)", () => {
  const world = fakeWorld();
  const seam = liveSeam(world);
  const events = pump();
  seam.attach(events);
  world.threat.apply({ guid: TARGET, highestGuid: SELF, entries: [{ guid: SELF, threat: 100 }] });
  world.events.emit("THREAT_CHANGED", { guid: TARGET });
  const threatEvents = () => events.events.filter(([event]) => event.startsWith("UNIT_THREAT_"));
  assert.deepEqual(threatEvents(), [[FRAMEXML_THREAT_EVENTS.list, "target"], [FRAMEXML_THREAT_EVENTS.situation, "player"]]);
  events.events.length = 0;
  world.threat.clear(TARGET);
  world.events.emit("THREAT_CHANGED", { guid: TARGET });
  assert.deepEqual(threatEvents(), [[FRAMEXML_THREAT_EVENTS.list, "target"], [FRAMEXML_THREAT_EVENTS.situation, "player"]],
    "a removal still reaches the frame that showed the glow");
  events.events.length = 0;
  world.events.emit("THREAT_CHANGED", { guid: 0xf130_0000_0000_0999n });
  assert.deepEqual(threatEvents(), [], "a creature behind no token fires nothing");
  seam.detach();
  world.threat.apply({ guid: TARGET, highestGuid: SELF, entries: [{ guid: SELF, threat: 100 }] });
  world.events.emit("THREAT_CHANGED", { guid: TARGET });
  assert.deepEqual(threatEvents(), [], "detached: unsubscribed");
});

test("IsThreatWarningEnabled follows the threatWarning mode against the instance and group facts", () => {
  let inInstance = false;
  let inGroup = false;
  const model = new FrameXmlThreatModel({ world: () => undefined, unitGuid: () => undefined, inInstance: () => inInstance, inGroup: () => inGroup });
  const enabled = (mode) => FRAMEXML_SEAM_BINDINGS.IsThreatWarningEnabled({ threat: model }, [mode]);
  assert.deepEqual(enabled("0"), [false]);
  assert.deepEqual(enabled("1"), [false]);
  assert.deepEqual(enabled("2"), [false]);
  assert.deepEqual(enabled("3"), [true]);
  assert.deepEqual(enabled(undefined), [true], "no CVar in the map: the client default, always");
  inInstance = true;
  assert.deepEqual(enabled("1"), [true]);
  assert.deepEqual(enabled("2"), [false]);
  inGroup = true;
  assert.deepEqual(enabled("2"), [true]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.IsThreatWarningEnabled({}, ["3"]), [false], "no model: never");
  const world = fakeWorld();
  assert.deepEqual(call(liveSeam(world), "IsThreatWarningEnabled", "2"), [false], "the live seam: no group, no instance");
  assert.deepEqual(call(liveSeam(world), "IsThreatWarningEnabled"), [true]);
});

test("HasKey is true once any keyring slot holds an item, over the live inventory and the canned keyring", () => {
  const world = fakeWorld();
  const seam = liveSeam(world);
  assert.deepEqual(call(seam, "HasKey"), [false]);
  const key = 0x777n;
  world.state.objects.get(SELF).fields.set(UPDATE_FIELDS.PLAYER_FIELD_KEYRING_SLOT_1.offset + 2, Number(key));
  world.state.objects.set(key, object(key, 1, undefined, [
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 6893], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 1],
  ]));
  assert.deepEqual(call(seam, "HasKey"), [true], "the second keyring slot holds a key");
  assert.deepEqual(call(seam, "GetContainerItemInfo", -2, 2).slice(1, 2), [1], "the same slot the keyring window reads");

  const canned = new CannedWorldSeam();
  assert.deepEqual(call(canned, "HasKey"), [false]);
  canned.setContainerItem(-2, 5, { texture: "Interface\\Icons\\INV_Misc_Key_05", count: 1 });
  assert.deepEqual(call(canned, "HasKey"), [true]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.HasKey({}, []), [false], "no containers: no key");
});

function questLog(world, slot, questId, timer = 0) {
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset
    + slot * (UPDATE_FIELDS.PLAYER_QUEST_LOG_2_1.offset - UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset);
  const fields = world.state.objects.get(SELF).fields;
  fields.set(base, questId);
  fields.set(base + 4, timer);
  return base;
}

test("the abandon flow: SetAbandonQuest remembers the selection, the name and items come from the template and the bags, AbandonQuest sends the slot", () => {
  const world = fakeWorld();
  const seam = liveSeam(world);
  questLog(world, 0, 9001);
  const second = questLog(world, 1, 9002);
  world.questTemplates.set(9002, {
    questId: 9002, title: "Испытание", startItem: 6893, itemObjectives: [{ slot: 0, itemId: 4306, count: 5 }],
  });
  assert.deepEqual(call(seam, "GetAbandonQuestName"), [], "nothing remembered yet");
  call(seam, "SelectQuestLogEntry", 2);
  call(seam, "SetAbandonQuest");
  assert.deepEqual(call(seam, "GetAbandonQuestName"), ["Испытание"]);
  assert.deepEqual(call(seam, "GetAbandonQuestItems"), [], "nothing of the quest's is carried");
  const key = 0x778n;
  world.state.objects.get(SELF).fields.set(UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, Number(key));
  world.state.objects.set(key, object(key, 1, undefined, [[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 6893]]));
  assert.deepEqual(call(seam, "GetAbandonQuestItems"), [1], "the source item is in the backpack");
  world.state.objects.get(key).fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 4306);
  assert.deepEqual(call(seam, "GetAbandonQuestItems"), [1], "a required item too");
  world.state.objects.get(key).fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 2589);
  assert.deepEqual(call(seam, "GetAbandonQuestItems"), [], "an unrelated item is not");
  call(seam, "AbandonQuest");
  assert.deepEqual(world.sent, [["abandon", 1]], "the second row is log slot 1");
  assert.equal(seam.questAbandon.pendingQuestId, undefined, "used up");
  assert.deepEqual(call(seam, "GetAbandonQuestName"), []);
  call(seam, "AbandonQuest");
  assert.deepEqual(world.sent, [["abandon", 1]], "a second accept sends nothing");

  // Remembered by id: a quest gone from the log answers nil and is forgotten; one that moved is
  // abandoned by its current slot.
  call(seam, "SelectQuestLogEntry", 2);
  call(seam, "SetAbandonQuest");
  assert.equal(seam.questAbandon.pendingQuestId, 9002);
  world.state.objects.get(SELF).fields.delete(second);
  assert.deepEqual(call(seam, "GetAbandonQuestName"), [], "the quest left the log");
  assert.equal(seam.questAbandon.pendingQuestId, undefined);
  questLog(world, 2, 9002);
  call(seam, "SelectQuestLogEntry", 2);
  call(seam, "SetAbandonQuest");
  world.state.objects.get(SELF).fields.delete(UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset);
  call(seam, "AbandonQuest");
  assert.deepEqual(world.sent.at(-1), ["abandon", 2], "the quest is still in slot 2 after the first row left");
  world.sent.length = 0;
  call(seam, "SelectQuestLogEntry", 0);
  call(seam, "SetAbandonQuest");
  call(seam, "AbandonQuest");
  assert.deepEqual(world.sent, [], "no selection: nothing to abandon");
});

test("the canned quest log abandons its row and fires QUEST_LOG_UPDATE", () => {
  const seam = new CannedWorldSeam();
  const events = pump();
  seam.attach(events);
  assert.deepEqual(call(seam, "GetNumQuestLogEntries"), [1, 1]);
  call(seam, "SelectQuestLogEntry", 1);
  call(seam, "SetAbandonQuest");
  assert.deepEqual(call(seam, "GetAbandonQuestName"), ["Проверка журнала заданий"]);
  assert.deepEqual(call(seam, "GetAbandonQuestItems"), []);
  events.events.length = 0;
  call(seam, "AbandonQuest");
  assert.deepEqual(seam.abandonedQuests, [{ slot: 0, questId: 9001 }]);
  assert.deepEqual(call(seam, "GetNumQuestLogEntries"), [0, 0]);
  assert.deepEqual(call(seam, "GetQuestLogSelection"), [0]);
  assert.deepEqual(events.events, [["QUEST_LOG_UPDATE"]]);
});

function fakeConnection() {
  const queue = [{
    opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    payload: new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(4).toUint8Array(),
  }];
  let pending;
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { pending = resolve; });
    },
    close() {},
  };
}

test("WorldClient.abandonQuest is one CMSG_QUESTLOG_REMOVE_QUEST naming the log slot", async () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  await world.loginCharacter(1n);
  await new Promise((resolve) => setImmediate(resolve));
  world.abandonQuest(3);
  const packet = connection.sent.at(-1);
  assert.equal(packet.opcode, OPCODES.CMSG_QUESTLOG_REMOVE_QUEST);
  assert.deepEqual([...packet.payload], [3]);
  world.close();
});

test("SendAddonMessage maps the stock argument order and channel words onto the add-on chat packet", () => {
  const world = fakeWorld();
  const seam = liveSeam(world);
  assert.deepEqual(FRAMEXML_ADDON_CHAT_TYPES, {
    PARTY: CHAT_MSG_PARTY, RAID: CHAT_MSG_RAID, GUILD: CHAT_MSG_GUILD, BATTLEGROUND: CHAT_MSG_BATTLEGROUND, WHISPER: CHAT_MSG_WHISPER,
  });
  call(seam, "SendAddonMessage", "TSWOW", "hello", "PARTY");
  call(seam, "SendAddonMessage", "TSWOW", "hello", "raid");
  call(seam, "SendAddonMessage", "TSWOW", "hello", "GUILD");
  call(seam, "SendAddonMessage", "TSWOW", "hello", "BATTLEGROUND");
  call(seam, "SendAddonMessage", "TSWOW", "hello", "WHISPER", "Эльмира");
  assert.deepEqual(world.sent, [
    ["addon", CHAT_MSG_PARTY, "TSWOW", "hello", ""],
    ["addon", CHAT_MSG_RAID, "TSWOW", "hello", ""],
    ["addon", CHAT_MSG_GUILD, "TSWOW", "hello", ""],
    ["addon", CHAT_MSG_BATTLEGROUND, "TSWOW", "hello", ""],
    ["addon", CHAT_MSG_WHISPER, "TSWOW", "hello", "Эльмира"],
  ]);
  world.sent.length = 0;
  call(seam, "SendAddonMessage", "TSWOW", "hello", "SAY");
  call(seam, "SendAddonMessage", "TSWOW", "hello", "WHISPER");
  call(seam, "SendAddonMessage", "", "hello", "PARTY");
  call(seam, "SendAddonMessage", "TSWOW", "x".repeat(250), "PARTY");
  assert.deepEqual(world.sent, [], "a chat-only type, a whisper without a target, no prefix and an overlong line send nothing");
  call(seam, "SendAddonMessage", "TSWOW", "x".repeat(249), "PARTY");
  assert.equal(world.sent.length, 1, "255 bytes with the tab is the last line the core accepts");
});

test("chat window LOCKED, DOCKED and UNINTERACTABLE round-trip through GetChatWindowInfo and reset per attach", () => {
  const seam = new CannedWorldSeam();
  const info = (id) => call(seam, "GetChatWindowInfo", id);
  assert.deepEqual(info(1), ["Общий", 14, 1, 1, 1, 0, true, true, true, false]);
  call(seam, "SetChatWindowLocked", 1);
  call(seam, "SetChatWindowUninteractable", 1, 1);
  assert.deepEqual(info(1).slice(7), [false, true, true], "FCF_OpenNewWindow's nil unlocks; the flag is Lua truth");
  call(seam, "SetChatWindowLocked", 1, 1);
  assert.deepEqual(info(1)[7], true);
  assert.deepEqual(info(3), ["", 0, 1, 1, 1, 0, false, true, false, false]);
  call(seam, "SetChatWindowDocked", 3, 2);
  assert.deepEqual(info(3)[8], 2, "FCF_SaveDock's position");
  // Window 2 docked keeps its measured not-shown answer whatever the SHOWN cache says …
  call(seam, "SetChatWindowShown", 2, 1);
  assert.deepEqual(info(2).slice(6, 9), [false, true, 2]);
  // … and once undocked (FCF_UnDockFrame writes nil) it answers the cache, so the next
  // UPDATE_CHAT_WINDOWS does not close the window the player dragged out.
  call(seam, "SetChatWindowDocked", 2);
  assert.deepEqual(info(2).slice(6, 9), [true, true, false]);
  call(seam, "SetChatWindowShown", 2);
  assert.deepEqual(info(2)[6], false);
  call(seam, "SetChatWindowDocked", 11, 1);
  assert.deepEqual(info(11), [], "beyond NUM_CHAT_WINDOWS there is no window");
  seam.attach(pump());
  assert.deepEqual(info(1).slice(7), [true, true, false], "a new load starts from the cache's defaults");
  assert.deepEqual(info(3)[8], false);

  const flags = new FrameXmlChatWindowFlags();
  const base = ["Общий", 14, 1, 1, 1, 0, true, true, true, false];
  assert.deepEqual(flags.apply(1, base, undefined), base, "nothing written: the seam's answer verbatim");
});

test("GetArenaTeam reads the player's slot, asks the world once for the team and repaints on its answer", () => {
  const world = fakeWorld();
  const seam = liveSeam(world);
  const events = pump();
  seam.attach(events);
  assert.deepEqual(call(seam, "GetArenaTeam", 1), [], "no team in the 2v2 slot");
  assert.deepEqual(world.sent, [], "an empty slot asks nothing");
  const base = UPDATE_FIELDS.PLAYER_FIELD_ARENA_TEAM_INFO_1_1.offset;
  const fields = world.state.objects.get(SELF).fields;
  fields.set(base, 7);
  fields.set(base + 3, 12);
  fields.set(base + 4, 30);
  fields.set(base + 6, 1650);
  assert.deepEqual(call(seam, "GetArenaTeam", 1), [], "the team is not known yet");
  call(seam, "GetArenaTeam", 1);
  assert.deepEqual(world.sent, [["arenaTeam", 7]], "asked once");
  world.arenaTeams.set(7, {
    teamId: 7, name: "Тест", type: 2, backgroundColor: 0xff0000ff, emblemStyle: 3, emblemColor: 0xff00ff00,
    borderStyle: 4, borderColor: 0xffff0000,
  });
  assert.deepEqual(call(seam, "GetArenaTeam", 1), [], "the record has not arrived");
  world.arenaTeamStats.set(7, { teamId: 7, rating: 1700, weekGames: 10, weekWins: 6, seasonGames: 40, seasonWins: 25, rank: 12 });
  assert.deepEqual(call(seam, "GetArenaTeam", 1), [
    "Тест", 2, 1700, 10, 6, 40, 25, 12, 30, 12, 1650,
    0, 0, 1, 3, 0, 1, 0, 4, 1, 0, 0,
  ]);
  assert.deepEqual(call(seam, "GetArenaTeam", 2), []);
  assert.deepEqual(call(seam, "GetArenaTeam", 4), [], "three slots only");
  world.events.emit("ARENA_TEAM_CHANGED", { teamId: 7 });
  assert.deepEqual(events.events.filter(([event]) => event === "ARENA_TEAM_UPDATE"), [["ARENA_TEAM_UPDATE"]]);
  seam.detach();
});

// 11.02-IF: rewritten to Wow.exe's rule (FrameXmlPossess.ts, world/PossessBar.ts; the full seam test is
// framexml-possess): the possess spell is the character's *own* aura with a possess or charm effect — Mind
// Control's DUMMY on the caster — looked for when PLAYER_FARSIGHT names an object in view (0x006e4fd0 ->
// 0x005d62a0); GetPossessInfo(2) is SpellIcon 693, the cancel button, and with no spell 0x005d5820 pushes
// three nils. The earlier reading (an aura on the controlled unit, both slots the spell) was not Wow.exe's.
test("the possess bar shows the character's possessing aura once PLAYER_FARSIGHT names the unit", () => {
  const world = fakeWorld();
  const spells = new Map([[605, {
    id: 605, name: "Контроль над разумом", iconPath: "Interface\\Icons\\Spell_Shadow_ShadowWordDominate", effectAura: [2, 4, 138],
  }]]);
  const seam = liveSeam(world, spells);
  seam.attach(pump());
  assert.deepEqual(call(seam, "IsPossessBarVisible"), [false]);
  assert.deepEqual(call(seam, "GetPossessInfo", 1), [undefined, undefined, undefined]);
  const possessed = TARGET;
  world.controlledGuid = possessed;
  world.petSpells = { guid: possessed, closed: false, bar: [{ slot: 0, packed: 0x0700_0002, action: 2, type: 7 }], spells: [] };
  world.aurasFor = (guid) => guid === SELF
    ? [{ slot: 0, spellId: 605, flags: 0x18, casterLevel: 80, applications: 1, casterGuid: SELF }] : [];
  seam.possess.tick();
  assert.deepEqual(call(seam, "IsPossessBarVisible"), [false], "control, a bar and the aura, but no far sight yet");
  const self = world.state.objects.get(SELF);
  const farSight = UPDATE_FIELDS.PLAYER_FARSIGHT.offset;
  self.fields.set(farSight, Number(possessed & 0xffff_ffffn));
  self.fields.set(farSight + 1, Number(possessed >> 32n));
  seam.possess.tick();
  assert.deepEqual(call(seam, "IsPossessBarVisible"), [true]);
  assert.deepEqual(call(seam, "GetPossessInfo", 1), ["Interface\\Icons\\Spell_Shadow_ShadowWordDominate", "Контроль над разумом", true]);
  assert.deepEqual(call(seam, "GetPossessInfo", 2), ["Interface\\Icons\\Spell_Shadow_SacrificialShield", "Контроль над разумом", true]);
  assert.deepEqual(call(seam, "GetPossessInfo", 3), [undefined, undefined, undefined], "NUM_POSSESS_SLOTS is 2");
  self.fields.set(farSight, 0);
  self.fields.set(farSight + 1, 0);
  seam.possess.tick();
  assert.deepEqual(call(seam, "IsPossessBarVisible"), [false], "the far sight cleared: 0x005d30e0(0)");
  seam.detach();
});

test("GetBattlefieldWinner and RequestBattlefieldPositions ride the scoreboard and the carrier poll", () => {
  const world = fakeWorld();
  const seam = liveSeam(world);
  assert.deepEqual(call(seam, "GetBattlefieldWinner"), []);
  world.pvpScores = { ended: false, winner: 2, arena: false, teams: [], scores: [] };
  assert.deepEqual(call(seam, "GetBattlefieldWinner"), [], "not over yet");
  world.pvpScores = { ended: true, winner: 1, arena: false, teams: [], scores: [] };
  assert.deepEqual(call(seam, "GetBattlefieldWinner"), [1], "the Alliance won");
  world.pvpScores = { ended: true, winner: 0, arena: false, teams: [], scores: [] };
  assert.deepEqual(call(seam, "GetBattlefieldWinner"), [0], "the Horde won");
  // UIParent passes `elapsed` (UIParent.xml:25), WorldMapFrame_OnUpdate nothing (WorldMapFrame.lua:206).
  // The binding hands every call on; WorldClient.requestFlagCarriers decides what reaches the wire.
  call(seam, "RequestBattlefieldPositions", 0.016);
  call(seam, "RequestBattlefieldPositions");
  assert.deepEqual(world.sent, [["positions"], ["positions"]]);
});

test("RequestBattlefieldPositions on every frame outside a battleground puts nothing on the wire", async () => {
  // On 2026-09-28 stock UIParent's per-frame call was one MSG_BATTLEGROUND_PLAYER_POSITIONS each,
  // 99,217 in 33 minutes; the core answers it only inside a battleground. The whole route here:
  // seam binding, mechanics model, a real WorldClient.
  const connection = fakeConnection();
  const client = new WorldClient(connection);
  await client.loginCharacter(1n);
  await new Promise((resolve) => setImmediate(resolve));
  try {
    const seam = liveSeam(client);
    for (let frame = 0; frame < 144 * 60; frame++) call(seam, "RequestBattlefieldPositions", 1 / 144);
    assert.equal(connection.sent.filter(({ opcode }) => opcode === OPCODES.MSG_BATTLEGROUND_PLAYER_POSITIONS).length, 0);
  } finally { client.close(); }
});

test("GetQuestTimers lists the timed quests' remaining seconds in log order, GetQuestIndexForTimer their rows", () => {
  const host = { questLogEntryCount: () => [3, 3], questLogTimeLeft: (index) => (index === 2 ? 90 : index === 3 ? 15 : undefined) };
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestTimers(host, []), [90, 15]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestIndexForTimer(host, [1]), [2]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestIndexForTimer(host, [2]), [3]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestIndexForTimer(host, [3]), []);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestTimers({}, []), [], "no log: no timers");
  const canned = new CannedWorldSeam();
  assert.deepEqual(call(canned, "GetQuestTimers"), [90], "the canned quest's timer");
  assert.deepEqual(call(canned, "GetQuestIndexForTimer", 1), [1]);
});

test("the honest constants: no Mac, no play-time limit, no voice, an empty static table", () => {
  const seam = new CannedWorldSeam();
  assert.deepEqual(call(seam, "IsMacClient"), [false]);
  assert.deepEqual(call(seam, "NoPlayTime"), [false]);
  assert.deepEqual(call(seam, "PartialPlayTime"), [false]);
  assert.deepEqual(call(seam, "UnitIsTalking", "Игрок"), [false]);
  assert.deepEqual(call(seam, "RegisterStaticConstants"), []);
  const pairs = call(seam, "FillLocalizedClassList", false);
  assert.equal(pairs.length, 20, "ten classes, token then name");
  assert.deepEqual(pairs.slice(0, 2), ["WARRIOR", "Воин"]);
  assert.ok(pairs.includes("DEATHKNIGHT") && pairs.includes("Рыцарь смерти"));
  assert.deepEqual(call(seam, "FillLocalizedClassList", true), pairs, "nothing learned: the compiled names serve both sexes");
});

test("FillLocalizedClassList walks every class the dataset has, past 11, and honours isFemale (9.05)", async () => {
  const { learnCreationNames, forgetCreationNames, knownClassIds } = await import("../dist/code/browser/ui/UnitSnapshot.js");
  const seam = new CannedWorldSeam();
  // This dataset's ChrClasses: 1-9, 11 stock, 12 ARCHAEOLOGIST and 13 HERO (TSWoW). The gateway
  // fills nameFemale/nameMale by the client's fallback rule, so a stock row with no female column
  // arrives with the base name in both.
  const classes = [
    [1, "WARRIOR", "Воин", "Воин"], [2, "PALADIN", "Паладин", "Паладин"], [3, "HUNTER", "Охотник", "Охотница"],
    [4, "ROGUE", "Разбойник", "Разбойница"], [5, "PRIEST", "Жрец", "Жрица"], [6, "DEATHKNIGHT", "Рыцарь смерти", "Рыцарь смерти"],
    [7, "SHAMAN", "Шаман", "Шаманка"], [8, "MAGE", "Маг", "Маг"], [9, "WARLOCK", "Чернокнижник", "Чернокнижница"],
    [11, "DRUID", "Друид", "Друид"], [12, "ARCHAEOLOGIST", "Археолог", "Археолог"], [13, "HERO", "Герой", "Герой"],
  ].map(([id, fileName, name, nameFemale]) => ({ id, fileName, name, nameMale: name, nameFemale }));
  learnCreationNames([], classes);
  try {
    assert.deepEqual(knownClassIds(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]);
    const male = call(seam, "FillLocalizedClassList", false);
    const female = call(seam, "FillLocalizedClassList", true);
    assert.equal(male.length, 24, "twelve classes, token then name");
    const asMap = (list) => Object.fromEntries(Array.from({ length: list.length / 2 }, (_, i) => [list[2 * i], list[2 * i + 1]]));
    const m = asMap(male);
    const f = asMap(female);
    assert.equal(m.HERO, "Герой");
    assert.equal(m.ARCHAEOLOGIST, "Археолог");
    assert.equal(m.HUNTER, "Охотник");
    assert.equal(f.HUNTER, "Охотница", "isFemale picks the female column");
    assert.equal(f.PRIEST, "Жрица");
    assert.equal(f.WARRIOR, "Воин", "no female column: the base name");
    assert.equal(f.HERO, "Герой");
  } finally {
    forgetCreationNames();
  }
  // An older gateway (no nameFemale): the female list falls back to the base name.
  learnCreationNames([], [{ id: 3, fileName: "HUNTER", name: "Охотник" }]);
  try {
    const f = call(seam, "FillLocalizedClassList", true);
    assert.equal(f[f.indexOf("HUNTER") + 1], "Охотник");
  } finally {
    forgetCreationNames();
  }
});

test("the canned target's threat list: the player tanks it at 100%, party1 stands at 40%", () => {
  const seam = new CannedWorldSeam();
  const events = pump();
  seam.attach(events);
  assert.deepEqual(call(seam, "UnitThreatSituation", "player", "target"), [], "no target yet");
  seam.tick(10);
  seam.tick(10);
  assert.deepEqual(call(seam, "UnitExists", "target"), [true]);
  assert.deepEqual(call(seam, "UnitThreatSituation", "player", "target"), [3]);
  assert.deepEqual(call(seam, "UnitDetailedThreatSituation", "player", "target"), [true, 3, 100, 100, CANNED_PLAYER_THREAT]);
  assert.deepEqual(call(seam, "UnitThreatSituation", "party1", "target"), [0]);
  assert.deepEqual(call(seam, "UnitDetailedThreatSituation", "party1", "target").slice(2), [40 * 100 / 110, 40, 50_000]);
  assert.deepEqual(call(seam, "IsThreatWarningEnabled", "3"), [true]);
  seam.detach();
});
