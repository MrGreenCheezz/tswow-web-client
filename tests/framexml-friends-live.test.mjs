import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

// The social C API through the live seam (LiveWorldSeam.ts): the player's own PLAYER_GUILDID decides
// guild membership even though WorldClient keeps the last roster it got, and the raid rows pair with
// the seam's own `GetNumRaidMembers` and `raid<i>` unit tokens as stock pairs them.
installFakeUiDocument();

const { FRAMEXML_SEAM_BINDINGS, frameXmlGuid } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (seam, name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
const SELF = 0x10n;
const GUILD_ID = UPDATE_FIELDS.PLAYER_GUILDID.offset;
const GUILD_RANK = UPDATE_FIELDS.PLAYER_GUILDRANK.offset;

function events() {
  const listeners = new Map();
  return {
    on(name, listener) {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
    emit(name, payload) { for (const listener of [...(listeners.get(name) ?? [])]) listener(payload); },
  };
}

/** A recording world whose player object carries the guild fields, as SMSG_UPDATE_OBJECT fills them. */
function liveSeam(extra = {}, guild = undefined) {
  const player = {
    guid: SELF, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1], [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 80],
      ...(guild ? [[GUILD_ID, guild.guildId], [GUILD_RANK, guild.rankId]] : [])]),
  };
  const sent = [];
  const names = new Map([[SELF, "Игрок"], [0x21n, "Бо"], [0x22n, "Ас"], [0x23n, "Вик"]]);
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, player]]) },
    targetGuid: undefined, chatLog: [], channels: new Map(), events: events(), casts: new Map(),
    actionButtons: [], knownSpells: [], aurasFor: () => [], cooldownRemaining: () => 0,
    cooldownState: () => ({ start: 0, duration: 0, enable: 0 }),
    names, creatureTemplates: new Map(), partyStats: new Map(), group: undefined,
    worldStateContext: undefined, mapId: undefined, selfName: "Игрок",
    displayName: (guid) => names.get(guid) ?? `0x${guid.toString(16)}`,
    selectTarget() {},
    requestContacts() {},
    requestGuildRoster: () => sent.push("CMSG_GUILD_ROSTER"),
    requestGuildEventLog() {}, setGuildMemberNote() {}, setGuildInfoText() {}, setGuildRank() {},
    addGuildRank() {}, removeLowestGuildRank() {},
    ...extra,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    spells: () => [][Symbol.iterator](), monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  seam.friends.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  return { seam, world, player, fired, sent };
}

test("leaving the guild: PLAYER_GUILDID 0 ends membership although WorldClient keeps the old roster", () => {
  const roster = {
    welcomeText: "Рейд в 20:00", infoText: "О нас",
    ranks: [{ flags: 0xffffffff, withdrawGoldLimit: 0, tabs: [] }, { flags: 0x40 | 0x10, withdrawGoldLimit: 0, tabs: [] }],
    members: [
      { guid: SELF, name: "Игрок", rankId: 1, level: 80, classId: 1, areaId: 0, online: true, status: 0, note: "", officerNote: "", lastSaveDays: 0 },
      { guid: 0x21n, name: "Бо", rankId: 0, level: 80, classId: 1, areaId: 0, online: true, status: 0, note: "", officerNote: "", lastSaveDays: 0 },
    ],
  };
  const { seam, player, fired, sent } = liveSeam({
    guildRoster: roster,
    guildQuery: { guildId: 9, name: "Щит", rankNames: ["ГМ", "Член"], rankCount: 2 },
    guildEventLog: [{ type: 2, playerGuid: SELF, otherGuid: 0n, rankId: 0, secondsAgo: 60 }],
  }, { guildId: 9, rankId: 1 });
  seam.friends.tick();
  assert.deepEqual(fired, [], "the membership held at attach is the starting state");
  assert.deepEqual(call(seam, "IsInGuild"), [true]);
  assert.deepEqual(call(seam, "GetGuildInfo", "player"), ["Щит", "Член", 1]);
  assert.deepEqual(call(seam, "CanGuildInvite"), [true]);
  assert.deepEqual(call(seam, "GetNumGuildMembers", true), [2]);

  // /gquit or a kick: the server zeroes PLAYER_GUILDID (a zero field is simply no longer carried).
  player.fields.delete(GUILD_ID);
  player.fields.delete(GUILD_RANK);
  seam.friends.tick();
  assert.deepEqual(fired, [["PLAYER_GUILD_UPDATE", "player"], ["GUILD_ROSTER_UPDATE"], ["GUILD_EVENT_LOG_UPDATE"]],
    "membership ends, and the old guild's roster and log go with it");
  for (const [name, expected] of [["IsInGuild", [false]], ["GetGuildInfo", []], ["CanGuildInvite", [false]],
    ["IsGuildLeader", [false]], ["GetNumGuildMembers", [0]], ["GetGuildRosterMOTD", [""]], ["GetNumGuildEvents", [0]]]) {
    assert.deepEqual(call(seam, name, ...(name === "GetGuildInfo" ? ["player"] : name === "GetNumGuildMembers" ? [true] : [])),
      expected, name);
  }
  call(seam, "GuildRoster");
  assert.deepEqual(sent, [], "no CMSG_GUILD_ROSTER for a guild the player left");

  // Joining again: the field comes back and membership with it.
  const left = fired.length;
  player.fields.set(GUILD_ID, 9);
  seam.friends.tick();
  assert.deepEqual(call(seam, "IsInGuild"), [true]);
  assert.deepEqual(fired[left], ["PLAYER_GUILD_UPDATE", "player"]);
});

test("raid rows pair with the seam: GetRaidRosterInfo(i) is unit raid<i> for i = 1..GetNumRaidMembers()", () => {
  const { seam, world } = liveSeam({
    group: {
      groupType: 0x02, leaderGuid: SELF, ownSubGroup: 0, ownFlags: 0, ownRoles: 0, guid: 1n, counter: 1,
      lootMethod: 0, masterLooterGuid: 0n, lootThreshold: 2, dungeonDifficulty: 0, raidDifficulty: 0,
      members: [
        { guid: 0x21n, name: "Бо", online: true, status: 1, subGroup: 0, flags: 0, roles: 0 },
        { guid: 0x22n, name: "Ас", online: true, status: 1, subGroup: 1, flags: 0x01, roles: 0 },
        { guid: 0x23n, name: "Вик", online: false, status: 0, subGroup: 1, flags: 0, roles: 0 },
      ],
    },
  });
  const count = call(seam, "GetNumRaidMembers")[0];
  // The client counts the player (PlayerFrame.lua:473-491 walks 1..N to find its own subgroup).
  assert.equal(count, world.group.members.length + 1, "GetNumRaidMembers counts the player");
  assert.deepEqual(call(seam, "UnitIsUnit", `raid${count}`, "player"), [true], "raid<N> is the player");
  assert.deepEqual(call(seam, "UnitGUID", `raid${count + 1}`), [], "and nobody after");
  const byGuid = new Map([[frameXmlGuid(SELF), "Игрок"], ...world.group.members.map((member) => [frameXmlGuid(member.guid), member.name])]);
  for (let index = 1; index <= count; index += 1) {
    const [name] = call(seam, "GetRaidRosterInfo", index);
    const [guid] = call(seam, "UnitGUID", `raid${index}`);
    assert.ok(guid, `raid${index} resolves`);
    assert.equal(name, byGuid.get(guid), `GetRaidRosterInfo(${index}) names unit raid${index}`);
  }
  // SMSG_GROUP_LIST does not list its receiver: the player is the row after the listed members.
  assert.deepEqual(call(seam, "GetRaidRosterInfo", world.group.members.length + 1).slice(0, 3), ["Игрок", 2, 1]);
  assert.deepEqual(call(seam, "GetRaidRosterInfo", 2).slice(0, 3), ["Ас", 1, 2], "an assistant in subgroup 2");
});
