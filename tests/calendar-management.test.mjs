import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import { packWowTime, unpackWowTime } from "../dist/code/world/CalendarProtocol.js";
import { usePanelHost } from "../dist/code/browser/ui/Widgets.js";
import { toggleCalendar, refreshCalendar, resetCalendar } from "../dist/code/browser/ui/Calendar.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";

function node(tag) {
  const handlers = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, hidden: false, textContent: "",
    disabled: false, value: "", className: "", attributes: new Map(),
    append(...children) { for (const child of children) child.parentNode = this; this.children.push(...children); },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    setAttribute(key, value) { this.attributes.set(key, String(value)); },
    addEventListener(name, handler) { handlers.set(name, handler); },
    remove() { this.parentNode.children = this.parentNode.children.filter((child) => child !== this); },
    click() { if (!this.disabled) handlers.get("click")?.({ stopPropagation() {} }); },
    submit() { handlers.get("submit")?.({ preventDefault() {} }); },
    focus() {}, classList: { add() {}, remove() {}, toggle() {} },
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, width: 100, height: 100 }; },
  };
}
const body = node("body");
globalThis.document = { createElement: node, body, addEventListener() {}, removeEventListener() {} };
globalThis.window = { innerWidth: 1280, innerHeight: 720 };
usePanelHost({ viewport: body, attach() {} });
const all = (root) => [root, ...root.children.flatMap(all)];
const text = (root) => root.textContent + root.children.map(text).join(" ");
const button = (label) => {
  const found = all(body).find((item) => item.tagName === "BUTTON" && item.textContent === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
};
const field = (name) => {
  const found = all(body).find((item) => item.name === name);
  assert.ok(found, `Missing field: ${name}`);
  return found;
};
const NOW = packWowTime({ year: 2026, month: 9, day: 5, hour: 12, minute: 0 });
const FUTURE = packWowTime({ year: 2026, month: 9, day: 6, hour: 15, minute: 30 });
const detail = () => ({
  sendType: 0, eventId: 41n, ownerGuid: 1n, name: "Рейд", description: "Встреча", eventType: 0,
  date: FUTURE, maxInvites: 25, flags: 0x10, lockDate: 1234, textureId: 7,
  invites: [{ guid: 1n, inviteId: 71n, status: 1, moderator: 2 }],
});
function world(event) {
  const calls = [];
  const current = {
    state: { selfGuid: 1n }, calendarPending: 0, calendarLockouts: new Map(), calendarEvent: event,
    calendar: { serverTime: NOW, serverNow: Date.now() / 1000, invites: [], events: event ? [event] : [] },
    displayName: () => "Игрок", calls,
  };
  for (const name of ["requestCalendar", "requestCalendarEvent", "addCalendarEvent", "updateCalendarEvent", "copyCalendarEvent", "inviteToCalendarEvent", "answerCalendarInvite", "signUpForCalendarEvent"])
    current[name] = (...args) => calls.push([name, ...args]);
  resetCalendar();
  game.world = current;
  toggleCalendar();
  return current;
}

test("calendar snapshot, pending-count and event replies cannot feed a refresh request loop", () => {
  const current = world(detail());
  const before = current.calls.length;
  for (const reason of ["snapshot", "pending", "event", "snapshot", "pending"]) refreshCalendar({ reason, eventId: undefined });
  assert.equal(current.calls.length, before, "replies only redraw; they must not request their own next reply");
  refreshCalendar({ reason: "alert", eventId: 41n });
  assert.equal(current.calls.filter(([name]) => name === "requestCalendar").length, 2);
});

test("calendar creates a validated event and retains the draft until its server response", () => {
  const current = world();
  button("Создать событие").click();
  field("title").value = " Новый рейд ";
  field("date").value = "2026-02-30T15:30";
  field("title").parentNode.parentNode.submit();
  assert.equal(current.calls.some(([name]) => name === "addCalendarEvent"), false);
  field("date").value = "2026-09-04T15:30";
  field("title").parentNode.parentNode.submit();
  assert.equal(current.calls.some(([name]) => name === "addCalendarEvent"), false);
  field("date").value = "2026-09-06T15:30";
  field("title").parentNode.parentNode.submit();
  const sent = current.calls.find(([name]) => name === "addCalendarEvent");
  assert.ok(sent);
  assert.equal(sent[1].title, "Новый рейд");
  assert.deepEqual(sent[2], [{ guid: 1n, status: 1, moderator: 2 }], "the creator has their own owner invitation");
  assert.deepEqual(unpackWowTime(sent[1].time), { year: 2026, month: 9, day: 6, hour: 15, minute: 30 });
  assert.equal(field("title").value, " Новый рейд ", "draft is retained while waiting");
  field("title").parentNode.parentNode.submit();
  assert.equal(current.calls.filter(([name]) => name === "addCalendarEvent").length, 1, "no duplicate submit");
  current.calendarMessage = { text: "Слишком много событий", error: true };
  refreshCalendar({ reason: "error", eventId: undefined });
  assert.match(text(body), /Слишком много событий/);
  assert.equal(field("title").value, " Новый рейд ", "server rejection preserves the draft");
  field("title").parentNode.parentNode.submit();
  current.calendarEvent = { ...detail(), sendType: 1, eventId: 52n, name: "Новый рейд" };
  refreshCalendar({ reason: "event", eventId: 52n });
  assert.equal(all(body).some((item) => item.name === "title"), false, "the acknowledged draft closes");
  assert.match(text(body), /Событие сохранено/);
  assert.equal(current.calls.filter(([name]) => name === "addCalendarEvent").length, 2);
});

test("calendar editing and copying require the current owner and preserve hidden event fields", () => {
  const event = detail();
  const current = world(event);
  button("Изменить").click();
  field("title").value = "Обновлённый рейд";
  field("title").parentNode.parentNode.submit();
  const sent = current.calls.find(([name]) => name === "updateCalendarEvent");
  assert.equal(sent?.[1], 41n);
  assert.equal(sent?.[2], 71n);
  assert.equal(sent?.[3].flags, 0x10);
  assert.equal(sent?.[3].textureId, 7);
  assert.equal(sent?.[3].lockDate, 1234);
  current.calendarEvent = { ...event, name: "Обновлённый рейд" };
  refreshCalendar({ reason: "event", eventId: 41n });
  button("Копировать").click();
  field("date").value = "2026-09-07T15:30";
  field("date").parentNode.parentNode.submit();
  assert.equal(current.calls.find(([name]) => name === "copyCalendarEvent")?.[1], 41n);
  resetCalendar();
  const other = world({ ...detail(), ownerGuid: 2n });
  assert.equal(all(body).some((item) => item.tagName === "BUTTON" && item.textContent === "Изменить"), false);
  assert.equal(other.calls.some(([name]) => name === "updateCalendarEvent"), false);
});

test("calendar invitations validate a name and stale owner forms cannot send", () => {
  const current = world(detail());
  field("inviteName").value = "  ";
  field("inviteName").parentNode.submit();
  assert.equal(current.calls.some(([name]) => name === "inviteToCalendarEvent"), false);
  field("inviteName").value = " Анна ";
  field("inviteName").parentNode.submit();
  assert.deepEqual(current.calls.find(([name]) => name === "inviteToCalendarEvent"), ["inviteToCalendarEvent", 41n, "Анна", 71n]);
  resetCalendar();
  world(detail());
  button("Изменить").click();
  const oldForm = field("title").parentNode.parentNode;
  game.world.calendarEvent = { ...detail(), ownerGuid: 2n };
  oldForm.submit();
  assert.equal(game.world.calls.some(([name]) => name === "updateCalendarEvent"), false);
});

test("the real calendar packet handler distinguishes replies from invalidation alerts", async () => {
  const queue = [];
  let wake;
  const transport = {
    sent: [],
    send(opcode, payload) { this.sent.push({ opcode, payload }); },
    read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => { wake = resolve; }); },
    close() {},
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (wake) { const deliver = wake; wake = undefined; deliver(packet); } else queue.push(packet);
    },
  };
  const settle = async () => { for (let index = 0; index < 6; index++) await new Promise(setImmediate); };
  const current = new WorldClient(transport);
  const errors = [];
  current.onWorldError = (error) => errors.push(error.message);
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await current.loginCharacter(1n);
  resetCalendar();
  game.world = current;
  const changes = [];
  current.events.on("CALENDAR_CHANGED", (change) => { changes.push(change.reason); refreshCalendar(change); });
  try {
    toggleCalendar();
    const countQueries = () => transport.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_CALENDAR_GET_CALENDAR).length;
    assert.equal(countQueries(), 1);
    for (let index = 0; index < 3; index++) {
      transport.push(OPCODES.SMSG_CALENDAR_SEND_CALENDAR, new PacketWriter().u32(0).u32(0)
        .u32(1_789_200_000).u32(NOW).u32(0).u32(0).u32(0).u32(0).toUint8Array());
      transport.push(OPCODES.SMSG_CALENDAR_SEND_NUM_PENDING, new PacketWriter().u32(0).toUint8Array());
    }
    await settle();
    assert.deepEqual(errors, []);
    assert.deepEqual(changes, ["snapshot", "pending", "snapshot", "pending", "snapshot", "pending"]);
    assert.equal(countQueries(), 1, "wire replies do not start a new round of calendar queries");
    transport.push(OPCODES.SMSG_CALENDAR_COMMAND_RESULT,
      new PacketWriter().u32(1).cString("").cString("Анна").u32(11).toUint8Array());
    await settle();
    assert.equal(changes.at(-1), "error");
    assert.match(text(body), /Анна/);
    assert.equal(countQueries(), 1, "server errors cannot restart the query loop either");
  } finally {
    resetCalendar();
    current.close();
    game.world = undefined;
  }
});
