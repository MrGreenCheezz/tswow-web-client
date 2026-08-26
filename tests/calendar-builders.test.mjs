import assert from "node:assert/strict";
import test from "node:test";
import {
  CALENDAR_STATUS_ACCEPTED,
  buildCalendarAddEvent, buildCalendarArenaTeam, buildCalendarComplain, buildCalendarCopyEvent,
  buildCalendarEventStatus, buildCalendarGuildFilter, buildCalendarInvite,
  buildCalendarModeratorStatus, buildCalendarRemoveEvent, buildCalendarRemoveInvite,
  buildCalendarRsvp, buildCalendarSignUp, buildCalendarUpdateEvent, packWowTime,
} from "../dist/code/world/CalendarProtocol.js";
import {
  buildGuildBankBuyTab, buildGuildBankDepositItem, buildGuildBankMoney, buildGuildBankUpdateTab,
  buildGuildBankWithdrawItem,
} from "../dist/code/world/GuildBankProtocol.js";

// The whole writing half of the calendar and the guild bank was missing: eighteen packets parsed
// and not one of them answerable. Every layout below is `CalendarPackets.cpp::Read` and
// `GuildPackets.cpp::Read`, field for field.

const view = (payload) => new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
const DATE = packWowTime({ year: 2026, month: 8, day: 21, hour: 19, minute: 30 });

const EVENT = {
  title: "Рейд", description: "в девять", eventType: 1, maxSize: 25, textureId: 3,
  time: DATE, lockDate: 0, flags: 0,
};

test("a new event writes the skipped repeat byte the client still sends", () => {
  // `CalendarAddEvent::Read` does `read_skip<uint8>()` after the type: a Cataclysm field the 3.3.5
  // client writes anyway. Leaving it out shifts every field after it.
  const payload = buildCalendarAddEvent(EVENT);
  const titleBytes = new TextEncoder().encode("Рейд").length + 1;
  const descriptionBytes = new TextEncoder().encode("в девять").length + 1;
  const at = titleBytes + descriptionBytes;
  assert.equal(payload[at], 1, "the event type");
  assert.equal(payload[at + 1], 0, "then the repeat byte the server throws away");
  assert.equal(view(payload).getUint32(at + 2, true), 25, "then the size");
  // Four words of size, texture, time and lock date, then flags, then an invite count of zero.
  assert.equal(view(payload).getUint32(payload.length - 4, true), 0, "no invitees");
});

test("an event's invitees carry a packed guid, unlike everything else in this family", () => {
  const payload = buildCalendarAddEvent(EVENT, [{ guid: 0x42n, status: 0, moderator: 0 }]);
  const plain = buildCalendarAddEvent(EVENT);
  // A packed guid of 0x42 is a mask byte and one value byte, then two bytes of status and rank.
  assert.equal(payload.length, plain.length + 4);
});

test("an update names the event and the moderator before it repeats the fields", () => {
  const payload = buildCalendarUpdateEvent(7n, 9n, EVENT);
  assert.equal(view(payload).getBigUint64(0, true), 7n);
  assert.equal(view(payload).getBigUint64(8, true), 9n);
});

test("an answer to an invitation is two ids and a status byte", () => {
  const payload = buildCalendarRsvp(7n, 11n, CALENDAR_STATUS_ACCEPTED);
  assert.equal(payload.length, 17);
  assert.equal(view(payload).getBigUint64(0, true), 7n, "the event");
  assert.equal(view(payload).getBigUint64(8, true), 11n, "the invitation");
  assert.equal(payload[16], CALENDAR_STATUS_ACCEPTED);
});

test("removing an event names it first and the moderator second", () => {
  const payload = buildCalendarRemoveEvent(7n, 9n, true);
  assert.equal(view(payload).getBigUint64(0, true), 7n);
  assert.equal(view(payload).getBigUint64(8, true), 9n);
  assert.equal(payload[16], 1);
});

test("copying an event carries the new day as a packed word", () => {
  const payload = buildCalendarCopyEvent(7n, 0n, DATE);
  assert.equal(view(payload).getUint32(16, true), DATE);
});

test("signing up is an event and one byte; inviting is an event, a moderator and a name", () => {
  assert.equal(buildCalendarSignUp(7n, true).length, 9);
  const invite = buildCalendarInvite(7n, 0n, "Анна", false, true);
  assert.equal(view(invite).getBigUint64(0, true), 7n);
  assert.equal(invite[invite.length - 2], 0, "creating");
  assert.equal(invite[invite.length - 1], 1, "isSignUp");
});

test("the three packets that name somebody else lead with a packed guid", () => {
  // `CalendarRemoveInvite`, `CalendarStatus` and `CalendarModeratorStatusQuery` all read the
  // target's guid packed and first, unlike the event ids behind them.
  for (const payload of [
    buildCalendarRemoveInvite(0x42n, 1n, 2n, 3n),
    buildCalendarEventStatus(0x42n, 1n, 2n, 3n, 4),
    buildCalendarModeratorStatus(0x42n, 1n, 2n, 3n, 4),
  ]) {
    assert.equal(payload[0], 0x01, "a mask byte selecting the lowest guid byte");
    assert.equal(payload[1], 0x42);
  }
});

test("the filters and the complaint are plain words", () => {
  assert.equal(buildCalendarGuildFilter(1, 80, 3).length, 12);
  assert.equal(buildCalendarArenaTeam(7).length, 4);
  assert.equal(buildCalendarComplain(1n, 2n, 3n).length, 24);
});

test("a guild bank withdrawal is the auto-store shape and a deposit is not", () => {
  // The auto-store branch hardcodes `toChar = 1` in the handler, so it can only ever withdraw;
  // depositing has to name the bag slot and write a zero where the direction is read.
  const out = buildGuildBankWithdrawItem(0x42n, 1, 5, 4306);
  assert.equal(out[8], 0, "BankOnly: never a tab-to-tab move");
  assert.equal(out[9], 1, "tab");
  assert.equal(out[10], 5, "slot");
  assert.equal(out[15], 1, "AutoStore");

  const into = buildGuildBankDepositItem(0x42n, 1, 5, 4306, 255, 23, 0);
  assert.equal(into[15], 0, "AutoStore off");
  assert.equal(into[16], 255, "the bag");
  assert.equal(into[17], 23, "the slot inside it");
  assert.equal(into[18], 0, "and a zero where the handler reads the direction");
});

test("guild bank money is copper in a single word", () => {
  const payload = buildGuildBankMoney(0x42n, 12345);
  assert.equal(payload.length, 12);
  assert.equal(view(payload).getUint32(8, true), 12345);
  assert.equal(buildGuildBankBuyTab(0x42n, 2).length, 9);
  assert.ok(buildGuildBankUpdateTab(0x42n, 2, "Руда", "icon").length > 9);
});
