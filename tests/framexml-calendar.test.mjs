import assert from "node:assert/strict";
import test from "node:test";

import { advanceGameTime, parseLoginSetTimeSpeed } from "../dist/code/world/GameTimeProtocol.js";
import { packWowTime } from "../dist/code/world/CalendarProtocol.js";
import {
  FRAMEXML_CALENDAR_BINDINGS, FRAMEXML_CALENDAR_EVENTS,
  LiveFrameXmlCalendar, LocalFrameXmlCalendar,
} from "../dist/code/browser/framexml/FrameXmlCalendar.js";
import { GlueLuaVm } from "../dist/code/browser/glue/GlueLua.js";

function loginTime({ year = 24, month = 1, day = 27, weekday = 3,
  hour = 23, minute = 59, speed = 1 } = {}) {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setUint32(0, (year << 24) | (month << 20) | (day << 14)
    | (weekday << 11) | (hour << 6) | minute, true);
  view.setFloat32(4, speed, true);
  return parseLoginSetTimeSpeed(payload);
}

function fakeWorld(start = loginTime()) {
  const handlers = new Set();
  // The stock calendar model's own feed (FrameXmlCalendarLive.ts): one subscription per attached world.
  const packetHandlers = new Set();
  const world = {
    calendar: undefined,
    calendarPending: 0,
    requests: 0,
    currentGameTime(now) { return advanceGameTime(start, (now - 1000) / 1000); },
    requestCalendar() { world.requests += 1; },
    events: { on(name, callback) {
      assert.ok(name === "CALENDAR_CHANGED" || name === "CALENDAR_PACKET", name);
      const set = name === "CALENDAR_CHANGED" ? handlers : packetHandlers;
      set.add(callback);
      return () => set.delete(callback);
    } },
    emit(reason) { for (const callback of [...handlers]) callback({ reason }); },
    get handlerCount() { return handlers.size; },
    get packetHandlerCount() { return packetHandlers.size; },
  };
  return world;
}

test("realm date follows the login clock while server pending updates reach stock GameTime", () => {
  let now = 1000;
  let world = fakeWorld();
  const fired = [];
  const calendar = new LiveFrameXmlCalendar(() => world, () => now);
  calendar.attach({ fire(event) { fired.push(event); return 1; } });
  assert.equal(world.requests, 1, "GameTime asks the server once even before CalendarFrame opens");
  assert.equal(world.handlerCount, 1);
  assert.equal(world.packetHandlerCount, 1, "the stock window's model follows the same world");
  assert.deepEqual(FRAMEXML_CALENDAR_BINDINGS.CalendarGetDate(calendar), [4, 2, 28, 2024]);
  assert.deepEqual(FRAMEXML_CALENDAR_BINDINGS.CalendarGetNumPendingInvites(calendar), [0]);

  now += 120_000;
  assert.deepEqual(calendar.date(), [5, 2, 29, 2024], "the day changes at realm midnight");
  world.calendarPending = 2;
  world.emit("pending");
  assert.equal(fired.at(-1), FRAMEXML_CALENDAR_EVENTS.pendingInvites);
  assert.deepEqual(FRAMEXML_CALENDAR_BINDINGS.CalendarGetNumPendingInvites(calendar), [2]);
  const before = fired.length;
  world.emit("snapshot");
  assert.equal(fired.length, before, "an unrelated calendar change does not flash the badge");
  world.emit("pending");
  assert.equal(fired.length, before + 1,
    "the authoritative server reply wakes GameTime even when the cached count agrees");
  world.calendarPending = 0;
  world.emit("complete");
  assert.equal(fired.length, before + 2, "clearing invitations wakes GameTime");

  const old = world;
  world = fakeWorld(loginTime({ year: 26, month: 8, day: 23, weekday: 4, hour: 8, minute: 0 }));
  calendar.tick();
  assert.equal(old.handlerCount, 0);
  assert.equal(old.packetHandlerCount, 0, "the replaced world's packet feed is dropped");
  assert.equal(world.packetHandlerCount, 1);
  assert.equal(world.requests, 1);
  assert.equal(world.handlerCount, 1);
  calendar.tick();
  assert.equal(world.requests, 1, "a render tick does not spam calendar requests");
  calendar.detach();
  assert.equal(world.handlerCount, 0);
  assert.equal(world.packetHandlerCount, 0);
});

test("a calendar snapshot supplies a dated fallback; an undated live realm stays unknown", () => {
  let now = 1000;
  const world = fakeWorld();
  world.currentGameTime = () => undefined;
  const calendar = new LiveFrameXmlCalendar(() => world, () => now);
  calendar.attach({ fire: () => 1 });
  assert.deepEqual(FRAMEXML_CALENDAR_BINDINGS.CalendarGetDate(calendar), []);
  world.calendar = { serverTime: packWowTime({
    year: 2024, month: 2, day: 28, hour: 23, minute: 59,
  }) };
  world.emit("snapshot");
  assert.deepEqual(calendar.date(), [4, 2, 28, 2024]);
  now += 120_000;
  assert.deepEqual(calendar.date(), [5, 2, 29, 2024]);
  world.calendar = { serverTime: (31 << 24) | (15 << 20) | (63 << 14) };
  world.emit("snapshot");
  assert.deepEqual(FRAMEXML_CALENDAR_BINDINGS.CalendarGetDate(calendar), [],
    "unknown WowTime fields cannot become a fabricated date");
  calendar.detach();

  const localDate = new Date(2026, 8, 24, 12);
  const offline = new LocalFrameXmlCalendar(() => localDate);
  assert.deepEqual(offline.date(), [localDate.getDay() + 1, 9, 24, 2026]);
  assert.deepEqual(FRAMEXML_CALENDAR_BINDINGS.CalendarGetNumPendingInvites(offline), [0]);
  assert.deepEqual(FRAMEXML_CALENDAR_BINDINGS.CalendarGetDate(undefined), []);
});

test("original 3.3.5a MPQ GameTime.lua reads realm day and pending badge", async (t) => {
  let client;
  try {
    const { clientDirectory } = await import("../tools/paths.mjs");
    client = clientDirectory();
  } catch {
    t.skip("no local 3.3.5a client");
    return;
  }
  const { openClientArchives } = await import("../tools/mpq.mjs");
  const chain = await openClientArchives(client);
  const vm = new GlueLuaVm();
  try {
    const bytes = await chain.read("Interface\\FrameXML\\GameTime.lua");
    assert.ok(bytes, "stock GameTime.lua is present in the client archive chain");
    const source = new TextDecoder().decode(bytes);
    assert.match(source, /local CalendarGetDate = CalendarGetDate;/,
      "the C binding must exist before stock Lua captures it");
    const world = fakeWorld();
    const calendar = new LiveFrameXmlCalendar(() => world, () => 1000);
    vm.registerGlobal("CalendarGetDate", () => FRAMEXML_CALENDAR_BINDINGS.CalendarGetDate(calendar));
    vm.registerGlobal("CalendarGetNumPendingInvites",
      () => FRAMEXML_CALENDAR_BINDINGS.CalendarGetNumPendingInvites(calendar));
    const fixture = vm.execute(`
      PI = math.pi
      GameTimeFrame = { pendingCalendarInvites = 0,
        SetText = function(self, text) __stockCalendarDay = text end }
      GameTimeCalendarInvitesTexture = {
        Show = function() __stockInviteVisible = true end,
        Hide = function() __stockInviteVisible = false end }
      GameTimeCalendarInvitesGlow = {
        Show = function() __stockGlowVisible = true end,
        Hide = function() __stockGlowVisible = false end }
    `, "@calendar:fixture");
    assert.equal(fixture.ok, true, fixture.error);
    const loaded = vm.execute(source, "@Interface/FrameXML/GameTime.lua");
    assert.equal(loaded.ok, true, loaded.error);
    vm.registerGlobal("CalendarGetDate", () => [0, 0, 0, 0]);
    assert.equal(vm.execute("GameTimeFrame_SetDate()", "@calendar:date").ok, true);
    assert.equal(vm.getGlobal("__stockCalendarDay"), 28,
      "stock Lua retained the real C binding when its chunk was loaded");

    calendar.attach({ fire(event) {
      const dispatched = vm.execute(`GameTimeFrame_OnEvent(GameTimeFrame, "${event}")`,
        "@calendar:event");
      assert.equal(dispatched.ok, true, dispatched.error);
      return 1;
    } });
    assert.equal(world.requests, 1);

    world.calendarPending = 2;
    world.emit("pending");
    assert.equal(vm.getGlobal("__stockInviteVisible"), true);
    assert.equal(vm.getGlobal("__stockGlowVisible"), true);
    world.calendarPending = 0;
    world.emit("pending");
    assert.equal(vm.getGlobal("__stockInviteVisible"), false);
    assert.equal(vm.getGlobal("__stockGlowVisible"), false);
    calendar.detach();
  } finally {
    vm.close();
    await chain.close();
  }
});
