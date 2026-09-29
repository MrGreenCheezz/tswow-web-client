import assert from "node:assert/strict";
import test from "node:test";
import {
  GE_JOINED,
  GE_MOTD,
  GUILD_BANK_MAX_TABS,
  GUILD_RANKS_MAX_COUNT,
  buildGuildInviteByName,
  buildGuildMotd,
  buildGuildQuery,
  guildErrorText,
  parseGuildCommandResult,
  parseGuildEvent,
  parseGuildInfo,
  parseGuildInvite,
  parseGuildQueryResponse,
  parseGuildRoster,
  unpackWowTime,
} from "../dist/code/world/GuildProtocol.js";

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
