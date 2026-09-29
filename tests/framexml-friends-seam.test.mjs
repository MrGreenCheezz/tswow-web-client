import assert from "node:assert/strict";
import test from "node:test";

// The stock FriendsFrame's C API (FrameXmlFriends.ts, FrameXmlGuild.ts, FrameXmlRaid.ts) over
// recording worlds, and the three WorldClient senders it added, against TrinityCore's handlers.
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");
const {
  FRAMEXML_FRIENDS_BINDINGS, FRAMEXML_FRIENDS_PRELUDE, FRAMEXML_WHO_CHAT_ROWS, FrameXmlFriendsModel,
  frameXmlSocialAreaLookup,
} = await import("../dist/code/browser/framexml/FrameXmlFriends.js");
const { FRAMEXML_GUILD_CONTROL_RIGHTS } = await import("../dist/code/browser/framexml/FrameXmlGuild.js");
const { createCannedFrameXmlFriends } = await import("../dist/code/browser/framexml/FrameXmlFriendsCanned.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES, FRAMEXML_SEAM_PRELUDE } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { installFrameXmlChatApi } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");

const FRIEND = 0x01;
const IGNORED = 0x02;

function pump() {
  const fired = [];
  return { fired, fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 };
}

function socialWorld(extra = {}) {
  const calls = [];
  const names = new Map([[1n, "Игрок"], [2n, "Яна"], [3n, "Борис"], [4n, "Анна"], [5n, "Злой"], [6n, "Вера"],
    [7n, "Бо"], [8n, "Ас"], [9n, "Вик"]]);
  const world = {
    calls,
    events: new EventBus(),
    state: { selfGuid: 1n },
    contacts: {
      flags: 7,
      contacts: [
        { guid: 2n, flags: FRIEND, note: "", status: 0, areaId: 0, level: 0, classId: 0 },
        { guid: 3n, flags: FRIEND | IGNORED, note: "друг", status: 1 | 2, areaId: 12, level: 70, classId: 8 },
        { guid: 4n, flags: FRIEND, note: "", status: 1, areaId: 1519, level: 80, classId: 1 },
        { guid: 5n, flags: IGNORED, note: "", status: 0, areaId: 0, level: 0, classId: 0 },
      ],
    },
    whoResult: undefined,
    displayName: (guid) => names.get(guid) ?? `0x${guid.toString(16)}`,
    requestName: (guid) => calls.push(["name", guid]),
    requestContacts: (flags) => calls.push(["contacts", flags]),
    setFriendNote: (guid, note) => calls.push(["note", guid, note]),
    requestGuildRoster: () => calls.push(["roster"]),
    requestGuildEventLog: () => calls.push(["log"]),
    setGuildMemberNote: (name, note, officer) => calls.push(["memberNote", name, note, officer]),
    setGuildInfoText: (text) => calls.push(["info", text]),
    setGuildRank: (...args) => calls.push(["rank", ...args]),
    addGuildRank: (name) => calls.push(["addRank", name]),
    removeLowestGuildRank: () => calls.push(["delRank"]),
    convertToRaid: () => calls.push(["convert"]),
    requestRaidInfo: () => calls.push(["raidInfo"]),
    setSavedInstanceExtend: (...args) => calls.push(["extend", ...args]),
    ...extra,
  };
  return world;
}

function model(world, extra = {}) {
  let clock = 0;
  const context = {
    world: () => world,
    playerGuid: () => 1n,
    playerName: () => "Игрок",
    areaName: (id) => ({ 12: "Элвиннский лес", 1519: "Штормград", 1537: "Стальгорн" })[id],
    classInfo: (id) => ({ 1: ["Воин", "WARRIOR"], 8: ["Маг", "MAGE"], 5: ["Жрец", "PRIEST"] })[id],
    raceName: (id) => ({ 1: "Человек", 3: "Дворф" })[id],
    unitGuild: (unit) => ({ player: world.guild, target: world.targetGuild })[unit],
    mapInfo: (id) => ({ 533: { name: "Наксрамас", instanceType: 2 }, 574: { name: "Крепость Утгард", instanceType: 1 } })[id],
    memberFacts: () => ({ level: 80, classId: 8, areaId: 12, dead: false }),
    monotonic: () => clock,
    ...extra,
  };
  const friends = new FrameXmlFriendsModel(context);
  return { friends, advance: (ms) => { clock += ms; } };
}

const host = (friends) => ({ friends });
const call = (friends, name, ...args) => FRAMEXML_FRIENDS_BINDINGS[name](host(friends), args);

test("friends are online first by name; GetFriendInfo takes an index or a name; status is a code the prelude words", () => {
  const world = socialWorld();
  const { friends } = model(world);
  assert.deepEqual(call(friends, "GetNumFriends"), [3, 2]);
  assert.deepEqual(call(friends, "WebClientFriendInfo", 1), ["Анна", 80, "Воин", "Штормград", true, 0, undefined]);
  assert.deepEqual(call(friends, "WebClientFriendInfo", 2), ["Борис", 70, "Маг", "Элвиннский лес", true, 1, "друг"],
    "AFK is code 1; a non-empty note is the note");
  assert.deepEqual(call(friends, "WebClientFriendInfo", 3), ["Яна", 0, "", "", false, 0, undefined],
    "an offline friend carries no level, class or zone on the wire");
  assert.deepEqual(call(friends, "WebClientFriendInfo", "борис")[0], "Борис", "a name, case-insensitively");
  assert.deepEqual(call(friends, "WebClientFriendInfo", "3")[0], "Яна", "a numeric string is an index");
  assert.deepEqual(call(friends, "WebClientFriendInfo", 9), []);
  assert.match(FRAMEXML_FRIENDS_PRELUDE, /impl\.GetFriendInfo = function\(key\)/);
  assert.match(FRAMEXML_FRIENDS_PRELUDE, /if code == 1 then return CHAT_FLAG_AFK/);
  assert.ok(FRAMEXML_SEAM_PRELUDE.includes(FRAMEXML_FRIENDS_PRELUDE), "the seam prelude carries the social half");
  call(friends, "SetSelectedFriend", 2);
  assert.deepEqual(call(friends, "GetSelectedFriend"), [2]);
  // The selection follows its friend when Анна goes offline and the order moves.
  world.contacts.contacts[2].status = 0;
  assert.deepEqual(call(friends, "GetSelectedFriend"), [1], "Борис is now the only one online");
  assert.deepEqual(call(friends, "GetNumIgnores"), [2]);
  assert.deepEqual([call(friends, "GetIgnoreName", 1), call(friends, "GetIgnoreName", 2)], [["Борис"], ["Злой"]],
    "a contact that is both friend and ignored is in both lists");
});

test("SetFriendNotes sends CMSG_SET_CONTACT_NOTES by index or name and repaints; a muted probe sends nothing", () => {
  const world = socialWorld();
  const { friends } = model(world);
  const events = pump();
  friends.attach(events);
  call(friends, "SetFriendNotes", 1, "танк");
  call(friends, "SetFriendNotes", "Яна", "x".repeat(60));
  assert.deepEqual(world.calls.filter(([kind]) => kind === "note"), [["note", 4n, "танк"], ["note", 2n, "x".repeat(48)]],
    "TrinityCore keeps 48 characters");
  assert.equal(world.contacts.contacts[2].note, "танк");
  assert.deepEqual(events.fired, [["FRIENDLIST_UPDATE"], ["FRIENDLIST_UPDATE"]]);
  friends.muted(() => { call(friends, "SetFriendNotes", 1, "нет"); call(friends, "ShowFriends"); });
  assert.equal(world.calls.filter(([kind]) => kind === "note" || kind === "contacts").length, 2);
  call(friends, "ShowFriends");
  assert.deepEqual(world.calls.at(-1), ["contacts", 7]);
});

test("contact packets: a new list announces both lists, a folded status only the list it touched", () => {
  const world = socialWorld();
  const { friends } = model(world);
  const events = pump();
  friends.attach(events);
  world.contacts = { ...world.contacts, contacts: world.contacts.contacts.map((contact) => ({ ...contact })) };
  world.events.emit("CONTACTS_CHANGED", {});
  assert.deepEqual(events.fired, [["FRIENDLIST_UPDATE"], ["IGNORELIST_UPDATE"]],
    "SMSG_CONTACT_LIST answers ShowFriends even when nothing changed");
  events.fired.length = 0;
  world.contacts.contacts[0].status = 1;
  world.events.emit("CONTACTS_CHANGED", {});
  assert.deepEqual(events.fired, [["FRIENDLIST_UPDATE"]]);
  events.fired.length = 0;
  world.contacts.contacts[3].flags = 0;
  world.events.emit("CONTACTS_CHANGED", {});
  assert.deepEqual(events.fired, [["IGNORELIST_UPDATE"]]);
  events.fired.length = 0;
  world.events.emit("CONTACTS_CHANGED", {});
  assert.deepEqual(events.fired, [], "an unchanged fold is quiet");
  friends.detach();
  world.contacts.contacts[0].status = 0;
  world.events.emit("CONTACTS_CHANGED", {});
  assert.deepEqual(events.fired, [], "detached: the bus subscription is gone");
});

test("a /who answer reaches stock only while owned: the open tab or a long answer, else chat; WHOIS is ignored", () => {
  const world = socialWorld();
  const { friends } = model(world);
  const events = pump();
  friends.attach(events);
  const answer = (count) => {
    world.whoResult = { displayed: count, matched: count + 5, entries: Array.from({ length: count }, (_, index) => ({
      name: `Игрок${index}`, guild: index % 2 ? "Гильдия" : "", level: 70 + index, classId: 8, race: 1, gender: 0, zoneId: 12,
    })) };
    world.events.emit("WHO_RESULTS", {});
  };
  answer(2);
  assert.deepEqual(events.fired, [], "unowned: the native social panel answers /who");
  friends.owned = true;
  answer(FRAMEXML_WHO_CHAT_ROWS);
  answer(FRAMEXML_WHO_CHAT_ROWS + 1);
  world.events.emit("WHO_RESULTS", {});
  call(friends, "SetWhoToUI", 1);
  answer(1);
  call(friends, "SetWhoToUI", 0);
  assert.deepEqual(events.fired, [["WEBCLIENT_WHO_TO_CHAT"], ["WHO_LIST_UPDATE"], ["WHO_LIST_UPDATE"]],
    "three rows go to chat, four open the tab, SMSG_WHOIS (same list) is silent, SetWhoToUI(1) takes one row");
  answer(4);
  assert.deepEqual(call(friends, "GetNumWhoResults"), [4, 9], "shown rows and the server's match count");
  assert.deepEqual(call(friends, "GetWhoInfo", 2), ["Игрок1", "Гильдия", 71, "Человек", "Маг", "Элвиннский лес", "MAGE"]);
  events.fired.length = 0;
  call(friends, "SortWho", "level");
  call(friends, "SortWho", "level");
  assert.deepEqual(call(friends, "GetWhoInfo", 1)[0], "Игрок3", "the same column twice sorts descending");
  call(friends, "SortWho", "name");
  assert.deepEqual(call(friends, "GetWhoInfo", 1)[0], "Игрок0");
  assert.deepEqual(events.fired, [["WHO_LIST_UPDATE"], ["WHO_LIST_UPDATE"], ["WHO_LIST_UPDATE"]]);
});

test("one owner per name: the chat API keeps its social commands, the seam carries the rest and Battle.net is off", () => {
  for (const name of ["AddFriend", "RemoveFriend", "AddOrRemoveFriend", "AddIgnore", "DelIgnore", "AddOrDelIgnore",
    "SendWho", "InviteUnit", "GuildInvite", "GuildUninvite", "GuildPromote", "GuildDemote", "GuildSetMOTD", "GuildLeave",
    "GuildInfo", "GuildSetLeader", "GetNumRaidMembers"]) {
    assert.equal(Object.hasOwn(FRAMEXML_FRIENDS_BINDINGS, name), false, `${name} keeps its existing owner`);
  }
  for (const [name, binding] of Object.entries(FRAMEXML_FRIENDS_BINDINGS)) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], binding, `${name} is the seam's binding, not shadowed by a later key`);
  }
  const globals = new Map();
  const result = installFrameXmlChatApi({
    registerGlobal: (name, binding) => globals.set(name, binding),
    execute: () => ({ ok: true }),
  }, { world: () => undefined, notice() {}, cast() {}, use() {}, unitGuid: () => undefined });
  const seamNames = new Set(FRAMEXML_SEAM_NAMES);
  for (const name of ["AddFriend", "RemoveFriend", "AddIgnore", "DelIgnore", "SendWho", "GuildPromote"]) {
    assert.ok(result.installed.includes(name), `the chat API still binds ${name}`);
  }
  for (const name of result.installed) assert.equal(seamNames.has(name), false, `${name} is bound once`);
  const { friends } = model(socialWorld());
  assert.deepEqual(call(friends, "BNFeaturesEnabled"), [false]);
  assert.deepEqual(call(friends, "BNGetNumFriends"), [0, 0]);
  assert.deepEqual(call(friends, "BNGetFriendInfo", 1), []);
  assert.deepEqual(call(friends, "IsReferAFriendLinked", "Анна"), [false]);
  assert.deepEqual(call({}.friends, "GetNumFriends"), [], "no model answers nothing");
});

function guildWorld() {
  const member = (guid, name, rankId, online, extra = {}) => ({ guid, status: online ? 1 : 0, online, name, rankId,
    level: 80, classId: 8, gender: 0, areaId: 12, lastSaveDays: 0, note: "", officerNote: "", ...extra });
  return socialWorld({
    guild: { guildId: 9, rankId: 1 },
    targetGuild: { guildId: 9, rankId: 3 },
    guildQuery: { guildId: 9, name: "Щит", rankNames: ["Глава", "Офицер", "Ветеран", "Член", "Новичок", "", "", "", "", ""],
      emblemStyle: 0, emblemColor: 0, borderStyle: 0, borderColor: 0, backgroundColor: 0, rankCount: 5 },
    guildRoster: {
      welcomeText: "Привет", infoText: "О нас",
      ranks: [
        { flags: 0x001df1ff, withdrawGoldLimit: 0xffffffff, tabs: Array.from({ length: 6 }, () => ({ rights: 0xff, slots: 1000 })) },
        { flags: 0x00000040 | 0x3 | 0x10 | 0x80 | 0x1000 | 0x2000 | 0x4000, withdrawGoldLimit: 250 * 10000,
          tabs: Array.from({ length: 6 }, (_, tab) => ({ rights: tab === 0 ? 0x07 : 0, slots: 20 })) },
        { flags: 0x43, withdrawGoldLimit: 0, tabs: Array.from({ length: 6 }, () => ({ rights: 0, slots: 0 })) },
      ],
      members: [
        member(1n, "Игрок", 1, true),
        member(7n, "Бо", 2, false, { lastSaveDays: 400.5, note: "b" }),
        member(8n, "Ас", 2, true, { status: 1 | 2, level: 70 }),
        member(9n, "Вик", 0, false, { lastSaveDays: 0.25 }),
      ],
    },
    guildEventLog: [
      { type: 1, playerGuid: 1n, otherGuid: 8n, rankId: 0, secondsAgo: 90000 },
      { type: 3, playerGuid: 1n, otherGuid: 7n, rankId: 2, secondsAgo: 400 * 86400 },
      { type: 9, playerGuid: 1n, otherGuid: 0n, rankId: 0, secondsAgo: 5 },
    ],
  });
}

test("guild: membership, GetGuildInfo, rank rights, sort and filter with a selection that follows its member", () => {
  const world = guildWorld();
  const { friends, advance } = model(world);
  assert.deepEqual(call(friends, "IsInGuild"), [true]);
  assert.deepEqual(call(friends, "GetGuildInfo", "player"), ["Щит", "Офицер", 1]);
  assert.deepEqual(call(friends, "GetGuildInfo", "target"), ["Щит", "Член", 3], "a visible guildmate");
  world.targetGuild = { guildId: 4, rankId: 0 };
  assert.deepEqual(call(friends, "GetGuildInfo", "target"), [], "another guild's name is not known to the client");
  for (const [name, expected] of [["CanGuildInvite", true], ["CanGuildRemove", false], ["CanGuildPromote", true],
    ["CanGuildDemote", false], ["CanEditMOTD", true], ["CanEditPublicNote", true], ["CanViewOfficerNote", true],
    ["CanEditOfficerNote", false], ["CanEditGuildInfo", false], ["IsGuildLeader", false]]) {
    assert.deepEqual(call(friends, name), [expected], name);
  }
  assert.deepEqual(call(friends, "GetNumGuildMembers"), [4]);
  assert.deepEqual([1, 2, 3, 4].map((index) => call(friends, "WebClientGuildRosterInfo", index)[0]), ["Ас", "Бо", "Вик", "Игрок"]);
  assert.deepEqual(call(friends, "WebClientGuildRosterInfo", 1), ["Ас", "Ветеран", 2, 70, "Маг", "Элвиннский лес", "", "", true, 1, "MAGE"],
    "status bits 1|AFK answer code 1");
  call(friends, "SetGuildRosterSelection", 4);
  call(friends, "SortGuildRoster", "online");
  assert.deepEqual(call(friends, "GetGuildRosterSelection"), [2], "Игрок follows to row 2: online, after Ас by name");
  assert.deepEqual(call(friends, "WebClientGuildRosterInfo", 3)[0], "Вик", "offline by time since logout");
  call(friends, "SetGuildRosterShowOffline", undefined);
  assert.deepEqual(call(friends, "GetNumGuildMembers"), [2]);
  assert.deepEqual(call(friends, "GetNumGuildMembers", true), [4], "includeOffline still counts everyone");
  call(friends, "SetGuildRosterShowOffline", 1);
  assert.deepEqual(call(friends, "GetGuildRosterLastOnline", 4), [1, 1, 5, 12], "400.5 days: 1 year, 1 month, 5 days, 12 hours");
  assert.deepEqual(call(friends, "GetGuildRosterLastOnline", 1), [], "an online member has no last-online");
  assert.deepEqual([call(friends, "GetGuildRosterMOTD"), call(friends, "GetGuildInfoText")], [["Привет"], ["О нас"]]);
  call(friends, "GuildRosterSetPublicNote", 4, "нота");
  call(friends, "GuildRosterSetOfficerNote", 4, "оф");
  call(friends, "SetGuildInfoText", "текст");
  call(friends, "GuildRoster");
  call(friends, "GuildRoster");
  advance(10_000);
  call(friends, "GuildRoster");
  assert.deepEqual(world.calls, [["memberNote", "Бо", "нота", false], ["memberNote", "Бо", "оф", true], ["info", "текст"],
    ["roster"], ["roster"]], "one GuildRoster request in flight; a lost answer is re-asked after 10 s");
  assert.deepEqual(call(friends, "GetNumGuildEvents"), [3]);
  assert.deepEqual(call(friends, "GetGuildEventInfo", 1), ["invite", "Игрок", "Ас", undefined, 0, 0, 1, 1]);
  assert.deepEqual(call(friends, "GetGuildEventInfo", 2), ["promote", "Игрок", "Бо", "Ветеран", 1, 1, 5, 0]);
  assert.deepEqual(call(friends, "GetGuildEventInfo", 3), [], "an unknown event type is not invented");
  world.guild = undefined;
  world.guildRoster = undefined;
  assert.deepEqual(call(friends, "IsInGuild"), [false]);
  assert.deepEqual(call(friends, "GetGuildInfo", "player"), []);
});

test("guild edges on the poll: roster and query → GUILD_ROSTER_UPDATE, a new MOTD → GUILD_MOTD, membership → PLAYER_GUILD_UPDATE", () => {
  const world = guildWorld();
  const { friends } = model(world);
  const events = pump();
  friends.attach(events);
  friends.tick();
  assert.deepEqual(events.fired, [], "what the world held at attach is the starting state");
  world.guildRoster = { ...world.guildRoster };
  friends.tick();
  assert.deepEqual(events.fired, [["GUILD_ROSTER_UPDATE"]], "a roster packet, announced with arg1 nil");
  events.fired.length = 0;
  world.guildRoster = { ...world.guildRoster, welcomeText: "Рейд в 20:00" };
  friends.tick();
  assert.deepEqual(events.fired, [["GUILD_MOTD", "Рейд в 20:00"], ["GUILD_ROSTER_UPDATE"]]);
  events.fired.length = 0;
  world.guildEventLog = [...world.guildEventLog];
  friends.tick();
  assert.deepEqual(events.fired, [["GUILD_EVENT_LOG_UPDATE"]]);
  events.fired.length = 0;
  world.guild = { guildId: 9, rankId: 0 };
  friends.tick();
  assert.deepEqual(events.fired, [["PLAYER_GUILD_UPDATE", "player"]], "a promotion changes PLAYER_GUILDRANK");
  events.fired.length = 0;
  world.guild = undefined;
  world.guildRoster = undefined;
  friends.tick();
  assert.deepEqual(events.fired, [["PLAYER_GUILD_UPDATE", "player"], ["GUILD_ROSTER_UPDATE"], ["GUILD_EVENT_LOG_UPDATE"]],
    "leaving the guild: its roster and its event log are gone with it");
});

test("the rank editor: checkbox rights by label, gold in gold, vault tab bits, CMSG_GUILD_RANK with the whole row", () => {
  assert.equal(FRAMEXML_GUILD_CONTROL_RIGHTS.length, 17);
  const world = guildWorld();
  world.guild = { guildId: 9, rankId: 0 };
  world.guildPermissions = { purchasedTabs: 2 };
  const { friends } = model(world);
  assert.deepEqual(call(friends, "GuildControlGetNumRanks"), [3]);
  assert.deepEqual(call(friends, "GuildControlGetRankName", 1), ["Глава"]);
  call(friends, "GuildControlSetRank", 2);
  const flags = call(friends, "GuildControlGetRankFlags");
  assert.deepEqual(flags.map((flag, index) => (flag ? index + 1 : 0)).filter(Boolean), [1, 2, 5, 7, 9, 10, 11],
    "listen, speak, promote (0x80), invite (0x10), MOTD, public note, view officer note");
  assert.deepEqual(call(friends, "GetGuildBankWithdrawLimit"), [250]);
  assert.deepEqual(call(friends, "GetNumGuildBankTabs"), [2]);
  assert.deepEqual(call(friends, "GetGuildBankTabPermissions", 1), [true, true, true, 20]);
  call(friends, "GuildControlSetRankFlag", 6, 1);
  call(friends, "GuildControlSetRankFlag", 5, undefined);
  call(friends, "SetGuildBankWithdrawLimit", "75");
  call(friends, "SetGuildBankTabPermissions", 1, 2, 0);
  call(friends, "SetGuildBankTabWithdraw", 2, "15");
  call(friends, "GuildControlSaveRank", " Офицеры ");
  const [kind, rankId, savedFlags, name, gold, tabs] = world.calls.at(-1);
  assert.equal(kind, "rank");
  assert.deepEqual([rankId, name, gold], [1, "Офицеры", 75 * 10000]);
  assert.equal(savedFlags & 0x100, 0x100, "demote added");
  assert.equal(savedFlags & 0x80, 0, "promote removed");
  assert.equal(savedFlags & 0x40, 0x40, "GR_RIGHT_EMPTY kept");
  assert.equal(savedFlags & 0x4000, 0x4000, "untouched rights kept");
  assert.deepEqual(tabs.slice(0, 2), [{ rights: 0x05, slots: 20 }, { rights: 0, slots: 15 }]);
  assert.equal(tabs.length, 6);
  call(friends, "GuildControlSetRank", 1);
  assert.deepEqual(call(friends, "GetGuildBankWithdrawLimit"), [-1], "the guild master's unlimited allowance");
  assert.ok(call(friends, "GuildControlGetRankFlags").every(Boolean), "the guild master holds every right");
  call(friends, "GuildControlAddRank", "Гость");
  call(friends, "GuildControlDelRank", "Новичок");
  assert.deepEqual(world.calls.slice(-2), [["addRank", "Гость"], ["delRank"]]);
  friends.muted(() => call(friends, "GuildControlSaveRank", "x"));
  assert.deepEqual(world.calls.at(-1), ["delRank"], "a muted probe sends no rank");
});

test("raid: the listed members in wire order then the player, ranks and roles, lockouts split into stock's halves, and the poll's edges", () => {
  const world = socialWorld({
    group: { groupType: 0x02, ownSubGroup: 1, ownFlags: 0x01, ownRoles: 0, guid: 1n, counter: 1, leaderGuid: 2n,
      lootMethod: 2, masterLooterGuid: 3n, lootThreshold: 2, dungeonDifficulty: 0, raidDifficulty: 1,
      members: [
        { name: "Яна", guid: 2n, online: true, status: 1, subGroup: 0, flags: 0x02, roles: 0 },
        { name: "Борис", guid: 3n, online: false, status: 0, subGroup: 2, flags: 0x04, roles: 0 },
      ] },
    lockouts: [{ mapId: 533, difficulty: 1, instanceId: 0x0000000200000011n, active: true, extended: false, secondsUntilReset: 100 }],
  });
  const { friends } = model(world);
  assert.deepEqual(call(friends, "GetRaidRosterInfo", 1).slice(0, 3), ["Яна", 2, 1], "raid1 is the first listed member");
  assert.deepEqual(call(friends, "GetRaidRosterInfo", 1)[9], "MAINTANK");
  assert.deepEqual(call(friends, "GetRaidRosterInfo", 2).slice(7), [false, false, "MAINASSIST", true]);
  assert.deepEqual(call(friends, "GetRaidRosterInfo", 3), ["Игрок", 1, 2, 80, "Маг", "MAGE", "Элвиннский лес", true, false, undefined, false],
    "the player, whom SMSG_GROUP_LIST does not list, is the row after the listed members");
  assert.deepEqual(call(friends, "GetRaidRosterInfo", 4), []);
  assert.deepEqual([call(friends, "IsRaidLeader"), call(friends, "IsRaidOfficer")], [[false], [true]]);
  assert.deepEqual(call(friends, "WebClientSavedInstanceInfo", 1), ["Наксрамас", 0x11, 100, 1, true, false, 2, true, 25]);
  assert.match(FRAMEXML_FRIENDS_PRELUDE, /_G\["RAID_DIFFICULTY" \.\. \(difficulty \+ 1\)\]/);
  call(friends, "SetSavedInstanceExtend", 1, 1);
  call(friends, "RequestRaidInfo");
  call(friends, "ConvertToRaid");
  assert.deepEqual(world.calls, [["extend", 533, 1, true], ["raidInfo"], ["convert"]]);
  const events = pump();
  friends.attach(events);
  friends.tick();
  world.group = { ...world.group, members: [world.group.members[0]] };
  world.lockouts = [];
  friends.tick();
  friends.tick();
  world.group = undefined;
  friends.tick();
  assert.deepEqual(events.fired, [["RAID_ROSTER_UPDATE"], ["UPDATE_INSTANCE_INFO"], ["RAID_ROSTER_UPDATE"]],
    "one edge per roster change, one when the raid ends, one per lockout list");
  assert.deepEqual(call(friends, "GetRaidRosterInfo", 1), [], "not in a raid");
});

test("the canned social world answers like TrinityCore: ShowFriends and GuildRoster get a fresh packet a microtask later", async () => {
  const { model: friends, world } = createCannedFrameXmlFriends();
  const events = pump();
  friends.attach(events);
  call(friends, "ShowFriends");
  friends.guild.requestRoster();
  assert.deepEqual(events.fired, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
  friends.tick();
  assert.deepEqual(events.fired, [["FRIENDLIST_UPDATE"], ["IGNORELIST_UPDATE"], ["GUILD_ROSTER_UPDATE"]]);
  assert.deepEqual(world.calls.map((entry) => entry.kind), ["contacts", "roster"]);
  const lookup = frameXmlSocialAreaLookup(() => ({ areas: [{ id: 12, name: "Элвиннский лес" }], maps: [{ id: 533, name: "Наксрамас", instanceType: 2 }] }));
  assert.equal(lookup.areaName(12), "Элвиннский лес");
  assert.equal(lookup.areaName(0), undefined, "area 0 is no area");
  assert.deepEqual(lookup.mapInfo(533), { id: 533, name: "Наксрамас", instanceType: 2 });
});

// ---- WorldClient senders, against TrinityCore's handlers -----------------------------------

function connection() {
  const packets = [];
  const sent = [];
  let resume;
  return {
    sent,
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); },
    close() {},
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (resume) { const wake = resume; resume = undefined; wake(packet); } else packets.push(packet);
    },
    read() {
      if (packets.length) return Promise.resolve(packets.shift());
      return new Promise((resolve) => { resume = resolve; });
    },
  };
}

async function settle() {
  for (let pass = 0; pass < 6; pass++) await new Promise((resolve) => setImmediate(resolve));
}

test("WorldClient: CMSG_SET_CONTACT_NOTES, CMSG_REQUEST_RAID_INFO and CMSG_SET_SAVED_INSTANCE_EXTEND on the wire", async () => {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(transport);
  await client.loginCharacter(0x1234n);
  await settle();
  transport.push(OPCODES.SMSG_CONTACT_LIST, new PacketWriter().u32(7).u32(1)
    .u64(0x5678n).u32(FRIEND).cString("").u8(0).toUint8Array());
  await settle();
  transport.sent.length = 0;
  client.setFriendNote(0x5678n, "заметка");
  client.requestRaidInfo();
  client.setSavedInstanceExtend(533, 1, true);
  const [note, raid, extend] = transport.sent;
  assert.equal(note.opcode, OPCODES.CMSG_SET_CONTACT_NOTES);
  const noteReader = new PacketReader(note.payload);
  assert.deepEqual([noteReader.u64(), noteReader.cString()], [0x5678n, "заметка"], "HandleSetContactNotesOpcode: guid >> note");
  noteReader.assertFinished();
  assert.equal(client.contacts.contacts[0].note, "заметка", "the held list changes at once; TrinityCore answers nothing");
  assert.equal(raid.opcode, OPCODES.CMSG_REQUEST_RAID_INFO);
  assert.equal(raid.payload.length, 0);
  assert.equal(extend.opcode, OPCODES.CMSG_SET_SAVED_INSTANCE_EXTEND);
  const extendReader = new PacketReader(extend.payload);
  assert.deepEqual([extendReader.i32(), extendReader.u32(), extendReader.u8()], [533, 1, 1],
    "SetSavedInstanceExtend::Read: MapID, DifficultyID, Extend");
  extendReader.assertFinished();
});

test("the Chat tab: joined channels in the world's order, a listed roster, selection asks the server, and its poll edges", () => {
  const world = socialWorld({
    channels: new Map([
      ["Общий - Элвиннский лес", { flags: 0x18, count: 0, members: [] }],
      ["стражи", { flags: 0x01, count: 2, members: [{ guid: 3n, flags: 0x02 }, { guid: 1n, flags: 0x01 | 0x08 }] }],
    ]),
    requestChannelList: (name) => world.calls.push(["channelList", name]),
  });
  const { friends } = model(world);
  const events = pump();
  friends.attach(events);
  assert.deepEqual(call(friends, "GetNumDisplayChannels"), [2]);
  assert.deepEqual(call(friends, "GetChannelDisplayInfo", 1),
    ["Общий", undefined, undefined, 1, undefined, true, "CHANNEL_CATEGORY_WORLD", undefined, undefined],
    "the seam's short name; no roster listed yet, so no count");
  assert.deepEqual(call(friends, "GetChannelDisplayInfo", 2),
    ["стражи", undefined, undefined, 2, 2, true, "CHANNEL_CATEGORY_CUSTOM", undefined, undefined]);
  assert.deepEqual(call(friends, "GetSelectedDisplayChannel"), []);
  call(friends, "SetSelectedDisplayChannel", 2);
  assert.deepEqual(call(friends, "GetSelectedDisplayChannel"), [2]);
  assert.deepEqual(world.calls, [["channelList", "стражи"]], "selecting a row asks for its roster (CMSG_CHANNEL_LIST)");
  assert.deepEqual(call(friends, "GetChannelRosterInfo", 2, 1), ["Борис", false, true, false, undefined, undefined]);
  assert.deepEqual(call(friends, "GetChannelRosterInfo", 2, 2), ["Игрок", true, false, true, undefined, undefined]);
  assert.deepEqual([call(friends, "IsDisplayChannelOwner"), call(friends, "IsDisplayChannelModerator")], [[true], [false]]);
  assert.deepEqual(call(friends, "GetNumChannelMembers", 1), [0]);
  friends.muted(() => call(friends, "GetNumChannelMembers", 2));
  assert.deepEqual(world.calls.map(([, name]) => name), ["стражи", "Общий - Элвиннский лес"], "a muted probe asks nothing");
  friends.tick();
  assert.deepEqual(events.fired, [], "what the world held at attach is the starting state");
  world.channels.set("Торговля - Город", { flags: 0x18, count: 0, members: [] });
  friends.tick();
  world.channels.get("стражи").count = 5;
  friends.tick();
  world.channels.get("стражи").members = [{ guid: 3n, flags: 0 }];
  friends.tick();
  friends.tick();
  assert.deepEqual(events.fired, [["CHANNEL_UI_UPDATE"], ["CHANNEL_ROSTER_UPDATE", 2]],
    "a new channel is a list edge; a new roster array (SMSG_CHANNEL_LIST, SMSG_USERLIST_*) an edge with its row; a count packet is quiet");
  assert.deepEqual(call(friends, "GetChannelDisplayInfo", 9), []);
});

test("the friends and ignore lists are sorted once per change, not once per row a repaint reads", () => {
  const contacts = Array.from({ length: 50 }, (_, index) => ({
    guid: 500n + BigInt(index), flags: index < 40 ? FRIEND : IGNORED, note: "", status: index % 3 === 0 ? 0 : 1,
    areaId: 12, level: 80, classId: 1,
  }));
  const names = new Map(contacts.map((contact, index) => [contact.guid, `Друг${String(49 - index).padStart(2, "0")}`]));
  const world = socialWorld({ contacts: { flags: 7, contacts }, displayName: (guid) => names.get(guid) ?? `0x${guid.toString(16)}` });
  const { friends } = model(world);
  const compare = String.prototype.localeCompare;
  let compares = 0;
  String.prototype.localeCompare = function (...args) { compares += 1; return compare.apply(this, args); };
  try {
    const walk = () => {
      const rows = [];
      for (let index = 1; index <= 40; index += 1) rows.push(call(friends, "WebClientFriendInfo", index)[0]);
      for (let index = 1; index <= 10; index += 1) rows.push(call(friends, "GetIgnoreName", index)[0]);
      return rows;
    };
    const first = walk();
    const sorts = compares;
    assert.ok(sorts > 0 && sorts < 400, `one sort per list: ${sorts} comparisons`);
    assert.deepEqual(walk(), first);
    assert.equal(compares, sorts, "a second repaint with nothing changed sorts nothing");
    // A folded SMSG_FRIEND_STATUS changes a contact in place: the order follows at once.
    const offline = contacts.find((contact) => contact.status === 0 && (contact.flags & FRIEND) !== 0);
    offline.status = 1;
    assert.ok(walk().indexOf(names.get(offline.guid)) < first.indexOf(names.get(offline.guid)), "online now, so higher up");
    assert.ok(compares > sorts);
  } finally {
    String.prototype.localeCompare = compare;
  }
});

test("the Chat tab's roster is sorted once per roster packet; only the selected row repaints, and again when late names land", () => {
  const members = Array.from({ length: 200 }, (_, index) => ({ guid: 1000n + BigInt(index), flags: 0 }));
  const names = new Map(members.map((member, index) => [member.guid, `Игрок${String(199 - index).padStart(3, "0")}`]));
  names.delete(1199n);
  let lookups = 0;
  const world = socialWorld({
    channels: new Map([
      ["Общий - Элвиннский лес", { flags: 0x18, count: 0, members: [{ guid: 7n, flags: 0 }] }],
      ["мир", { flags: 0x01, count: 200, members }],
    ]),
    displayName: (guid) => { lookups += 1; return names.get(guid) ?? `0x${guid.toString(16)}`; },
    requestChannelList: () => {},
  });
  const { friends } = model(world);
  const events = pump();
  friends.attach(events);
  call(friends, "SetSelectedDisplayChannel", 2);
  lookups = 0;
  // ChannelRoster_Update's 22 rows (MAX_CHANNEL_MEMBER_BUTTONS), twice.
  for (let pass = 0; pass < 2; pass += 1) for (let row = 1; row <= 22; row += 1) call(friends, "GetChannelRosterInfo", 2, row);
  assert.equal(lookups, 200, "one sort of the 200-member roster serves every row of both repaints");
  assert.deepEqual(call(friends, "GetChannelRosterInfo", 2, 1)[0], "0x4af", "an unknown name sorts as its GUID until it lands");
  assert.deepEqual(call(friends, "GetChannelRosterInfo", 2, 2)[0], "Игрок001");
  assert.ok(world.calls.some(([kind, guid]) => kind === "name" && guid === 1199n), "and is asked for");
  // Another channel's roster packet does not repaint the selected row's pane.
  world.channels.get("Общий - Элвиннский лес").members = [{ guid: 7n, flags: 0 }, { guid: 6n, flags: 0 }];
  friends.tick();
  assert.deepEqual(events.fired, [], "ChannelRoster_Update(1) would draw channel 1 into the pane while row 2 is selected");
  // The missing name arrives: the selected pane repaints once, and re-sorts once.
  names.set(1199n, "Ярослав");
  friends.tick();
  friends.tick();
  assert.deepEqual(events.fired, [["CHANNEL_ROSTER_UPDATE", 2]]);
  lookups = 0;
  assert.deepEqual(call(friends, "GetChannelRosterInfo", 2, 200)[0], "Ярослав");
  assert.deepEqual(call(friends, "GetChannelRosterInfo", 2, 1)[0], "Игрок001");
  assert.equal(lookups, 200);
  // A new roster array for the selected channel is its edge, and the next read sorts it afresh.
  world.channels.get("мир").members = members.slice(0, 3);
  friends.tick();
  assert.deepEqual(events.fired.at(-1), ["CHANNEL_ROSTER_UPDATE", 2]);
  assert.deepEqual(call(friends, "GetChannelRosterInfo", 2, 4), []);
});
