// Plan item 3.15: PVPFrame's arena team roster and team commands (FrameXmlArenaRoster.ts), with the
// original client's answers (Wow.exe 0x5a3600, 0x5a2930, 0x5a2fc0, 0x5a2b80/0x5a2f40, 0x5a2e80/0x5a2bd0,
// 0x60dc70, 0x5a3e10, 0x6cc980 → 0x5a28e0, 0x515cc0..0x516130).
import assert from "node:assert/strict";
import test from "node:test";

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
