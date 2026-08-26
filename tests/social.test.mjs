import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import {
  GROUP_UPDATE_AURAS, GROUP_UPDATE_CUR_HP, GROUP_UPDATE_LEVEL, GROUP_UPDATE_MAX_HP,
  GROUP_UPDATE_PET_AURAS, GROUP_UPDATE_PET_NAME, GROUP_UPDATE_POSITION, GROUP_UPDATE_STATUS,
  MEMBER_STATUS_OFFLINE, mergePartyMemberStats, parseGroupSetLeader, parseMinimapPing,
  parsePartyMemberStats, parseRaidTargetUpdate, parseRandomRoll, parseReadyCheckAnswer,
  parseReadyCheckStart, parseRealGroupUpdate, buildPartyAssignment, buildRandomRoll,
  buildRaidTargetQuery, buildReadyCheckAnswer, buildReadyCheckRequest,
} from "../dist/code/world/PartyProtocol.js";
import {
  ROLL_GREED, ROLL_NEED, ROLL_PASS, lootRollText, parseLootAllPassed, parseLootList,
  parseLootMasterList, parseLootRoll, parseLootRollWon, parseLootStartRoll,
} from "../dist/code/world/LootRollProtocol.js";
import {
  GUILD_BANK_LOG_DEPOSIT_MONEY, GUILD_BANK_LOG_MOVE_ITEM, GUILD_BANK_LOG_WITHDRAW_ITEM,
  GUILD_EVENT_JOIN_GUILD, GUILD_EVENT_PROMOTE_PLAYER, parseGuildBankList, parseGuildBankLog,
  parseGuildBankMoneyWithdrawn, parseGuildEventLog, parseGuildPermissions,
} from "../dist/code/world/GuildBankProtocol.js";
import {
  parseCalendarCommandResult, parseCalendarEventRemovedAlert, parseCalendarInviteAdded,
  parseCalendarInviteAlert, parseCalendarSnapshot, parseRaidLockoutAdded, parseRaidLockoutRemoved,
  calendarErrorText, unpackWowTime,
} from "../dist/code/world/CalendarProtocol.js";
import {
  CHAT_MODE_CHANGE_NOTICE, CHAT_NOT_MEMBER_NOTICE, CHAT_PLAYER_KICKED_NOTICE,
  CHAT_YOU_JOINED_NOTICE, CHAT_YOU_LEFT_NOTICE, parseChannelList, parseChannelNotify,
  parseUserlistChange,
} from "../dist/code/world/ChannelProtocol.js";
import {
  FRIEND_ADDED_OFFLINE, FRIEND_ADDED_ONLINE, FRIEND_ONLINE, SOCIAL_FLAG_FRIEND,
  SOCIAL_FLAG_IGNORED, parseContactList, parseFriendStatus, parseNextMailTime, parseWho,
} from "../dist/code/world/ContactProtocol.js";
import {
  parsePetitionQueryResponse, parsePetitionShowList, parsePetitionSignatures,
} from "../dist/code/world/PetitionProtocol.js";
import {
  parseLfgBootProposal, parseLfgPartyInfo, parseLfgPlayerInfo, parseLfgPlayerReward,
  parseLfgRoleCheckUpdate, splitDungeonEntry,
} from "../dist/code/world/LfgProtocol.js";

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
const u16 = (value) => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value & 0xffff, true);
  return out;
};
const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const i32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value | 0, true);
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
/** The core's packed guid: a mask byte, then only the non-zero bytes, low to high. */
const packed = (value) => {
  const mask = [];
  const body = [];
  for (let index = 0; index < 8; index++) {
    const byte = Number((value >> BigInt(index * 8)) & 0xffn);
    if (byte !== 0) {
      mask.push(index);
      body.push(byte);
    }
  }
  let maskByte = 0;
  for (const bit of mask) maskByte |= 1 << bit;
  return bytes(u8(maskByte), Uint8Array.from(body));
};

const PLAYER = 0x0000_0000_0000_2a01n;
const OTHER = 0x0000_0000_0000_2a02n;
const CREATURE = 0xf130_0058_0000_1234n;

test("party member stats is a walk over its own mask, and FULL only adds a leading byte", () => {
  // GroupHandler.cpp BuildPartyMemberStatsChangedPacket: packed guid, mask, then one field per set
  // bit in ascending bit order. Nothing is fixed-length beyond the guid and the mask.
  const flags = GROUP_UPDATE_STATUS | GROUP_UPDATE_CUR_HP | GROUP_UPDATE_MAX_HP | GROUP_UPDATE_LEVEL;
  const changed = bytes(packed(PLAYER), u32(flags), u16(0x0001), u32(4200), u32(9000), u16(74));
  const stats = parsePartyMemberStats(changed, false);
  assert.equal(stats.guid, PLAYER);
  assert.equal(stats.health, 4200);
  assert.equal(stats.maxHealth, 9000);
  assert.equal(stats.level, 74, "the level is widened to sixteen bits on the wire");
  assert.equal(stats.zoneId, undefined, "a bit that is clear carries no field at all");

  // The FULL reply is the same walk behind one zero byte. Reading that byte as part of the packed
  // guid would shift everything after it.
  const full = bytes(u8(0), packed(PLAYER), u32(flags), u16(0x0001), u32(4200), u32(9000), u16(74));
  assert.deepEqual(parsePartyMemberStats(full, true), stats);

  // And the reply for somebody offline or unknown stops after the status word.
  const stub = bytes(u8(0), packed(OTHER), u32(GROUP_UPDATE_STATUS), u16(MEMBER_STATUS_OFFLINE));
  const offline = parsePartyMemberStats(stub, true);
  assert.equal(offline.status, MEMBER_STATUS_OFFLINE);
  assert.equal(offline.health, undefined);
});

test("the raid aura mask names sixty-four slots, and a cleared one still writes an entry", () => {
  // Slots 0 and 3 changed: slot 0 still holds a spell, slot 3 was emptied and writes a zero id.
  const mask = (1n << 0n) | (1n << 3n);
  const payload = bytes(
    packed(PLAYER),
    u32(GROUP_UPDATE_AURAS | GROUP_UPDATE_POSITION),
    u16(1234), u16(5678),
    u64(mask), u32(48438), u8(1), u32(0), u8(1),
  );
  const stats = parsePartyMemberStats(payload, false);
  assert.equal(stats.auraMask, mask);
  assert.deepEqual(stats.auras, [
    { slot: 0, spellId: 48438, flags: 1 },
    { slot: 3, spellId: 0, flags: 1 },
  ]);
  // Positions are the server's float truncated into an unsigned short, so they are read raw.
  assert.equal(stats.positionX, 1234);
  assert.equal(stats.positionY, 5678);
});

test("a pet field is written even when there is no pet, and a pet aura mask of zero ends the block", () => {
  // GroupHandler.cpp writes an empty name and a zero mask rather than skipping the fields, so the
  // packet length follows the mask and never the pet.
  const payload = bytes(
    packed(PLAYER),
    u32(GROUP_UPDATE_PET_NAME | GROUP_UPDATE_PET_AURAS),
    u8(0),
    u64(0n),
  );
  const stats = parsePartyMemberStats(payload, false);
  assert.equal(stats.petName, "");
  assert.equal(stats.petAuraMask, 0n);
  assert.deepEqual(stats.petAuras, []);
});

test("folding stats keeps what an earlier packet said", () => {
  const first = parsePartyMemberStats(bytes(packed(PLAYER), u32(GROUP_UPDATE_MAX_HP), u32(9000)), false);
  const second = parsePartyMemberStats(bytes(packed(PLAYER), u32(GROUP_UPDATE_CUR_HP), u32(120)), false);
  const merged = mergePartyMemberStats(first, second);
  assert.equal(merged.maxHealth, 9000, "a one-field update must not erase the rest");
  assert.equal(merged.health, 120);
  assert.equal(merged.flags, GROUP_UPDATE_MAX_HP | GROUP_UPDATE_CUR_HP);
});

test("the leader change carries a name and no guid at all", () => {
  assert.equal(parseGroupSetLeader(cstr("Тралл")), "Тралл");
  const update = parseRealGroupUpdate(bytes(u8(2), u32(4), u64(PLAYER)));
  assert.equal(update.otherMembers, 4, "the count excludes the receiving player");
  assert.equal(update.leaderGuid, PLAYER);
});

test("a ready check asks on one opcode and is answered on another", () => {
  assert.equal(parseReadyCheckStart(u64(PLAYER)), PLAYER);
  const answer = parseReadyCheckAnswer(bytes(u64(OTHER), u8(1)));
  assert.deepEqual(answer, { guid: OTHER, ready: true });
  assert.equal(buildReadyCheckRequest().length, 0, "an empty body starts a check");
  assert.equal(buildReadyCheckAnswer(false).length, 1, "one byte answers one");
});

test("the raid target list has no count and no terminator, and a clear has a zero setter", () => {
  // Group.cpp SendTargetIconList skips empty slots and runs to the end of the packet.
  const list = parseRaidTargetUpdate(bytes(u8(1), u8(0), u64(CREATURE), u8(7), u64(OTHER)));
  assert.equal(list.whole, true);
  assert.deepEqual(list.icons, [{ icon: 0, guid: CREATURE }, { icon: 7, guid: OTHER }]);
  assert.deepEqual(parseRaidTargetUpdate(u8(1)).icons, [], "no icons at all is a one-byte packet");

  const single = parseRaidTargetUpdate(bytes(u8(0), u64(PLAYER), u8(3), u64(CREATURE)));
  assert.equal(single.whole, false);
  assert.equal(single.setterGuid, PLAYER);
  assert.deepEqual(single.icons, [{ icon: 3, guid: CREATURE }]);

  // Moving an icon that is already in use clears the old slot first, with both guids empty.
  const cleared = parseRaidTargetUpdate(bytes(u8(0), u64(0n), u8(3), u64(0n)));
  assert.equal(cleared.setterGuid, 0n);
  assert.equal(cleared.icons[0].guid, 0n);
});

test("a minimap ping is real floats, and a roll puts its result before the roller", () => {
  const ping = parseMinimapPing(bytes(u64(CREATURE), f32(-8913.5), f32(554.25)));
  assert.equal(ping.guid, CREATURE, "a Sentry Totem pings with its own creature guid");
  assert.equal(ping.x, -8913.5);
  assert.equal(ping.y, 554.25);

  const roll = parseRandomRoll(bytes(u32(1), u32(100), u32(73), u64(PLAYER)));
  assert.deepEqual(roll, { minimum: 1, maximum: 100, result: 73, rollerGuid: PLAYER });
  assert.equal(buildRandomRoll(1, 100).length, 8, "the client sends only the range");
  assert.equal(buildRaidTargetQuery()[0], 0xff, "0xFF asks for the whole icon list");
  assert.equal(buildPartyAssignment(0, true, PLAYER).length, 10);
});

test("all four loot roll packets disagree about where the item fields go", () => {
  const start = parseLootStartRoll(bytes(
    u64(CREATURE), u32(571), u32(2), u32(49623), u32(0), i32(-42), u32(1), u32(60000), u8(0x07),
  ));
  assert.equal(start.itemSlot, 2);
  assert.equal(start.randomPropertyId, -42, "a rolled suffix is a negative property id");
  assert.equal(start.countdown, 60000);
  assert.equal(start.voteMask, 0x07);

  // The roller's guid is third here...
  const vote = parseLootRoll(bytes(
    u64(0n), u32(2), u64(PLAYER), u32(49623), u32(0), i32(-42), u8(97), u8(ROLL_NEED), u8(0),
  ));
  assert.equal(vote.playerGuid, PLAYER);
  assert.equal(vote.itemGuid, 0n, "every announcement leaves the item guid empty");
  assert.equal(vote.rollNumber, 97);

  // ...and after the item block there.
  const won = parseLootRollWon(bytes(
    u64(0n), u32(2), u32(49623), u32(0), i32(-42), u64(OTHER), u8(97), u8(ROLL_NEED),
  ));
  assert.equal(won.winnerGuid, OTHER);
  assert.equal(won.itemSlot, 2);

  // And this one writes the property before the suffix, the reverse of its three siblings.
  const passed = parseLootAllPassed(bytes(u64(CREATURE), u32(2), u32(49623), i32(-42), u32(9)));
  assert.equal(passed.randomPropertyId, -42);
  assert.equal(passed.randomSuffix, 9);
  assert.equal(passed.itemGuid, CREATURE, "this one does carry the roll's real item guid");
});

test("a roll announcement is told apart by its number, because the type cannot tell need from pass", () => {
  // Group.cpp CountRollVote: need is announced as (0, 0) and a pass as (128, ROLL_PASS) — and
  // ROLL_PASS is itself 0, so deciding on the type turns every need into its opposite.
  const announce = (rollNumber, rollType) => parseLootRoll(bytes(
    u64(0n), u32(2), u64(PLAYER), u32(49623), u32(0), i32(0), u8(rollNumber), u8(rollType), u8(0),
  ));
  assert.match(lootRollText(announce(0, ROLL_PASS), "Тралл"), /нужно/);
  assert.match(lootRollText(announce(128, ROLL_PASS), "Тралл"), /пропуск/);
  assert.match(lootRollText(announce(128, ROLL_GREED), "Тралл"), /интересно/);
  assert.match(lootRollText(announce(97, ROLL_NEED), "Тралл"), /97/, "1 to 100 is a real roll");

  const auto = parseLootRoll(bytes(
    u64(CREATURE), u32(2), u64(PLAYER), u32(49623), u32(0), i32(0), u8(128), u8(ROLL_PASS), u8(1),
  ));
  assert.match(lootRollText(auto, "Тралл"), /автоматически/);
});

test("the calendar error table lines up with the enum it claims to follow", () => {
  // CalendarMgr.h has gaps at 15, 18, 23 and 30 to 35, so the table is transcribed, not counted.
  assert.equal(calendarErrorText(0), "Готово");
  assert.equal(calendarErrorText(9), "Игрок не состоит в гильдии");
  assert.equal(calendarErrorText(11), "Игрок не найден");
  assert.equal(calendarErrorText(12), "Игрок из другой фракции");
  assert.equal(calendarErrorText(20), "Событие уже прошло");
  assert.equal(calendarErrorText(21), "Событие заблокировано");
  assert.match(calendarErrorText(15), /код 15/, "a gap in the enum falls through to the code");
});

test("the master loot list is a patched count, and the loot owners are never omitted", () => {
  assert.deepEqual(parseLootMasterList(bytes(u8(2), u64(PLAYER), u64(OTHER))), [PLAYER, OTHER]);
  assert.deepEqual(parseLootMasterList(u8(0)), []);

  // Group.cpp SendLooter writes a bare zero byte where it has nobody to name, which is exactly a
  // packed empty guid — so both trailing guids are always read, and both come back as zero.
  const nobody = parseLootList(bytes(u64(CREATURE), u8(0), u8(0)));
  assert.equal(nobody.corpseGuid, CREATURE);
  assert.equal(nobody.masterLooterGuid, 0n);
  assert.equal(nobody.allowedLooterGuid, 0n);
  const owned = parseLootList(bytes(u64(CREATURE), u8(0), packed(PLAYER)));
  assert.equal(owned.allowedLooterGuid, PLAYER);
});

test("the guild bank log branches on its own type byte", () => {
  const payload = bytes(
    u8(6), u8(3),
    u8(GUILD_BANK_LOG_WITHDRAW_ITEM), u64(PLAYER), u32(49623), u32(2), u32(90),
    u8(GUILD_BANK_LOG_MOVE_ITEM), u64(OTHER), u32(1234), u32(1), u8(4), u32(180),
    u8(GUILD_BANK_LOG_DEPOSIT_MONEY), u64(PLAYER), u32(50000), u32(300),
  );
  const log = parseGuildBankLog(payload);
  assert.equal(log.tabId, 6, "six is the money log rather than a real tab");
  assert.equal(log.entries[0].itemCount, 2);
  assert.equal(log.entries[1].destinationTab, 4, "only a move carries a destination");
  assert.equal(log.entries[2].money, 50000);
  assert.equal(log.entries[2].secondsAgo, 300, "the time is an elapsed count, not a timestamp");
});

test("the guild event log omits the second guid for joining and leaving", () => {
  const entries = parseGuildEventLog(bytes(
    u8(2),
    u8(GUILD_EVENT_JOIN_GUILD), u64(PLAYER), u32(60),
    u8(GUILD_EVENT_PROMOTE_PLAYER), u64(PLAYER), u64(OTHER), u8(3), u32(120),
  ));
  assert.equal(entries[0].otherGuid, 0n, "nobody made them join");
  assert.equal(entries[1].otherGuid, OTHER);
  assert.equal(entries[1].rankId, 3, "only a promotion or a demotion carries the new rank");
});

test("guild permissions always write six tab pairs, and full rights arrive as minus one", () => {
  const parts = [u32(0), i32(0x0000_00ff), i32(-1), u8(2)];
  for (let tab = 0; tab < 6; tab++) parts.push(i32(tab < 2 ? -1 : 0), i32(tab < 2 ? -1 : 0));
  const permissions = parseGuildPermissions(bytes(...parts));
  assert.equal(permissions.goldPerDay, -1, "unlimited is minus one, not four billion");
  assert.equal(permissions.purchasedTabs, 2);
  assert.equal(permissions.tabs.length, 6, "all six pairs are written whether the tabs exist or not");
  assert.equal(permissions.tabs[0].rights, -1, "a byte of 0xFF is sign extended into the word");
  assert.equal(permissions.tabs[0].rights & 0xff, 0xff);
  assert.equal(parseGuildBankMoneyWithdrawn(i32(-1)), -1);
});

test("the guild bank writes its tab list only for a full refresh of tab zero", () => {
  const withTabs = bytes(
    u64(1234567n), u8(0), i32(-1), u8(1),
    u8(1), cstr("Расходники"), cstr("Interface\\Icons\\INV_Misc_Bag_08"),
    u8(1), u8(5), u32(49623), i32(0), i32(-42), i32(1200), i32(3), i32(0), u8(0), u8(1), u8(2), i32(3723),
  );
  const bank = parseGuildBankList(withTabs);
  assert.equal(bank.tabs.length, 1);
  assert.equal(bank.tabs[0].name, "Расходники");
  assert.equal(bank.items[0].suffixFactor, 1200, "the suffix factor rides on a non-zero property");
  assert.deepEqual(bank.items[0].sockets, [{ index: 2, enchantId: 3723 }]);

  // The same shape without the flag, on tab one: no tab list at all, and the item count sits where
  // the tab count did.
  const incremental = bytes(u64(0n), u8(1), i32(0), u8(0), u8(1), u8(9), u32(0));
  const update = parseGuildBankList(incremental);
  assert.deepEqual(update.tabs, []);
  assert.equal(update.items[0].itemId, 0, "a zero item id empties the slot and ends the entry");
});

test("the calendar dump puts a unix time next to a packed one", () => {
  // WowTime::GetPackedTime: minute 0-5, hour 6-10, weekday 11-13, day 14-19, month 20-23, year 24-28.
  const packedTime = (30 | (19 << 6) | (5 << 11) | (20 << 14) | (7 << 20) | (26 << 24)) >>> 0;
  const payload = bytes(
    u32(0),
    u32(1), u64(7n), cstr("Ульдуар"), u32(1), u32(packedTime), u32(0x40), i32(-4), packed(PLAYER),
    u32(1755000000), u32(packedTime),
    u32(1), i32(603), u32(1), i32(3600), u64(42n),
    u32(1135753200),
    u32(0),
    u32(0),
  );
  const calendar = parseCalendarSnapshot(payload);
  assert.equal(calendar.events[0].name, "Ульдуар");
  assert.equal(calendar.events[0].textureId, -4, "the texture id is signed");
  assert.equal(calendar.serverNow, 1755000000, "this one is a raw unix time");
  assert.deepEqual(unpackWowTime(calendar.serverTime), {
    year: 2026, month: 8, day: 21, hour: 19, minute: 30,
  }, "and the one right after it is a packed WowTime");
  assert.equal(calendar.lockouts[0].instanceId, 42n);
  assert.equal(calendar.raidOrigin, 1135753200);
});

test("a calendar invite carries a response time only for a guild event", () => {
  const guild = parseCalendarInviteAdded(bytes(packed(OTHER), u64(7n), u64(9n), u8(80), u8(0), u8(1), u32(123), u8(1)));
  assert.equal(guild.responseTime, 123);
  assert.equal(guild.clearPending, true);

  const personal = parseCalendarInviteAdded(bytes(packed(OTHER), u64(7n), u64(9n), u8(80), u8(0), u8(0), u8(1)));
  assert.equal(personal.responseTime, undefined, "four bytes shorter, with the flag sliding up");
  assert.equal(personal.clearPending, true);
});

test("the invite alert carries a flags word between the date and the type", () => {
  const alert = parseCalendarInviteAlert(bytes(
    u64(7n), cstr("Рейд"), u32(111), u32(0x40), u32(1), i32(-4), u64(9n), u8(1), u8(2),
    packed(PLAYER), packed(OTHER),
  ));
  assert.equal(alert.flags, 0x40);
  assert.equal(alert.eventType, 1);
  assert.equal(alert.ownerGuid, PLAYER);
  assert.equal(alert.invitedByGuid, OTHER, "it ends on two packed guids, not two full ones");
});

test("the removed alert leads with its pending flag, and the command result has two strings", () => {
  const removed = parseCalendarEventRemovedAlert(bytes(u8(1), u64(7n), u32(111)));
  assert.equal(removed.clearPending, true);
  assert.equal(removed.eventId, 7n);

  // The first string is written as a literal empty one; reading a single string desyncs by a byte.
  const result = parseCalendarCommandResult(bytes(u32(1), u8(0), cstr("Тралл"), u32(13)));
  assert.equal(result.name, "Тралл");
  assert.equal(result.result, 13);
});

test("the removed raid lockout drops the leading time the added one carries", () => {
  const added = parseRaidLockoutAdded(bytes(u32(111), i32(603), u32(1), i32(3600), u64(42n)));
  assert.equal(added.serverTime, 111);
  assert.equal(added.instanceId, 42n);

  const removed = parseRaidLockoutRemoved(bytes(i32(603), u32(1), i32(-90), u64(42n)));
  assert.equal(removed.serverTime, undefined);
  assert.equal(removed.mapId, 603);
  assert.equal(removed.timeRemaining, -90, "an expired save reports a negative remainder");
});

test("a channel notify is read by its code, and the two channel codes disagree on order", () => {
  const joined = parseChannelNotify(bytes(u8(CHAT_YOU_JOINED_NOTICE), cstr("Общий"), u8(0x11), u32(1), u32(0)));
  assert.equal(joined.channelFlags, 0x11);
  assert.equal(joined.channelId, 1);

  const left = parseChannelNotify(bytes(u8(CHAT_YOU_LEFT_NOTICE), cstr("Общий"), u32(1), u8(1)));
  assert.equal(left.channelId, 1, "here the id comes first and the flag byte last");
  assert.equal(left.constantChannel, true);

  const kicked = parseChannelNotify(bytes(u8(CHAT_PLAYER_KICKED_NOTICE), cstr("Общий"), u64(OTHER), u64(PLAYER)));
  assert.equal(kicked.guid, OTHER, "the one kicked comes first, the kicker second");
  assert.equal(kicked.actorGuid, PLAYER);

  const mode = parseChannelNotify(bytes(u8(CHAT_MODE_CHANGE_NOTICE), cstr("Общий"), u64(OTHER), u8(0), u8(2)));
  assert.equal(mode.newMemberFlags, 2);

  const empty = parseChannelNotify(bytes(u8(CHAT_NOT_MEMBER_NOTICE), cstr("Общий")));
  assert.equal(empty.guid, 0n, "most codes carry no body at all");
});

test("the channel roster leads with a constant, and a removal is a byte shorter than an add", () => {
  const list = parseChannelList(bytes(u8(1), cstr("Торговля"), u8(0x24), u32(2), u64(PLAYER), u8(1), u64(OTHER), u8(0)));
  assert.equal(list.channel, "Торговля");
  assert.equal(list.channelFlags, 0x24, "the leading byte is a hardcoded one, not the flags");
  assert.equal(list.members.length, 2);
  assert.equal(list.members[0].flags, 1);

  const added = parseUserlistChange(bytes(u64(OTHER), u8(0), u8(0x24), u32(3), cstr("Торговля")), false);
  assert.equal(added.count, 3);
  assert.equal(added.channel, "Торговля");

  // Channel::LeaveNotify writes no member flags at all.
  const removed = parseUserlistChange(bytes(u64(OTHER), u8(0x24), u32(2), cstr("Торговля")), true);
  assert.equal(removed.channelFlags, 0x24);
  assert.equal(removed.count, 2);
  assert.equal(removed.channel, "Торговля");
});

test("a contact entry has three possible shapes, decided per entry", () => {
  const payload = bytes(
    u32(0x07), u32(3),
    u64(PLAYER), u32(SOCIAL_FLAG_FRIEND), cstr("танк"), u8(1), u32(1519), u32(80), u32(1),
    u64(OTHER), u32(SOCIAL_FLAG_FRIEND), cstr(""), u8(0),
    u64(CREATURE), u32(SOCIAL_FLAG_IGNORED), cstr(""),
  );
  const list = parseContactList(payload);
  assert.equal(list.flags, 0x07);
  assert.equal(list.contacts[0].level, 80, "an online friend adds zone, level and class");
  assert.equal(list.contacts[0].note, "танк");
  assert.equal(list.contacts[1].status, 0, "an offline friend stops after the status byte");
  assert.equal(list.contacts[1].level, 0);
  assert.equal(list.contacts[2].status, 0, "a pure ignore has no status byte at all");
});

test("friend status runs two independent tests over one code", () => {
  const both = parseFriendStatus(bytes(u8(FRIEND_ADDED_ONLINE), u64(OTHER), cstr("друг"), u8(1), u32(1519), u32(80), u32(4)));
  assert.equal(both.note, "друг");
  assert.equal(both.classId, 4);

  const noteOnly = parseFriendStatus(bytes(u8(FRIEND_ADDED_OFFLINE), u64(OTHER), cstr("")));
  assert.equal(noteOnly.note, "");
  assert.equal(noteOnly.level, 0);

  const blockOnly = parseFriendStatus(bytes(u8(FRIEND_ONLINE), u64(OTHER), u8(2), u32(1519), u32(80), u32(4)));
  assert.equal(blockOnly.status, 2);
  assert.equal(blockOnly.note, "", "coming online carries no note");

  // Everything else is nine bytes.
  assert.equal(parseFriendStatus(bytes(u8(0x03), u64(OTHER))).guid, OTHER);
});

test("a who row widens everything except the gender", () => {
  const payload = bytes(
    u32(1), u32(300),
    cstr("Джайна"), cstr("Кирин-Тор"), u32(80), u32(8), u32(1), u8(1), u32(1519),
  );
  const result = parseWho(payload);
  assert.equal(result.displayed, 1);
  assert.equal(result.matched, 300, "the second count reports what the row cap dropped");
  assert.equal(result.entries[0].guild, "Кирин-Тор");
  assert.equal(result.entries[0].race, 1);
  assert.equal(result.entries[0].gender, 1);
  assert.equal(result.entries[0].zoneId, 1519);
  assert.deepEqual(parseWho(bytes(u32(0), u32(0))).entries, []);
});

test("the mail answer is told apart by its float, not by its length", () => {
  const none = parseNextMailTime(bytes(f32(-86400), i32(0)));
  assert.equal(none.nextMailTime, -86400, "no mail is minus one day, and is negative");
  assert.deepEqual(none.senders, []);

  const waiting = parseNextMailTime(bytes(f32(0), i32(0)));
  assert.equal(waiting.nextMailTime, 0, "unread mail whose senders were all filtered out");
  assert.deepEqual(waiting.senders, []);

  const listed = parseNextMailTime(bytes(f32(0), i32(1), u64(PLAYER), i32(0), i32(0), i32(41), f32(-30)));
  assert.equal(listed.senders[0].senderGuid, PLAYER);
  assert.equal(listed.senders[0].stationeryId, 41);
  assert.equal(listed.senders[0].timeLeft, -30, "written last, though the struct declares it second");
});

test("the charter query is twenty-seven fields, and one of them is two bytes wide", () => {
  const parts = [u32(4242), u64(PLAYER), cstr("Пламя Севера"), u8(0), u32(9), u32(9), u32(0)];
  for (let spare = 0; spare < 4; spare++) parts.push(u32(0));
  parts.push(u16(0));
  for (let spare = 0; spare < 3; spare++) parts.push(u32(0));
  for (let unused = 0; unused < 10; unused++) parts.push(u8(0));
  parts.push(u32(0), u32(0));
  const petition = parsePetitionQueryResponse(bytes(...parts));
  assert.equal(petition.petitionId, 4242);
  assert.equal(petition.ownerGuid, PLAYER);
  assert.equal(petition.name, "Пламя Севера");
  assert.equal(petition.minSignatures, 9);
  assert.equal(petition.arena, false);

  // The arena form changes values, never positions.
  const arenaParts = parts.slice();
  arenaParts[arenaParts.length - 1] = u32(1);
  assert.equal(parsePetitionQueryResponse(bytes(...arenaParts)).arena, true);
});

test("a charter vendor sells one thing or three, and the count says which", () => {
  const guild = parsePetitionShowList(bytes(u64(CREATURE), u8(1), u32(1), u32(5863), u32(16161), u32(1000), u32(0), u32(9)));
  assert.equal(guild.offers.length, 1);
  assert.equal(guild.offers[0].itemId, 5863);
  assert.equal(guild.offers[0].requiredSignatures, 9);

  const arena = parsePetitionShowList(bytes(
    u64(CREATURE), u8(3),
    u32(1), u32(23560), u32(16161), u32(800000), u32(2), u32(2),
    u32(2), u32(23561), u32(16161), u32(1200000), u32(3), u32(3),
    u32(3), u32(23562), u32(16161), u32(2000000), u32(5), u32(5),
  ));
  assert.equal(arena.offers.length, 3);
  assert.equal(arena.offers[2].teamSize, 5);

  const signatures = parsePetitionSignatures(bytes(u64(CREATURE), u64(PLAYER), u32(4242), u8(2), u64(OTHER), u32(0), u64(PLAYER), u32(0)));
  assert.equal(signatures.petitionId, 4242);
  assert.deepEqual(signatures.signers, [OTHER, PLAYER]);
});

test("the dungeon finder reward block is eighteen bytes even when nothing was resolved", () => {
  const info = parseLfgPlayerInfo(bytes(
    u8(2),
    u32(0x02000102), u8(0), u32(15000), u32(24000), u32(0), u32(0), u8(1), u32(49426), u32(0), u32(2),
    u32(0x02000103), u8(0), u32(0), u32(0), u32(0), u32(0), u8(0),
    u32(1), u32(0x02000104), u32(6),
  ));
  assert.equal(info.dungeons.length, 2);
  assert.deepEqual(splitDungeonEntry(info.dungeons[0].entry), { dungeonId: 258, type: 2 });
  assert.equal(info.dungeons[0].reward.money, 15000);
  assert.deepEqual(info.dungeons[0].reward.items, [{ itemId: 49426, displayId: 0, count: 2 }]);
  assert.equal(info.dungeons[1].reward.money, 0, "no reward quest still writes the whole head");
  assert.deepEqual(info.locks, [{ dungeonId: 0x02000104, reason: 6 }]);
});

test("the completion reward writes one extra word the dungeon list does not", () => {
  const reward = parseLfgPlayerReward(bytes(
    u32(0x02000102), u32(0x01000103), u8(1), u32(1), u32(15000), u32(24000), u32(0), u32(0),
    u8(1), u32(49426), u32(0), u32(2),
  ));
  assert.equal(reward.randomEntry, 0x02000102);
  assert.equal(reward.dungeonEntry, 0x01000103);
  assert.equal(reward.reward.done, true);
  assert.equal(reward.reward.money, 15000, "a shared reader would read the literal one as the money");
});

test("the party lock block counts members in a byte and their locks in a word", () => {
  const locks = parseLfgPartyInfo(bytes(
    u8(2),
    u64(PLAYER), u32(1), u32(0x02000102), u32(2),
    u64(OTHER), u32(0),
  ));
  assert.equal(locks.length, 2);
  assert.equal(locks[0].dungeons[0].reason, 2);
  assert.deepEqual(locks[1].dungeons, [], "a member with nothing locked still appears");
});

test("the role check puts the leader first, and the boot vote never carries a countdown", () => {
  const check = parseLfgRoleCheckUpdate(bytes(
    u32(2), u8(1), u8(1), u32(0x02000102),
    u8(2),
    u64(PLAYER), u8(1), u32(0x03), u8(80),
    u64(OTHER), u8(0), u32(0x00), u8(0),
  ));
  assert.equal(check.starting, true);
  assert.equal(check.members[0].guid, PLAYER, "the leader is written ahead of map order");
  assert.equal(check.members[0].roles, 0x03);
  assert.equal(check.members[1].ready, false);
  assert.equal(check.members[1].level, 0, "an offline member reports level zero");

  const boot = parseLfgBootProposal(bytes(
    u8(1), u8(1), u8(0), u64(OTHER), u32(2), u32(1), u32(0), u32(3), cstr("афк"),
  ));
  assert.equal(boot.victimGuid, OTHER);
  assert.equal(boot.votesNeeded, 3);
  assert.equal(boot.secondsLeft, 0, "the core divides seconds by a thousand, so this is always zero");
  assert.equal(boot.reason, "афк");
});

test("every opcode this slice claims is one the client really names", () => {
  // A guard against a rename in the generated table silently unhooking a handler.
  for (const name of [
    "SMSG_PARTY_MEMBER_STATS", "SMSG_PARTY_MEMBER_STATS_FULL", "MSG_RAID_READY_CHECK",
    "MSG_RAID_READY_CHECK_CONFIRM", "MSG_RAID_TARGET_UPDATE", "SMSG_LOOT_START_ROLL",
    "SMSG_GUILD_BANK_LIST", "SMSG_CALENDAR_SEND_CALENDAR", "SMSG_CHANNEL_NOTIFY",
    "SMSG_CONTACT_LIST", "SMSG_PETITION_QUERY_RESPONSE", "SMSG_LFG_ROLE_CHECK_UPDATE",
  ]) {
    assert.equal(typeof OPCODES[name], "number", `${name} is missing from the generated table`);
  }
});
