import assert from "node:assert/strict";
import test from "node:test";
import {
  GR_RIGHT_INVITE, GR_RIGHT_WITHDRAW_GOLD, eventLogLines, hasGuildRight, lastSeenText, rankLabel,
  rankRows, sortRoster,
} from "../dist/code/browser/ui/GuildModel.js";
import {
  bankLogLines, bankSlots, bankTabs, goldAllowanceText, hasTabRight, mayDeposit, withdrawText,
} from "../dist/code/browser/ui/GuildBankModel.js";
import {
  GUILD_BANK_RIGHT_PUT_ITEM, GUILD_BANK_RIGHT_VIEW_TAB,
} from "../dist/code/world/GuildBankProtocol.js";
import {
  buildGuildAddRank, buildGuildDelRank, buildGuildDisband, buildGuildLeader, buildGuildMemberNote,
  buildGuildRank, packWowTime, unpackWowTime,
  GUILD_BANK_MAX_TABS,
} from "../dist/code/world/GuildProtocol.js";

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
