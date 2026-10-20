import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-arena-enemy-seam.test.mjs
{
// The enemy arena team behind `arenaN`/`arenapetN` (FrameXmlArena.ts) over the live seam: only a
// running arena match (SMSG_BATTLEFIELD_STATUS), only players whose PLAYER_BYTES_3 arena-faction byte
// differs from the player's own, slots in the order they come into sight, «seen»/«unseen»/«cleared»,
// UNIT_PET, the UnitFrame field edges, the cast bar, and the C API Blizzard_ArenaUI reads.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { frameXmlArenaToken } = await import("../dist/code/browser/framexml/FrameXmlArena.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }
  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
  count(name) { return this.#listeners.get(name)?.size ?? 0; }
}

const IN_PROGRESS = 3;
const HORDE_TEAM = 0;
const ALLIANCE_TEAM = 1;

function unit(guid, typeId, fields = {}) {
  const object = { guid, typeId, fields: new Map() };
  for (const [name, value] of Object.entries(fields)) object.fields.set(UPDATE_FIELDS[name].offset, value);
  return object;
}

function setGuid(object, name, guid) {
  object.fields.set(UPDATE_FIELDS[name].offset, Number(guid & 0xffffffffn));
  object.fields.set(UPDATE_FIELDS[name].offset + 1, Number(guid >> 32n));
}

/** class, power type in UNIT_FIELD_BYTES_0 (race 1, class byte 1, gender 2, power 3). */
const bytes0 = (classId, powerType) => (1 | (classId << 8) | (powerType << 24)) >>> 0;

function fixture() {
  const selfGuid = 0x10n;
  // The player is on the Alliance team (SetBGTeam: 1); a teammate the same; the Horde team's words
  // carry byte 3 = 0, which a create block leaves out altogether.
  const self = unit(selfGuid, 4, { PLAYER_BYTES_3: ALLIANCE_TEAM << 24, UNIT_FIELD_BYTES_0: bytes0(1, 1) });
  const mate = unit(0x11n, 4, { PLAYER_BYTES_3: ALLIANCE_TEAM << 24, UNIT_FIELD_BYTES_0: bytes0(5, 0) });
  const rogue = unit(0x32n, 4, {
    UNIT_FIELD_BYTES_0: bytes0(4, 3), UNIT_FIELD_HEALTH: 9000, UNIT_FIELD_MAXHEALTH: 10000,
  });
  rogue.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 80);
  rogue.fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + 3, 100);
  const hunter = unit(0x31n, 4, {
    PLAYER_BYTES_3: (HORDE_TEAM << 24) | 1, UNIT_FIELD_BYTES_0: bytes0(3, 0),
    UNIT_FIELD_HEALTH: 7000, UNIT_FIELD_MAXHEALTH: 8000,
  });
  hunter.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 5000);
  hunter.fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset, 6000);
  const wolf = unit(0xf1300000000009a1n, 3, { UNIT_FIELD_HEALTH: 3000, UNIT_FIELD_MAXHEALTH: 3000, UNIT_FIELD_BYTES_0: bytes0(1, 2) });
  setGuid(wolf, "UNIT_FIELD_SUMMONEDBY", hunter.guid);
  setGuid(hunter, "UNIT_FIELD_SUMMON", wolf.guid);
  const objects = new Map([[selfGuid, self], [mate.guid, mate]]);
  const events = new FakeEvents();
  const world = {
    state: { selfGuid, objects },
    battlefieldQueues: new Map(),
    names: new Map([[rogue.guid, "Тень"], [hunter.guid, "Ловчий"], [mate.guid, "Друг"]]),
    casts: new Map(),
    events,
    group: undefined,
    partyStats: new Map(),
    creatureTemplates: new Map(),
  };
  const fired = [];
  const pump = { now: () => 100, fire: (event, ...args) => { fired.push([event, ...args]); return 1; } };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, monotonic: () => 5_000,
    spell: (id) => (id === 2139 ? { id, name: "Антимагия", rank: "", iconPath: "Interface\\Icons\\Spell_Frost_IceShock" } : undefined),
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  seam.attach(pump);
  const arenaEvents = () => fired.filter(([event]) => event === "ARENA_OPPONENT_UPDATE" || event === "UNIT_PET"
    || /^UNIT_(HEALTH|MAXHEALTH|MANA|MAXMANA|ENERGY|MAXENERGY|FOCUS|NAME_UPDATE|DISPLAYPOWER|SPELLCAST_)/.test(event));
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  const enterArena = () => world.battlefieldQueues.set(0, {
    queueSlot: 0, status: IN_PROGRESS, isArena: true, cleared: false, clientInstanceId: 7, mapId: 559, arenaType: 2,
  });
  return { seam, world, objects, events, fired, pump, call, arenaEvents, enterArena, rogue, hunter, wolf, mate };
}

test("the token parser takes arena1-5 and arenapet1-5 and nothing else", () => {
  assert.deepEqual(frameXmlArenaToken("arena1"), [1, false]);
  assert.deepEqual(frameXmlArenaToken("ARENAPET5"), [5, true]);
  for (const other of ["arena0", "arena6", "arena1target", "arenapet", "party1", "raid1"]) {
    assert.equal(frameXmlArenaToken(other), undefined, other);
  }
});

test("outside a running arena nothing is an opponent, IsInInstance keeps the neutral answer (nil, \"none\": Wow.exe 0x5156a0)", () => {
  const { seam, objects, world, call, arenaEvents, rogue } = fixture();
  objects.set(rogue.guid, rogue);
  seam.arena.tick();
  assert.deepEqual(call("GetNumArenaOpponents"), [0]);
  assert.deepEqual(call("IsInInstance"), [undefined, "none"]);
  assert.deepEqual(call("UnitExists", "arena1"), [false]);
  assert.deepEqual(call("UnitGUID", "arena1"), []);
  // A queued (not yet running) arena is not an arena either.
  world.battlefieldQueues.set(0, { queueSlot: 0, status: 1, isArena: true, cleared: false });
  seam.arena.tick();
  assert.deepEqual(call("IsInInstance"), [undefined, "none"]);
  assert.deepEqual(arenaEvents(), []);
});

test("opponents take slots as they come into sight; teammates never do; the unit API answers them", () => {
  const { seam, objects, call, fired, arenaEvents, enterArena, rogue, hunter, wolf } = fixture();
  let entered = 0;
  seam.arena.onEnter = () => { entered += 1; };
  enterArena();
  seam.arena.tick();
  assert.equal(entered, 1, "the match edge");
  assert.deepEqual(call("IsInInstance"), [1, "arena"]);
  assert.deepEqual(call("GetNumArenaOpponents"), [0], "no one in sight yet");

  // Both come into sight in one update: slots by GUID, so the hunter (0x31) is arena1.
  objects.set(rogue.guid, rogue);
  objects.set(hunter.guid, hunter);
  objects.set(wolf.guid, wolf);
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [
    ["ARENA_OPPONENT_UPDATE", "arena1", "seen"],
    ["UNIT_PET", "arena1"],
    ["ARENA_OPPONENT_UPDATE", "arenapet1", "seen"],
    ["ARENA_OPPONENT_UPDATE", "arena2", "seen"],
  ]);
  assert.deepEqual(call("GetNumArenaOpponents"), [2]);
  assert.deepEqual(call("UnitExists", "arena1"), [true]);
  assert.deepEqual(call("UnitName", "arena1"), ["Ловчий"]);
  assert.deepEqual(call("UnitClass", "arena1").slice(1), ["HUNTER"]);
  assert.deepEqual(call("UnitClass", "arena2").slice(1), ["ROGUE"]);
  assert.deepEqual(call("UnitHealth", "arena2"), [9000]);
  assert.deepEqual(call("UnitHealthMax", "arena2"), [10000]);
  assert.deepEqual(call("UnitPowerType", "arena2"), [3, "ENERGY"]);
  assert.deepEqual(call("UnitPower", "arena2"), [80]);
  assert.deepEqual(call("UnitExists", "arenapet1"), [true]);
  assert.deepEqual(call("UnitHealth", "arenapet1"), [3000]);
  assert.deepEqual(call("UnitExists", "arenapet2"), [false], "the rogue has no pet");
  assert.deepEqual(call("UnitIsUnit", "arena2", "arena2"), [true]);
  assert.deepEqual(call("UnitIsUnit", "arena1", "arena2"), [false]);
  assert.equal(typeof call("UnitGUID", "arena2")[0], "string");
  assert.notEqual(call("UnitGUID", "arena1")[0], call("UnitGUID", "arena2")[0]);
  assert.deepEqual(call("UnitExists", "arena3"), [false]);
  assert.equal(seam.arena.unitFor(0x11n), undefined, "the teammate has no arena slot");

  // Field edges for the frames' bars: health, then power in the unit's own power event.
  fired.length = 0;
  rogue.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 4000);
  rogue.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 20);
  hunter.fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset, 6500);
  wolf.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [
    ["UNIT_MAXMANA", "arena1"],
    ["UNIT_HEALTH", "arenapet1"],
    ["UNIT_HEALTH", "arena2"],
    ["UNIT_ENERGY", "arena2"],
  ]);
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [], "nothing moved, nothing fires");
});

test("out of sight is «unseen» with the GUID, class and name kept; back in sight is «seen»; leaving clears", () => {
  const { seam, objects, world, call, fired, arenaEvents, enterArena, rogue, hunter, wolf } = fixture();
  enterArena();
  objects.set(hunter.guid, hunter);
  objects.set(wolf.guid, wolf);
  seam.arena.tick();
  objects.set(rogue.guid, rogue);
  seam.arena.tick();
  const rogueGuid = call("UnitGUID", "arena2")[0];

  // The rogue stealths: SMSG_DESTROY_OBJECT / out-of-range. Its slot stays.
  objects.delete(rogue.guid);
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [["ARENA_OPPONENT_UPDATE", "arena2", "unseen"]]);
  assert.deepEqual(call("UnitExists", "arena2"), [false]);
  assert.deepEqual(call("UnitGUID", "arena2"), [rogueGuid]);
  assert.deepEqual(call("UnitClass", "arena2").slice(1), ["ROGUE"]);
  assert.deepEqual(call("UnitName", "arena2"), ["Тень"]);
  assert.deepEqual(call("GetNumArenaOpponents"), [2]);

  // The hunter's pet dies and is removed; the owner's SUMMON goes to 0 → UNIT_PET, no pet GUID.
  objects.delete(wolf.guid);
  hunter.fields.delete(UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset);
  hunter.fields.delete(UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset + 1);
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [["UNIT_PET", "arena1"]]);
  assert.deepEqual(call("UnitGUID", "arenapet1"), []);

  // The rogue opens from stealth: the same slot.
  objects.set(rogue.guid, rogue);
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [["ARENA_OPPONENT_UPDATE", "arena2", "seen"]]);
  assert.deepEqual(call("UnitGUID", "arena2"), [rogueGuid]);

  // The match ends and the player ports out: every slot «cleared», nothing answers any more.
  world.battlefieldQueues.clear();
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [
    ["ARENA_OPPONENT_UPDATE", "arena1", "cleared"],
    ["ARENA_OPPONENT_UPDATE", "arena2", "cleared"],
  ]);
  assert.deepEqual(call("GetNumArenaOpponents"), [0]);
  assert.deepEqual(call("UnitGUID", "arena2"), []);
  assert.deepEqual(call("IsInInstance"), [undefined, "none"]);
});

test("a pet in sight whose owner is not yet seen is found by UNIT_FIELD_SUMMONEDBY", () => {
  const { seam, objects, call, arenaEvents, enterArena, hunter, wolf } = fixture();
  // The owner's SUMMON is not in its words here: only the wolf's own field can name it.
  hunter.fields.delete(UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset);
  hunter.fields.delete(UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset + 1);
  enterArena();
  objects.set(hunter.guid, hunter);
  seam.arena.tick();
  objects.delete(hunter.guid);
  seam.arena.tick();
  assert.deepEqual(call("UnitGUID", "arenapet1"), []);
  objects.set(wolf.guid, wolf);
  seam.arena.tick();
  assert.deepEqual(call("UnitExists", "arenapet1"), [true]);
  assert.deepEqual(arenaEvents().slice(-2), [["UNIT_PET", "arena1"], ["ARENA_OPPONENT_UPDATE", "arenapet1", "seen"]]);
});

test("an opponent's cast reaches its cast bar: UNIT_SPELLCAST_* for arenaN and UnitCastingInfo", () => {
  const { seam, objects, world, events, fired, call, enterArena, rogue } = fixture();
  enterArena();
  objects.set(rogue.guid, rogue);
  seam.arena.tick();
  world.casts.set(rogue.guid, { spellId: 2139, startedAt: 4_000, duration: 1_500, channel: false, castCount: 9 });
  fired.length = 0;
  events.emit("SPELL_CAST_START", { casterGuid: rogue.guid, spellId: 2139, castTime: 1_500, channel: false });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_START", "arena1", "Антимагия", "", 9]]);
  // pump.now() 100 s, monotonic 5000 ms, started at 4000 ms: GetTime()-based start 99 000 ms.
  assert.deepEqual(call("UnitCastingInfo", "arena1"),
    ["Антимагия", "", "Антимагия", "Interface\\Icons\\Spell_Frost_IceShock", 99_000, 100_500, false, 9, false]);
  assert.deepEqual(call("UnitChannelInfo", "arena1"), []);
  fired.length = 0;
  events.emit("SPELL_CAST_DELAYED", { casterGuid: rogue.guid, delay: 200 });
  world.casts.delete(rogue.guid);
  events.emit("SPELL_CAST_STOP", { casterGuid: rogue.guid, spellId: 2139, interrupted: true, reason: "interrupted" });
  assert.deepEqual(fired, [
    ["UNIT_SPELLCAST_DELAYED", "arena1", "Антимагия", "", 9],
    ["UNIT_SPELLCAST_INTERRUPTED", "arena1", "Антимагия", "", 9],
  ]);
  // A caster that is not an opponent in sight fires nothing for arena frames.
  fired.length = 0;
  events.emit("SPELL_CAST_START", { casterGuid: 0x11n, spellId: 2139, castTime: 1_500, channel: false });
  assert.deepEqual(fired.filter(([, unitToken]) => typeof unitToken === "string" && unitToken.startsWith("arena")), []);
  // Detach releases the subscriptions.
  const before = events.count("SPELL_CAST_START");
  seam.detach();
  assert.ok(events.count("SPELL_CAST_START") < before);
});

test("a sixth enemy in sight takes no slot: MAX_ARENA_ENEMIES is five", () => {
  const { seam, objects, call, enterArena } = fixture();
  enterArena();
  for (let index = 0; index < 6; index += 1) objects.set(0x40n + BigInt(index), unit(0x40n + BigInt(index), 4, {}));
  seam.arena.tick();
  assert.deepEqual(call("GetNumArenaOpponents"), [5]);
  assert.equal(seam.arena.unitFor(0x45n), undefined);
  assert.equal(seam.arena.unitFor(0x40n), "arena1");
});
}

// ── framexml-arena-roster-seam.test.mjs
{
// Plan item 3.15: PVPFrame's arena team roster and team commands (FrameXmlArenaRoster.ts), with the
// original client's answers (Wow.exe 0x5a3600, 0x5a2930, 0x5a2fc0, 0x5a2b80/0x5a2f40, 0x5a2e80/0x5a2bd0,
// 0x60dc70, 0x5a3e10, 0x6cc980 → 0x5a28e0, 0x515cc0..0x516130).

const { FrameXmlArenaRosterModel, FRAMEXML_ARENA_ROSTER_BINDINGS, FRAMEXML_ARENA_ROSTER_REQUEST_INTERVAL_MS } =
  await import("../dist/code/browser/framexml/FrameXmlArenaRoster.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const SLOT_BASE = UPDATE_FIELDS.PLAYER_FIELD_ARENA_TEAM_INFO_1_1.offset;

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

class Events {
  #listeners = new Map();
  on(name, listener) {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(listener);
    this.#listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name, payload = {}) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
}

function member(guid, name, overrides = {}) {
  return {
    guid, online: true, name, captain: false, level: 80, classId: 1,
    weekGames: 0, weekWins: 0, seasonGames: 0, seasonWins: 0, personalRating: 1500, ...overrides,
  };
}

const ROSTER = {
  teamId: 77, type: 3,
  members: [
    member(3n, "Вика", { classId: 5, online: false, weekGames: 4, weekWins: 1, seasonGames: 20, seasonWins: 9, personalRating: 1400 }),
    member(1n, "Аня", { captain: true, weekGames: 10, weekWins: 7, seasonGames: 30, seasonWins: 20, personalRating: 1620 }),
    member(2n, "Боря", { classId: 99, weekGames: 6, weekWins: 3, seasonGames: 12, seasonWins: 6, personalRating: 1510 }),
  ],
};

function fixture({ captain = true } = {}) {
  const self = { fields: new Map() };
  // Slot 2 (3v3) holds team 77; slots 1 and 3 are empty.
  self.fields.set(SLOT_BASE + 7, 77);
  self.fields.set(SLOT_BASE + 7 + 1, 3);
  self.fields.set(SLOT_BASE + 7 + 2, captain ? 0 : 1);
  const world = {
    events: new Events(),
    arenaTeamRosters: new Map(),
    arenaTeamInvite: undefined,
    sent: [],
    requestArenaTeamRoster(teamId) { this.sent.push(["roster", teamId]); },
    inviteToArenaTeam(teamId, name) { this.sent.push(["invite", teamId, name]); },
    leaveArenaTeam(teamId) { this.sent.push(["leave", teamId]); },
    removeFromArenaTeam(teamId, name) { this.sent.push(["remove", teamId, name]); },
    promoteArenaTeamCaptain(teamId, name) { this.sent.push(["promote", teamId, name]); },
    disbandArenaTeam(teamId) { this.sent.push(["disband", teamId]); },
  };
  const clock = { now: 50_000 };
  const roster = new FrameXmlArenaRosterModel({ world: () => world, self: () => self, now: () => clock.now });
  const events = [];
  roster.attach({ fire(event, ...args) { events.push([event, ...args]); return 1; } });
  const call = (name, ...args) => [...FRAMEXML_ARENA_ROSTER_BINDINGS[name]({ arenaRoster: roster }, args)];
  const arrive = (value = ROSTER) => {
    world.arenaTeamRosters.set(value.teamId, value);
    world.events.emit("ARENA_TEAM_CHANGED", { teamId: value.teamId });
  };
  return { self, world, clock, roster, events, call, arrive };
}

test("ArenaTeamRoster asks for the slot's team id, once per 10 s per slot, never for an empty slot", () => {
  const { world, clock, call } = fixture();
  assert.deepEqual(call("ArenaTeamRoster", 2), []);
  call("ArenaTeamRoster", 2);
  call("ArenaTeamRoster", 1);
  call("ArenaTeamRoster", 4);
  assert.deepEqual(world.sent, [["roster", 77]], "the slot's team id, not the slot number");
  clock.now += FRAMEXML_ARENA_ROSTER_REQUEST_INTERVAL_MS;
  call("ArenaTeamRoster", 2);
  assert.deepEqual(world.sent, [["roster", 77], ["roster", 77]]);
});

test("GetArenaTeamRosterInfo: ten values in stock order, the roster sorted by name", () => {
  const { call, arrive, events } = fixture();
  assert.deepEqual(call("GetNumArenaTeamMembers", 2, 1), [0], "no roster yet");
  arrive();
  assert.deepEqual(events, [["ARENA_TEAM_ROSTER_UPDATE"]], "a roster is announced without an argument");
  assert.deepEqual(call("GetNumArenaTeamMembers", 2, 1), [3]);
  assert.deepEqual(call("GetNumArenaTeamMembers", 2), [3], "the show-offline switch is on: offline members count");
  assert.deepEqual(call("GetArenaTeamRosterInfo", 2, 1), ["Аня", 0, 80, "Воин", 1, 10, 7, 30, 20, 1620]);
  const [name, rank, level, className, online, played, win, seasonPlayed, seasonWin, rating] = call("GetArenaTeamRosterInfo", 2, 3);
  assert.deepEqual([name, rank, level, className, online], ["Вика", 1, 80, "Жрец", undefined]);
  assert.equal(played - win, 3, "stock's `played - win` works on numbers");
  assert.equal(seasonPlayed - seasonWin, 11);
  assert.equal(rating, 1400);
  assert.equal(call("GetArenaTeamRosterInfo", 2, 2)[3], undefined, "a class the client does not know is nil");
  assert.deepEqual(call("GetArenaTeamRosterInfo", 2, 4), [undefined, 0, 0, undefined, undefined, 0, 0, 0, 0, 0]);
  assert.deepEqual(call("GetArenaTeamRosterInfo", 1, 1), [undefined, 0, 0, undefined, undefined, 0, 0, 0, 0, 0]);
});

test("SortArenaTeamRoster moves or flips a key and redraws the rosters", () => {
  const { call, arrive, events } = fixture();
  arrive();
  events.length = 0;
  const names = () => [1, 2, 3].map((index) => call("GetArenaTeamRosterInfo", 2, index)[0]);
  call("SortArenaTeamRoster", "rating");
  assert.deepEqual(names(), ["Аня", "Боря", "Вика"]);
  assert.deepEqual(events, [["ARENA_TEAM_ROSTER_UPDATE"]], "one redraw for the one roster held");
  call("SortArenaTeamRoster", "rating");
  assert.deepEqual(names(), ["Вика", "Боря", "Аня"], "flipped");
  call("SortArenaTeamRoster", "played");
  assert.deepEqual(names(), ["Аня", "Боря", "Вика"]);
  call("SortArenaTeamRoster", "whatever");
  assert.deepEqual(names(), ["Аня", "Боря", "Вика"], "an unknown word is «name»");
});

test("the selection is one guid: its row in the slot, 0 elsewhere or when cleared", () => {
  const { call, arrive } = fixture();
  arrive();
  assert.deepEqual(call("GetArenaTeamRosterSelection", 2), [0]);
  call("SetArenaTeamRosterSelection", 2, 3);
  assert.deepEqual(call("GetArenaTeamRosterSelection", 2), [3]);
  assert.deepEqual(call("GetArenaTeamRosterSelection", 1), [0]);
  call("SortArenaTeamRoster", "rating");
  call("SortArenaTeamRoster", "rating");
  assert.deepEqual(call("GetArenaTeamRosterSelection", 2), [1], "the row follows the member through a sort");
  assert.deepEqual(call("CloseArenaTeamRoster"), []);
  assert.deepEqual(call("GetArenaTeamRosterSelection", 2), [1], "CloseArenaTeamRoster is the client's empty function");
  call("SetArenaTeamRosterSelection", 2, 9);
  assert.deepEqual(call("GetArenaTeamRosterSelection", 2), [0]);
});

test("IsArenaTeamCaptain reads the slot's MEMBER word: 1 for 0, nil otherwise", () => {
  const captain = fixture();
  assert.deepEqual(captain.call("IsArenaTeamCaptain", 2), [1]);
  const member = fixture({ captain: false });
  assert.deepEqual(member.call("IsArenaTeamCaptain", 2), [undefined]);
  assert.deepEqual(member.call("IsArenaTeamCaptain", 4), [undefined]);
  const nobody = new FrameXmlArenaRosterModel({ world: () => undefined, self: () => undefined, now: () => 0 });
  assert.deepEqual([...FRAMEXML_ARENA_ROSTER_BINDINGS.IsArenaTeamCaptain({ arenaRoster: nobody }, [2])], [undefined]);
});

test("the popup commands send with the slot's team id; long names are refused", () => {
  const { world, call } = fixture();
  call("ArenaTeamInviteByName", 2, "Гость");
  call("ArenaTeamInviteByName", 2, "");
  call("ArenaTeamInviteByName", 2, undefined);
  call("ArenaTeamInviteByName", 2, "Ж".repeat(25));
  call("ArenaTeamLeave", 2);
  call("ArenaTeamUninviteByName", 2, "Боря");
  call("ArenaTeamSetLeaderByName", 2, "Вика");
  call("ArenaTeamDisband", 2);
  assert.deepEqual(world.sent, [
    ["invite", 77, "Гость"], ["leave", 77], ["remove", 77, "Боря"], ["promote", 77, "Вика"], ["disband", 77],
  ]);
  call("ArenaTeamLeave", 1);
  assert.deepEqual(world.sent.at(-1), ["leave", 0], "an empty slot reaches the world as team 0 (which drops it)");
});

test("SMSG_ARENA_TEAM_EVENT: three ARENA_TEAM_ROSTER_UPDATE(1) and the request spacing cleared", () => {
  const { world, events, call, arrive } = fixture();
  arrive();
  call("ArenaTeamRoster", 2);
  call("ArenaTeamRoster", 2);
  assert.equal(world.sent.length, 1);
  events.length = 0;
  world.events.emit("ARENA_TEAM_CHANGED", { teamId: undefined });
  assert.deepEqual(events, [["ARENA_TEAM_ROSTER_UPDATE", 1], ["ARENA_TEAM_ROSTER_UPDATE", 1], ["ARENA_TEAM_ROSTER_UPDATE", 1]]);
  call("ArenaTeamRoster", 2);
  assert.equal(world.sent.length, 2, "stock's re-request goes out at once");
  events.length = 0;
  world.arenaTeamInvite = { inviter: "x" };
  world.events.emit("ARENA_TEAM_CHANGED", { teamId: undefined });
  assert.deepEqual(events, [], "an invitation is not a team event");
  world.events.emit("ARENA_TEAM_CHANGED", { teamId: 77 });
  assert.deepEqual(events, [], "the same roster again (a stats or tabard answer) is not a roster update");
  world.arenaTeamRosters.set(55, { teamId: 55, type: 2, members: [] });
  world.events.emit("ARENA_TEAM_CHANGED", { teamId: 55 });
  assert.deepEqual(events, [], "a roster of a team the player holds no slot in is dropped");
});

test("a team event after the invitation was answered is still a team event", () => {
  // WorldClient.answerArenaTeamInvite clears the invitation without an event; the JOIN broadcast
  // the core sends next (ArenaTeam::AddMember → BroadcastEvent) must still ask for the roster.
  const { world, events } = fixture();
  world.arenaTeamInvite = { inviter: "x" };
  world.events.emit("ARENA_TEAM_CHANGED", { teamId: undefined });
  assert.deepEqual(events, [], "the invitation itself");
  world.arenaTeamInvite = undefined;
  world.events.emit("ARENA_TEAM_CHANGED", { teamId: undefined });
  assert.deepEqual(events, [["ARENA_TEAM_ROSTER_UPDATE", 1], ["ARENA_TEAM_ROSTER_UPDATE", 1], ["ARENA_TEAM_ROSTER_UPDATE", 1]]);
});

test("the seams bind the names; canned and live reach the world", () => {
  const canned = new CannedWorldSeam();
  assert.deepEqual(api(canned, "GetNumArenaTeamMembers", 1, 1), [0]);
  canned.pvpWorld.setArenaTeam(1, {
    info: { teamId: 12, name: "Команда", type: 2, backgroundColor: 0, emblemStyle: 0, emblemColor: 0, borderStyle: 0, borderColor: 0 },
    stats: { teamId: 12, rating: 1500, weekGames: 0, weekWins: 0, seasonGames: 0, seasonWins: 0, rank: 1 },
    captain: true,
    roster: { teamId: 12, type: 2, members: [member(0x42n, "Тест", { captain: true })] },
  });
  assert.equal(api(canned, "GetArenaTeam", 1)[0], "Команда");
  assert.deepEqual(api(canned, "IsArenaTeamCaptain", 1), [1]);
  assert.equal(api(canned, "GetArenaTeamRosterInfo", 1, 1)[0], "Тест");
  api(canned, "ArenaTeamRoster", 1);
  assert.deepEqual(canned.pvpWorld.rosterRequests, [12]);

  const self = { guid: 7n, typeId: 4, fields: new Map([[SLOT_BASE, 31]]) };
  const sent = [];
  const world = {
    state: { selfGuid: 7n, objects: new Map([[7n, self]]) },
    arenaTeamRosters: new Map(),
    requestArenaTeamRoster: (teamId) => { sent.push(teamId); },
  };
  const live = new LiveWorldSeam({ world: () => world, store: () => undefined, monotonic: () => 5 });
  api(live, "ArenaTeamRoster", 1);
  assert.deepEqual(sent, [31]);
  assert.deepEqual(api(live, "IsArenaTeamCaptain", 1), [1]);
});
}

// ── framexml-arena-seam.test.mjs
{
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js",
);

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

function arenaList(guid = 0x1234n, fromWhere = 0, bgTypeId = 6) {
  return {
    battlemasterGuid: guid,
    fromWhere,
    bgTypeId,
    hasWin: false,
    winHonor: 0,
    winArena: 0,
    lossHonor: 0,
    random: false,
    randomHasWin: false,
    randomWinHonor: 0,
    randomWinArena: 0,
    randomLossHonor: 0,
    instances: [],
  };
}

class FakeEvents {
  #listeners = new Map();

  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }

  emit(name, payload = {}) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

function liveWorld(list = undefined, guid = 0x10n) {
  return {
    state: { selfGuid: guid, objects: new Map() },
    battlefieldQueues: new Map(),
    battlefieldList: list,
    worldStates: new Map([[3191, 7]]),
    group: undefined,
    casts: new Map(),
    cooldownSnapshots: new Map(),
    actionButtons: [],
    events: new FakeEvents(),
    channels: new Map(),
    joins: [],
    joinArena(...args) { this.joins.push(args); },
    onGroupChanged: undefined,
  };
}

function pumpFor(seam, events) {
  seam.attach({
    now: () => 1,
    fire(event, ...args) {
      events.push([event, ...args]);
      return 1;
    },
  });
  events.length = 0;
}

test("Canned Arena context transitions are authoritative and deduplicated", () => {
  const seam = new CannedWorldSeam();
  const events = [];
  let closeContextWasArena = false;
  seam.attach({
    now: () => 1,
    fire(event, ...args) {
      events.push([event, ...args]);
      if (event === FRAMEXML_SEAM_EVENTS.arenaClose) closeContextWasArena = seam.isBattlefieldArena();
      return 1;
    },
  });
  events.length = 0;

  const fresh = arenaList();
  seam.setBattlefieldList(fresh);
  seam.setBattlefieldList({ ...fresh, battlemasterGuid: 0x1235n });
  assert.equal(seam.isBattlefieldArena(), true);
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 1,
    "none -> arena emits one stock SHOW");
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length, 0,
    "arena refresh does not emit CLOSE");

  seam.setBattlefieldList({ ...fresh, fromWhere: 1 });
  assert.equal(closeContextWasArena, true, "CLOSE is delivered while old arena context is valid");
  assert.equal(seam.isBattlefieldArena(), false, "queue-originated list is not an arena context");
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length, 1,
    "arena -> queue emits exactly one CLOSE");
  seam.setBattlefieldList({ ...fresh, battlemasterGuid: 0n });
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 1,
    "non-arena lists never resurrect the owner");
  seam.setBattlefieldList({ ...fresh, bgTypeId: 5 });
  assert.equal(seam.isBattlefieldArena(), false, "a non-arena bgTypeId stays neutral");

  seam.setArenaSeason(7);
  seam.setPartyLeader(true);
  seam.setBattlefieldList(fresh);
  assert.equal(api(seam, "IsBattlefieldArena")[0], true);
  assert.equal(api(seam, "GetCurrentArenaSeason")[0], 7);
  assert.equal(api(seam, "CanJoinBattlefieldAsGroup")[0], true,
    "stock C API reports queue capability; Lua applies leader gating separately");
  api(seam, "JoinBattlefield", 1, true, true);
  api(seam, "JoinBattlefield", 2, true);
  api(seam, "JoinBattlefield", 3);
  assert.deepEqual(seam.arenaJoins.map((join) => ({
    guid: join.battlemasterGuid.toString(), slot: join.arenaSlot, group: join.asGroup, rated: join.rated,
  })), [
    { guid: "4660", slot: 0, group: true, rated: true },
    { guid: "4660", slot: 1, group: true, rated: false },
    { guid: "4660", slot: 2, group: false, rated: false },
  ]);
  seam.setPartyLeader(false);
  api(seam, "JoinBattlefield", 1, true, true);
  assert.equal(seam.arenaJoins.length, 3, "rated/group join rejects a non-leader");
  seam.setArenaSeason(0);
  seam.setPartyLeader(true);
  api(seam, "JoinBattlefield", 1, true, true);
  assert.equal(seam.arenaJoins.length, 3, "rated join rejects NO_ARENA_SEASON");
  // The existing PVPBattlegroundFrame has a distinct zero-selection shape. It
  // must keep joining battlegrounds even if an arena list is still current;
  // only a stale 1-based arena-shaped call is rejected.
  api(seam, "RequestBattlegroundInstanceInfo", 7);
  api(seam, "JoinBattlefield", 0, true);
  // 3.24: Wow.exe's join (0x0054cc70) carries the battlemaster guid it still holds (0x00bea568, cleared
  // only by CloseBattlefield), with the requested type and «first available».
  assert.deepEqual(seam.battlegroundJoins.at(-1), {
    bgTypeId: 32, instanceId: 0, asGroup: true, guid: 0x1234n,
  });
  seam.setBattlefieldList({ ...fresh, fromWhere: 1 });
  const staleArenaJoinCount = seam.arenaJoins.length;
  api(seam, "JoinBattlefield", 1, false, false);
  assert.equal(seam.arenaJoins.length, staleArenaJoinCount,
    "a stale 1-based arena call stays neutral");
});

test("Live Arena context preserves packet identity, world identity and close/reattach freshness", () => {
  let world = liveWorld();
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    battlegroundCatalog: () => [],
  });
  const events = [];
  pumpFor(seam, events);
  const first = arenaList(0x55n);
  world.battlefieldList = first;
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(seam.isBattlefieldArena(), true);
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 1);

  world.battlefieldList = { ...first, battlemasterGuid: 0x56n };
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 1,
    "fresh arena refresh does not re-show an already published owner");

  let closeContextWasArena = false;
  const closeCountBeforeQueue = events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length;
  world.battlefieldList = { ...first, fromWhere: 1 };
  // The seam must dispatch CLOSE synchronously against the old list before it
  // installs the queue response, exactly as the stock outer gate requires.
  seam.detach();
  seam.attach({
    now: () => 1,
    fire(event, ...args) {
      events.push([event, ...args]);
      if (event === FRAMEXML_SEAM_EVENTS.arenaClose) closeContextWasArena = seam.isBattlefieldArena();
      return 1;
    },
  });
  // Reattach does not adopt the list that existed before the packet callback;
  // this branch intentionally proves the queue response cannot close/show a
  // stale owner. The currently published arena was reset by detach above.
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length, closeCountBeforeQueue,
    "queue response after reattach has no stale CLOSE");
  assert.equal(closeContextWasArena, false);

  // Re-establish a published arena and exercise the real arena -> queue edge.
  const publishedAgain = arenaList(0x57n);
  world.battlefieldList = publishedAgain;
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(seam.isBattlefieldArena(), true);
  world.battlefieldList = { ...publishedAgain, fromWhere: 1 };
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(closeContextWasArena, true, "live CLOSE sees old arena context");
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length, closeCountBeforeQueue + 1,
    "live arena -> queue emits one CLOSE");
  assert.equal(events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 2,
    "queue response never emits SHOW");

  // The event list above remains useful for counts; use a fresh pump to inspect synchronous CLOSE.
  closeContextWasArena = false;
  seam.detach();
  const closeEvents = [];
  seam.attach({
    now: () => 1,
    fire(event, ...args) {
      closeEvents.push([event, ...args]);
      if (event === FRAMEXML_SEAM_EVENTS.arenaClose) closeContextWasArena = seam.isBattlefieldArena();
      return 1;
    },
  });
  // Reattach intentionally does not adopt a stale pre-existing list. A new packet edge is required.
  assert.equal(seam.isBattlefieldArena(), false, "reattach does not publish a stale GUID/list");
  world.battlefieldList = { ...first, fromWhere: 1 };
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(closeEvents.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaClose).length, 0,
    "stale/queue list does not emit CLOSE without a currently published arena");
  assert.equal(closeContextWasArena, false);

  world = liveWorld(first, 0x22n);
  seam.detach();
  seam.attach({ now: () => 1, fire: (event, ...args) => {
    closeEvents.push([event, ...args]);
    return 1;
  } });
  assert.equal(seam.isBattlefieldArena(), false, "new world identity does not inherit stale publication");
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  assert.equal(seam.isBattlefieldArena(), true, "new world's fresh list is accepted");
  assert.equal(closeEvents.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.arenaShow).length, 1);

  world.group = {
    groupType: 0,
    members: [{ name: "mate", guid: 0x33n, online: true, status: 0, subGroup: 0, flags: 0, roles: 0 }],
    leaderGuid: 0x22n,
  };
  api(seam, "JoinBattlefield", 1, true, true);
  assert.deepEqual(world.joins, [[first.battlemasterGuid, 0, true, true]],
    "live rated group join delegates exact guid/slot/group/rated tuple");
  world.group.leaderGuid = 0x33n;
  api(seam, "JoinBattlefield", 1, true, true);
  assert.deepEqual(world.joins, [[first.battlemasterGuid, 0, true, true]],
    "live non-leader rated join is rejected");
  world.group = {
    groupType: 1,
    members: [{ name: "raid-mate", guid: 0x44n, online: true, status: 0, subGroup: 0, flags: 0, roles: 0 }],
    leaderGuid: 0x22n,
  };
  api(seam, "JoinBattlefield", 1, true, true);
  assert.equal(world.joins.length, 2, "a real raid leader may group-join rated arena");
  world.group.leaderGuid = 0x44n;
  api(seam, "JoinBattlefield", 1, true, true);
  assert.equal(world.joins.length, 2, "a non-leader raid member is rejected");
  const joinsBeforeQueue = [...world.joins];
  world.battlefieldList = { ...first, fromWhere: 1 };
  world.events.emit("BATTLEFIELD_LIST_CHANGED", { bgTypeId: 6 });
  api(seam, "JoinBattlefield", 1, false, false);
  assert.deepEqual(world.joins, joinsBeforeQueue,
    "queue-originated context cannot delegate an arena join");
  seam.detach();
});
}
