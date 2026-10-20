import assert from "node:assert/strict";
import test from "node:test";
import { bankLogLines, bankSlots, bankTabs, goldAllowanceText, hasTabRight, mayDeposit, withdrawText } from "../dist/code/browser/ui/GuildBankModel.js";
import { GR_RIGHT_INVITE, GR_RIGHT_WITHDRAW_GOLD, eventLogLines, hasGuildRight, lastSeenText, rankLabel, rankRows, sortRoster } from "../dist/code/browser/ui/GuildModel.js";
import { GUILD_BANK_RIGHT_PUT_ITEM, GUILD_BANK_RIGHT_VIEW_TAB } from "../dist/code/world/GuildBankProtocol.js";
import { GE_JOINED, GE_MOTD, GUILD_BANK_MAX_TABS, GUILD_RANKS_MAX_COUNT, buildGuildInviteByName, buildGuildMotd, buildGuildQuery, guildErrorText, parseGuildCommandResult, parseGuildEvent, parseGuildInfo, parseGuildInvite, parseGuildQueryResponse, parseGuildRoster, unpackWowTime, buildGuildAddRank, buildGuildDelRank, buildGuildDisband, buildGuildLeader, buildGuildMemberNote, buildGuildRank, packWowTime } from "../dist/code/world/GuildProtocol.js";

// Merged 2026-10-20 from 2 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── guild.test.mjs
{
const encoder = new TextEncoder();
function bytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const u8 = (value) => Uint8Array.from([value & 0xff]);
const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const f32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value, true);
  return out;
};
const u64 = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};
const cstr = (value) => bytes(encoder.encode(value), u8(0));

function rank() {
  const parts = [u32(0xff), u32(1000)];
  for (let tab = 0; tab < GUILD_BANK_MAX_TABS; tab++) parts.push(u32(tab === 0 ? 3 : 0), u32(tab === 0 ? 7 : 0));
  return bytes(...parts);
}

function member({ guid = 0x11n, status = 1, name = "Тралл", rankId = 0, level = 80, classId = 7, gender = 0, area = 1519, lastSave = 0 }) {
  const head = [u64(guid), u8(status), cstr(name), u32(rankId), u8(level), u8(classId), u8(gender), u32(area)];
  // The float is written only for offline members.
  if (status === 0) head.push(f32(lastSave));
  head.push(cstr(""), cstr(""));
  return bytes(...head);
}

test("guild roster decodes ranks and all six bank tab pairs", () => {
  const payload = bytes(
    u32(2), cstr("Добро пожаловать"), cstr("Инфо"), u32(1), rank(),
    member({ guid: 0x11n, status: 1, name: "Тралл", rankId: 0, classId: 7 }),
    member({ guid: 0x22n, status: 0, name: "Джайна", rankId: 3, classId: 8, lastSave: 4.5 }),
  );
  const roster = parseGuildRoster(payload);
  assert.equal(roster.welcomeText, "Добро пожаловать");
  assert.equal(roster.infoText, "Инфо");
  assert.equal(roster.ranks.length, 1);
  assert.equal(roster.ranks[0].withdrawGoldLimit, 1000);
  assert.deepEqual(roster.ranks[0].tabs[0], { rights: 3, slots: 7 },
    "the roster carries the bank permissions needed to rename a rank without revoking them");
  assert.equal(roster.ranks[0].tabs.length, GUILD_BANK_MAX_TABS);
  assert.equal(roster.members.length, 2);
  assert.equal(roster.members[0].online, true);
  assert.equal(roster.members[0].lastSaveDays, 0, "online members carry no timestamp");
  assert.equal(roster.members[1].online, false);
  assert.ok(Math.abs(roster.members[1].lastSaveDays - 4.5) < 0.01);
  assert.equal(roster.members[1].rankId, 3);
});

test("an implausible roster is rejected rather than read as garbage", () => {
  assert.throws(() => parseGuildRoster(bytes(u32(99999), cstr(""), cstr(""), u32(0))), RangeError);
});

test("the guild query response always carries ten rank names", () => {
  const names = [];
  for (let index = 0; index < GUILD_RANKS_MAX_COUNT; index++) names.push(cstr(index < 3 ? `Ранг${index}` : ""));
  const payload = bytes(u32(5), cstr("Орда"), ...names, u32(1), u32(2), u32(3), u32(4), u32(5), u32(3));
  const info = parseGuildQueryResponse(payload);
  assert.equal(info.guildId, 5);
  assert.equal(info.name, "Орда");
  assert.equal(info.rankNames.length, GUILD_RANKS_MAX_COUNT);
  assert.equal(info.rankNames[0], "Ранг0");
  assert.equal(info.rankNames[9], "");
  assert.equal(info.rankCount, 3);
  assert.equal(info.backgroundColor, 5);
});

test("the creation date is one packed WowTime word, not three fields", () => {
  // WowTime::GetPackedTime: minute 0-5, hour 6-10, weekday 11-13, day 14-19, month 20-23, year 24-28.
  const packed = ((25 & 0x1f) << 24) | ((3 & 0xf) << 20) | ((14 & 0x3f) << 14) | ((2 & 0x7) << 11) | ((17 & 0x1f) << 6) | (45 & 0x3f);
  assert.deepEqual(unpackWowTime(packed >>> 0), { year: 2025, month: 4, day: 15, hour: 17, minute: 45 });

  const info = parseGuildInfo(bytes(cstr("Орда"), u32(packed >>> 0), u32(42), u32(30)));
  assert.equal(info.name, "Орда");
  assert.equal(info.createdYear, 2025);
  assert.equal(info.memberCount, 42);
  assert.equal(info.accountCount, 30);
});

test("guild events append a guid only for the membership four", () => {
  const joined = parseGuildEvent(bytes(u8(GE_JOINED), u8(1), cstr("Тралл"), u64(0x11n)));
  assert.equal(joined.type, GE_JOINED);
  assert.deepEqual(joined.params, ["Тралл"]);
  assert.equal(joined.guid, 0x11n);

  const motd = parseGuildEvent(bytes(u8(GE_MOTD), u8(1), cstr("Всем привет")));
  assert.deepEqual(motd.params, ["Всем привет"]);
  assert.equal(motd.guid, 0n, "the motd event carries no guid");
});

test("invites, command results and client packets", () => {
  assert.deepEqual(parseGuildInvite(bytes(cstr("Тралл"), cstr("Орда"))), { inviterName: "Тралл", guildName: "Орда" });

  const result = parseGuildCommandResult(bytes(u32(1), cstr("Кто-то"), u32(11)));
  assert.deepEqual(result, { command: 1, name: "Кто-то", result: 11 });
  assert.match(guildErrorText(11, "Кто-то"), /не найден/i);
  assert.match(guildErrorText(99, ""), /99/);

  assert.deepEqual([...buildGuildQuery(5)], [...u32(5)]);
  assert.deepEqual([...buildGuildInviteByName("Тралл")], [...cstr("Тралл")]);
  assert.deepEqual([...buildGuildMotd("Привет")], [...cstr("Привет")]);
});
}

// ── guild-model.test.mjs
{
function member(name, extra = {}) {
  return {
    guid: 1n, status: 1, online: true, name, rankId: 1, level: 80, classId: 1, gender: 0,
    areaId: 0, lastSaveDays: 0, note: "", officerNote: "", ...extra,
  };
}

test("the roster sorts online first, then by rank, then by name", () => {
  // The name is the tiebreak the old list did not have: without it two officers swapped places
  // whenever the packet happened to arrive in a different order.
  const rows = sortRoster([
    member("Борис", { rankId: 1 }),
    member("Анна", { rankId: 1 }),
    member("Виктор", { rankId: 0 }),
    member("Глеб", { rankId: 0, online: false }),
  ]);
  assert.deepEqual(rows.map((row) => row.name), ["Виктор", "Анна", "Борис", "Глеб"]);
});

test("ranks past the count the guild really has are not shown", () => {
  // SMSG_GUILD_QUERY_RESPONSE always writes ten names, padded with empty strings.
  const query = { rankNames: ["Глава", "Офицер", "", "", "", "", "", "", "", ""] };
  const roster = { welcomeText: "", infoText: "", members: [], ranks: [{ flags: 0, withdrawGoldLimit: 0 }, { flags: 0, withdrawGoldLimit: -1 }] };
  const rows = rankRows(roster, query);
  assert.equal(rows.length, 2, "two ranks, not ten");
  assert.deepEqual(rows.map((row) => row.name), ["Глава", "Офицер"]);
  assert.equal(rankLabel(7, query), "Ранг 7", "an unnamed rank still says which one it is");
});

test("a right is a whole mask, not a single bit", () => {
  // Every GR_RIGHT_* carries the 0x40 base bit, so a bitwise test against one bit passes for all.
  assert.equal(hasGuildRight(GR_RIGHT_INVITE, GR_RIGHT_INVITE), true);
  assert.equal(hasGuildRight(GR_RIGHT_INVITE, GR_RIGHT_WITHDRAW_GOLD), false);
});

test("an online member has no last-seen day, and the line does not invent one", () => {
  assert.equal(lastSeenText(member("Анна")), "в сети");
  assert.equal(lastSeenText(member("Анна", { online: false, lastSaveDays: 3.7 })), "не в сети 3 д");
});

test("an event log line names both people and says how long ago", () => {
  const lines = eventLogLines(
    [{ type: 3, playerGuid: 1n, otherGuid: 2n, rankId: 1, secondsAgo: 7200 }],
    (guid) => (guid === 1n ? "Анна" : "Борис"),
    { rankNames: ["Глава", "Офицер"] });
  assert.equal(lines[0], "Борис повысил Анна до «Офицер» · 2 ч назад");
});

test("joining and leaving name nobody else, because the packet carries nobody else", () => {
  const lines = eventLogLines(
    [{ type: 2, playerGuid: 1n, otherGuid: 0n, rankId: 0, secondsAgo: 30 }],
    () => "Анна", undefined);
  assert.equal(lines[0], "Анна вступил в гильдию · только что");
});

test("full bank rights arrive as minus one, not as 255", () => {
  assert.equal(hasTabRight(-1, GUILD_BANK_RIGHT_VIEW_TAB), true);
  assert.equal(hasTabRight(-1, GUILD_BANK_RIGHT_PUT_ITEM), true);
  assert.equal(hasTabRight(GUILD_BANK_RIGHT_VIEW_TAB, GUILD_BANK_RIGHT_PUT_ITEM), false);
});

test("there are as many tabs as the guild bought, not as many as the packet writes", () => {
  // parseGuildPermissions always writes six pairs whatever purchasedTabs says.
  const permissions = {
    rankId: 1, rights: -1, goldPerDay: -1, purchasedTabs: 2,
    tabs: Array.from({ length: 6 }, () => ({ rights: -1, slotsRemaining: -1 })),
  };
  const tabs = bankTabs({ money: 0n, tabId: 0, withdrawalsRemaining: -1, fullUpdate: true, tabs: [], items: [] }, permissions);
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].name, "Вкладка 1", "a tab with no name still has a number");
  assert.equal(mayDeposit(permissions, 0), true);
});

test("a slot named with item zero is an emptied slot, not an item", () => {
  const content = {
    money: 0n, tabId: 0, withdrawalsRemaining: -1, fullUpdate: false, tabs: [],
    items: [
      { slot: 3, itemId: 4306, flags: 0, randomPropertyId: 0, suffixFactor: 0, count: 5, enchantId: 0, charges: 0, sockets: [] },
      { slot: 4, itemId: 0, flags: 0, randomPropertyId: 0, suffixFactor: 0, count: 0, enchantId: 0, charges: 0, sockets: [] },
    ],
  };
  const slots = bankSlots(content, () => undefined, (id) => `Предмет ${id}`, () => 2);
  assert.equal(slots[3].count, 5);
  assert.equal(slots[3].quality, 2);
  assert.equal(slots[4].empty, true, "item zero empties the slot");
  assert.equal(slots[0].empty, true, "and every slot the packet did not mention is empty too");
});

test("unlimited is said in words rather than printed as minus one", () => {
  assert.equal(withdrawText(-1), "без ограничений");
  assert.equal(withdrawText(3), "осталось 3");
  assert.equal(goldAllowanceText(-1), "снятие золота без ограничений");
  assert.equal(goldAllowanceText(0), "снятие золота запрещено");
});

test("a bank log line tells an item entry from a money one", () => {
  const lines = bankLogLines(
    {
      tabId: 0,
      entries: [
        { type: 1, playerGuid: 1n, itemId: 4306, itemCount: 3, destinationTab: 0, money: 0, secondsAgo: 90 },
        { type: 5, playerGuid: 1n, itemId: 0, itemCount: 0, destinationTab: 0, money: 12345, secondsAgo: 3600 },
      ],
    },
    () => "Анна", (id) => `Предмет ${id}`);
  assert.ok(lines[0].includes("Предмет 4306 ×3"));
  assert.ok(lines[1].includes("1з 23с 45м"), "the money branch formats copper");
});

test("a rank is rewritten whole, with all six tab pairs whatever the guild owns", () => {
  assert.throws(() => buildGuildRank(2, 0x40, "Офицер", 5000, [{ rights: 1, slots: 10 }]),
    /six|6/, "a partial snapshot must never revoke the missing tab rights");
  const tabs = Array.from({ length: GUILD_BANK_MAX_TABS }, (_, tab) => ({ rights: tab + 1, slots: (tab + 1) * 10 }));
  const payload = buildGuildRank(2, 0x40, "Офицер", 5000, tabs);
  // 4 + 4 + "Офицер" + null + 4 + six pairs of two words.
  const nameBytes = new TextEncoder().encode("Офицер").length + 1;
  assert.equal(payload.length, 4 + 4 + nameBytes + 4 + 6 * 8);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  assert.equal(view.getUint32(0, true), 2);
  assert.equal(view.getUint32(4, true), 0x40);
  const firstTab = 4 + 4 + nameBytes + 4;
  for (let tab = 0; tab < GUILD_BANK_MAX_TABS; tab++) {
    assert.equal(view.getUint32(firstTab + tab * 8, true), tabs[tab].rights);
    assert.equal(view.getUint32(firstTab + tab * 8 + 4, true), tabs[tab].slots);
  }
});

test("adding a rank names it, removing one names nothing", () => {
  assert.ok(buildGuildAddRank("Новичок").length > 1);
  assert.equal(buildGuildDelRank().length, 0, "the server always removes the lowest");
  assert.equal(buildGuildDisband().length, 0);
  assert.ok(buildGuildLeader("Анна").length > 1);
  assert.ok(buildGuildMemberNote("Анна", "новенькая").length > 2);
});

test("a packed date survives a round trip", () => {
  // The calendar sends dates in this format and nothing else, so packing has to be the exact
  // inverse of the unpacking the guild info already relied on.
  const original = { year: 2026, month: 8, day: 21, hour: 19, minute: 30 };
  assert.deepEqual(unpackWowTime(packWowTime(original)), original);
});
}
