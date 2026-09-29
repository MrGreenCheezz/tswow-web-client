import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import { packWowTime } from "../dist/code/world/CalendarProtocol.js";
import { LiveFrameXmlCalendar } from "../dist/code/browser/framexml/FrameXmlCalendar.js";
import { FRAMEXML_CALENDAR_UI_BINDINGS as B, FRAMEXML_CALENDAR_UI_EVENTS } from "../dist/code/browser/framexml/FrameXmlCalendarModel.js";

// The live calendar: a real WorldClient fed calendar packets in TrinityCore's layouts
// (CalendarPackets.cpp, as CalendarProtocol.ts parses them), its CALENDAR_PACKET beside the native
// CALENDAR_CHANGED, the stock model's answers, and the opcodes the model's commands put on the wire.

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

const SELF = 0x1234n;
const TRALL = 0x55n;
const packed = (year, month, day, hour = 0, minute = 0) => packWowTime({ year, month, day, hour, minute });

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.selfName = "Игрок";
  // SMSG_UPDATE_OBJECT's self flag names the player; the fake login stops short of it.
  client.state.selfGuid = SELF;
  return { client, connection };
}

/**
 * CalendarSendCalendar::Write: invites, events, two clocks, lockouts, the raid origin, resets, holidays.
 * One event and the player's invitation to it (INVITED: the core counts it as pending).
 */
function sendCalendar({ eventId = 41n, name = "Наксрамас", day = 18 } = {}) {
  const writer = new PacketWriter();
  writer.u32(1).u64(eventId).u64(900n).u8(0).u8(0).u8(0).packedGuid(TRALL);
  writer.u32(1).u64(eventId).cString(name).u32(0).u32(packed(2026, 9, day, 19, 30)).u32(0).i32(227).packedGuid(TRALL);
  writer.u32(1_789_000_000).u32(packed(2026, 9, 15, 10));
  writer.u32(1).i32(533).u32(1).i32(4 * 86_400).u64(42n);
  writer.u32(1_135_753_200);
  writer.u32(0);
  writer.u32(0);
  return writer.toUint8Array();
}

/** CalendarSendEvent::Write for event 41 as the invitee sees it. */
function sendEvent(sendType = 0) {
  const writer = new PacketWriter()
    .u8(sendType).packedGuid(TRALL).u64(41n).cString("Наксрамас").cString("Сбор в 19:15").u8(0).u8(0).u32(25).i32(227)
    .u32(0).u32(packed(2026, 9, 18, 19, 30)).u32(0).u32(0).u32(2);
  writer.packedGuid(TRALL).u8(80).u8(3).u8(2).u8(0).u64(899n).u32(packed(2026, 9, 10, 12)).cString("");
  writer.packedGuid(SELF).u8(80).u8(0).u8(0).u8(0).u64(900n).u32(0).cString("");
  return writer.toUint8Array();
}

function live() {
  let world;
  const fired = [];
  let clock = 1000;
  const calendar = new LiveFrameXmlCalendar(() => world, () => clock);
  const seam = { calendar };
  const call = (name, ...args) => B[name](seam, args);
  return {
    calendar, fired, call,
    set world(value) { world = value; },
    advance(ms) { clock += ms; },
    attach() { calendar.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; } }); },
  };
}

const sent = (connection, opcode) => connection.sent.filter((packet) => packet.opcode === opcode);

test("snapshot, open, RSVP, status and the pending latch over WorldClient's CALENDAR_PACKET", async () => {
  const { client, connection } = await loggedIn();
  const host = live();
  host.world = client;
  const changed = [];
  const packets = [];
  client.events.on("CALENDAR_CHANGED", (change) => changed.push(change.reason));
  client.events.on("CALENDAR_PACKET", (packet) => packets.push(packet.kind));
  host.attach();
  // GameTime's once-per-world query (CMSG_CALENDAR_GET_CALENDAR + GET_NUM_PENDING) is the model's feed too.
  assert.equal(sent(connection, OPCODES.CMSG_CALENDAR_GET_CALENDAR).length, 1);
  connection.push(OPCODES.SMSG_CALENDAR_SEND_CALENDAR, sendCalendar());
  connection.push(OPCODES.SMSG_CALENDAR_SEND_NUM_PENDING, new PacketWriter().u32(1).toUint8Array());
  await settle();
  assert.deepEqual(changed, ["snapshot", "pending"], "the native window's events are unchanged");
  assert.deepEqual(packets, ["snapshot", "pending"]);
  assert.ok(host.fired.some(([event]) => event === FRAMEXML_CALENDAR_UI_EVENTS.eventList));
  // The realm's day comes from the snapshot's clock here (no login clock in this fake session).
  assert.deepEqual(host.call("CalendarGetMonth"), [9, 2026, 30, 3]);
  assert.deepEqual(host.call("CalendarGetNumDayEvents", 0, 18), [1]);
  const row = host.call("CalendarGetDayEvent", 0, 18, 1);
  assert.deepEqual(row.slice(0, 9), ["Наксрамас", 19, 30, "PLAYER", "", 1, "", "", 1]);
  assert.equal(row[9], "", "the inviter's name is not known yet");
  assert.ok(sent(connection, OPCODES.CMSG_NAME_QUERY).length >= 1, "WorldClient asked for it");
  connection.push(OPCODES.SMSG_NAME_QUERY_RESPONSE, new PacketWriter().packedGuid(TRALL).u8(0).cString("Тралл").cString("")
    .u8(2).u8(0).u8(7).u8(0).toUint8Array());
  await settle();
  assert.equal(host.call("CalendarGetDayEvent", 0, 18, 1)[9], "Тралл");
  // The lockout: 4 days after 10:00 on the 15th.
  assert.deepEqual(host.call("CalendarGetDayEvent", 0, 19, 1).slice(1, 4), [10, 0, "RAID_LOCKOUT"]);
  // A second invitation arrives (CalendarInviteAlert::Write): two wait for an answer.
  connection.push(OPCODES.SMSG_CALENDAR_EVENT_INVITE_ALERT, new PacketWriter().u64(44n).cString("Ульдуар")
    .u32(packed(2026, 9, 25, 20)).u32(0).u32(0).i32(-1).u64(944n).u8(0).u8(0).packedGuid(TRALL).packedGuid(TRALL).toUint8Array());
  await settle();
  host.calendar.tick();
  assert.equal(host.calendar.pendingInvites(), 2);
  // CalendarOpenEvent → CMSG_CALENDAR_GET_EVENT(41); the detail → CALENDAR_OPEN_EVENT.
  host.call("CalendarOpenEvent", 0, 18, 1);
  const query = sent(connection, OPCODES.CMSG_CALENDAR_GET_EVENT).at(-1);
  assert.equal(new PacketReader(query.payload).u64(), 41n);
  connection.push(OPCODES.SMSG_CALENDAR_SEND_EVENT, sendEvent());
  await settle();
  assert.deepEqual(host.fired.filter(([event]) => event === FRAMEXML_CALENDAR_UI_EVENTS.openEvent), [[FRAMEXML_CALENDAR_UI_EVENTS.openEvent, "PLAYER"]]);
  assert.deepEqual(host.call("CalendarGetEventInfo").slice(0, 3), ["Наксрамас", "Сбор в 19:15", "Тралл"]);
  assert.deepEqual(host.call("CalendarEventGetInvite", 1).slice(0, 6), ["Тралл", 80, "", "", 4, "CREATOR"],
    "the class is not in WorldClient's name cache (a cross-lane gap), so it answers empty, never nil");
  // Accept: CMSG_CALENDAR_EVENT_RSVP(event 41, invite 900, ACCEPTED) and the latch.
  host.call("CalendarEventAvailable");
  const rsvp = new PacketReader(sent(connection, OPCODES.CMSG_CALENDAR_EVENT_RSVP).at(-1).payload);
  assert.deepEqual([rsvp.u64(), rsvp.u64(), rsvp.u8()], [41n, 900n, 1]);
  assert.deepEqual(host.fired.at(-1), [FRAMEXML_CALENDAR_UI_EVENTS.actionPending, true]);
  // CalendarMgr::SendCalendarEventStatus, then SendCalendarClearPendingAction.
  const answered = host.fired.length;
  connection.push(OPCODES.SMSG_CALENDAR_EVENT_STATUS, new PacketWriter().packedGuid(SELF).u64(41n).u32(packed(2026, 9, 18, 19, 30))
    .u32(0).u8(1).u8(1).u32(packed(2026, 9, 15, 10, 1)).toUint8Array());
  connection.push(OPCODES.SMSG_CALENDAR_CLEAR_PENDING_ACTION);
  await settle();
  assert.equal(host.call("CalendarEventGetInvite", 2)[4], 2, "accepted in the open roster");
  assert.deepEqual(host.call("CalendarEventGetInviteResponseTime", 2), [3, 9, 15, 2026, 10, 1]);
  assert.equal(host.call("CalendarGetDayEvent", 0, 18, 1)[8], 2, "and on the grid");
  assert.equal(host.call("CalendarIsActionPending")[0], undefined);
  assert.deepEqual(host.fired.filter(([event]) => event === FRAMEXML_CALENDAR_UI_EVENTS.actionPending).at(-1), [FRAMEXML_CALENDAR_UI_EVENTS.actionPending, false]);
  // HandleCalendarEventRsvp sends no NUM_PENDING, and WorldClient zeroes its own count on the
  // CLEAR_PENDING_ACTION that answers any command; GameTime's badge still counts the other invitation.
  assert.equal(client.calendarPending, 0);
  host.calendar.tick();
  assert.equal(host.calendar.pendingInvites(), 1);
  assert.ok(host.fired.slice(answered).some(([event]) => event === "CALENDAR_UPDATE_PENDING_INVITES"),
    "GameTime was told to re-read the count");
  // A command result error reaches CALENDAR_UPDATE_ERROR (native wording without the VM's strings).
  connection.push(OPCODES.SMSG_CALENDAR_COMMAND_RESULT, new PacketWriter().u32(1).cString("").cString("").u32(20).toUint8Array());
  await settle();
  assert.deepEqual(host.fired.at(-1), [FRAMEXML_CALENDAR_UI_EVENTS.error, "Событие уже прошло"]);
  // The event is removed while open.
  connection.push(OPCODES.SMSG_CALENDAR_EVENT_REMOVED_ALERT, new PacketWriter().u8(1).u64(41n).u32(packed(2026, 9, 18, 19, 30)).toUint8Array());
  await settle();
  assert.deepEqual(host.fired.at(-1), [FRAMEXML_CALENDAR_UI_EVENTS.closeEvent]);
  assert.deepEqual(host.call("CalendarGetNumDayEvents", 0, 18), [0]);
  host.calendar.detach();
});

test("a new event's pre-invite and CMSG_CALENDAR_ADD_EVENT on the wire; a world replacement drops the old feed and rows", async () => {
  const { client, connection } = await loggedIn();
  const host = live();
  host.world = client;
  host.attach();
  connection.push(OPCODES.SMSG_CALENDAR_SEND_CALENDAR, sendCalendar());
  await settle();
  host.call("CalendarNewEvent");
  host.call("CalendarEventSetTitle", "Копи");
  host.call("CalendarEventSetDate", 9, 20, 2026);
  host.call("CalendarEventSetTime", 18, 30);
  host.call("CalendarEventInvite", "Тралл");
  // HandleCalendarEventInvite with Creating: event 0, moderator 0, the name, creating 1, not a sign-up.
  const invite = new PacketReader(sent(connection, OPCODES.CMSG_CALENDAR_EVENT_INVITE).at(-1).payload);
  assert.deepEqual([invite.u64(), invite.u64(), invite.cString(), invite.u8(), invite.u8()], [0n, 0n, "Тралл", 1, 0]);
  // SendCalendarEventInvite's pre-invite answer: event 0, invite 0, the level, INVITED, no response time.
  connection.push(OPCODES.SMSG_CALENDAR_EVENT_INVITE, new PacketWriter().packedGuid(TRALL).u64(0n).u64(0n).u8(80).u8(0).u8(0).u8(1).toUint8Array());
  await settle();
  assert.deepEqual(host.call("CalendarEventGetNumInvites"), [2]);
  host.advance(5_000);
  host.call("CalendarAddEvent");
  const add = new PacketReader(sent(connection, OPCODES.CMSG_CALENDAR_ADD_EVENT).at(-1).payload);
  const fields = [add.cString(), add.cString(), add.u8(), add.u8(), add.u32(), add.i32(), add.u32(), add.u32(), add.u32()];
  assert.deepEqual(fields, ["Копи", "", 4, 0, 100, -1, packed(2026, 9, 20, 18, 30), 0, 0]);
  const count = add.u32();
  const invites = [];
  for (let index = 0; index < count; index++) invites.push([add.packedGuid(), add.u8(), add.u8()]);
  assert.deepEqual(invites, [[SELF, 1, 2], [TRALL, 0, 0]], "the creator (accepted, owner) and the checked name");
  // A second session's world that already holds its snapshot (its answer arrived before the switch):
  // the switch folds it with no packet of its own, and the first world's rows are gone.
  const second = await loggedIn();
  second.connection.push(OPCODES.SMSG_CALENDAR_SEND_CALENDAR, sendCalendar({ eventId: 43n, name: "Ульдуар", day: 22 }));
  await settle();
  assert.ok(second.client.calendar, "the second world holds its snapshot");
  host.world = second.client;
  host.calendar.tick();
  assert.deepEqual(host.call("CalendarGetNumDayEvents", 0, 22), [1], "the held snapshot, folded at the switch");
  assert.equal(host.call("CalendarGetDayEvent", 0, 22, 1)[0], "Ульдуар");
  assert.deepEqual(host.call("CalendarGetNumDayEvents", 0, 18), [0]);
  assert.equal(host.calendar.pendingInvites(), 1, "its invitation");
  // The first world's CALENDAR_PACKET no longer reaches the model.
  const before = host.fired.length;
  connection.push(OPCODES.SMSG_CALENDAR_SEND_CALENDAR, sendCalendar());
  await settle();
  assert.equal(host.fired.filter(([event], index) => index >= before && event === FRAMEXML_CALENDAR_UI_EVENTS.eventList).length, 0);
  assert.deepEqual(host.call("CalendarGetNumDayEvents", 0, 18), [0]);
  // A third world holding nothing yet: the second world's rows and count do not stand in for its own.
  const third = await loggedIn();
  host.world = third.client;
  host.calendar.tick();
  assert.deepEqual(host.call("CalendarGetNumDayEvents", 0, 22), [0], "forgotten at the switch");
  assert.equal(host.calendar.pendingInvites(), 0, "WorldClient's own count until this world's snapshot");
  const answered = host.fired.length;
  third.connection.push(OPCODES.SMSG_CALENDAR_SEND_CALENDAR, sendCalendar());
  await settle();
  assert.ok(host.fired.slice(answered).some(([event]) => event === FRAMEXML_CALENDAR_UI_EVENTS.eventList));
  assert.deepEqual(host.call("CalendarGetNumDayEvents", 0, 18), [1]);
  host.calendar.detach();
});
