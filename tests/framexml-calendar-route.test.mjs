import assert from "node:assert/strict";
import test from "node:test";
import { game } from "../dist/code/browser/game/Context.js";
import { packWowTime } from "../dist/code/world/CalendarProtocol.js";
import { usePanelHost } from "../dist/code/browser/ui/Widgets.js";
import {
  calendarOpen, closeCalendar, openCalendar, openNativeCalendar, refreshCalendar, resetCalendar, toggleCalendar,
} from "../dist/code/browser/ui/Calendar.js";
import {
  frameXmlCalendarOpen, frameXmlCalendarOwnsErrors, publishFrameXmlCalendar,
} from "../dist/code/browser/framexml/FrameXmlCalendarController.js";

// The native module's entry points (GameTimeFrame via the mount, `/calendar`, the game menu, the HUD
// button) ask the published stock owner first and keep the native Panel for when there is none.

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
    focus() {}, classList: { add() {}, remove() {}, toggle() {} },
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, width: 100, height: 100 }; },
  };
}
const body = node("body");
globalThis.document = { createElement: node, body, addEventListener() {}, removeEventListener() {} };
globalThis.window = { innerWidth: 1280, innerHeight: 720 };
usePanelHost({ viewport: body, attach() {} });

const NOW = packWowTime({ year: 2026, month: 9, day: 5, hour: 12, minute: 0 });

function world() {
  const calls = [];
  const current = {
    state: { selfGuid: 1n }, calendarPending: 0, calendarLockouts: new Map(), calendarEvent: undefined,
    calendar: { serverTime: NOW, serverNow: Date.now() / 1000, invites: [], events: [] },
    displayName: () => "Игрок", calls,
    requestCalendar: () => calls.push("requestCalendar"),
  };
  resetCalendar();
  game.world = current;
  return current;
}

/** A published stock owner: what the route asks of `createLazyFrameXmlCalendarOwner`. */
function owner() {
  const log = [];
  const value = {
    open: false, failed: false, log,
    isOpen: () => value.open,
    show: () => { log.push("show"); value.open = true; return true; },
    hide: () => { log.push("hide"); value.open = false; },
    dispose: () => { log.push("dispose"); },
  };
  return value;
}

test("with no stock owner published, every entry point is the native window's", () => {
  const current = world();
  toggleCalendar();
  assert.equal(calendarOpen(), true, "the toggle opened the native window");
  assert.deepEqual(current.calls, ["requestCalendar"], "the native window asked for the month");
  toggleCalendar();
  assert.equal(calendarOpen(), false);
  openCalendar();
  openCalendar();
  assert.equal(calendarOpen(), true, "open keeps it open instead of toggling");
  closeCalendar();
  assert.equal(calendarOpen(), false);
});

test("a published stock owner takes the toggle, open and close; the native window stays shut", () => {
  const current = world();
  const stock = owner();
  const unpublish = publishFrameXmlCalendar(stock);
  try {
    toggleCalendar();
    assert.deepEqual(stock.log, ["show"]);
    assert.equal(calendarOpen(), true, "the stock window counts as the calendar being open");
    assert.deepEqual(current.calls, [], "the native window did not open and did not query");
    toggleCalendar();
    assert.deepEqual(stock.log, ["show", "hide"]);
    assert.equal(calendarOpen(), false);
    openCalendar();
    openCalendar();
    assert.deepEqual(stock.log, ["show", "hide", "show", "show"]);
    closeCalendar();
    assert.equal(stock.open, false, "closeCalendar (Escape, the world teardown) closes the stock window");
    assert.deepEqual(current.calls, []);

    // The stock owner's fallback when its load or gate fails: the native window alone.
    openNativeCalendar();
    assert.deepEqual(current.calls, ["requestCalendar"]);
    assert.equal(stock.open, false);
    closeCalendar();
    assert.equal(calendarOpen(), false);

    // A failed owner answers false: the toggle falls back to the native window.
    stock.failed = true;
    toggleCalendar();
    assert.deepEqual(current.calls, ["requestCalendar", "requestCalendar"]);
    assert.equal(stock.log.filter((entry) => entry === "show").length, 3, "a failed owner is not asked to show");
    closeCalendar();
  } finally {
    unpublish();
  }
  assert.deepEqual(stock.log.at(-1), "dispose");
});

test("a native window opened before the stock owner was published steps aside: one calendar at a time", () => {
  world();
  const stock = owner();
  // The player opened the native window in the seconds before the world mount published the owner.
  openNativeCalendar();
  const unpublish = publishFrameXmlCalendar(stock);
  try {
    // The native Panel's own visibility: calendarOpen() while the stock window reports itself closed.
    const nativeVisible = () => {
      const open = stock.open;
      stock.open = false;
      try { return calendarOpen(); } finally { stock.open = open; }
    };
    assert.equal(nativeVisible(), true);
    assert.equal(frameXmlCalendarOpen(), false);
    // The toggle closes what the player sees rather than opening the stock window beneath it.
    toggleCalendar();
    assert.equal(calendarOpen(), false, "no window at all");
    assert.deepEqual(stock.log, []);
    toggleCalendar();
    assert.deepEqual(stock.log, ["show"], "the next press is the stock window's");
    assert.equal(nativeVisible(), false);
    closeCalendar();
    // Open (the game menu's «Календарь») hands over to the stock window.
    openNativeCalendar();
    openCalendar();
    assert.equal(stock.open, true);
    assert.equal(nativeVisible(), false, "the native window stepped aside");
    closeCalendar();
  } finally {
    unpublish();
  }
});

test("calendar errors are the loaded stock add-on's popup, not also the native notice", () => {
  const current = world();
  const failed = { text: "Событие уже прошло", error: true };
  // No stock owner, or one whose add-on has not loaded: EnterWorld's notice shows the message.
  current.calendarMessage = failed;
  refreshCalendar({ eventId: undefined, reason: "error" });
  assert.equal(current.calendarMessage, failed);
  const stock = owner();
  const unpublish = publishFrameXmlCalendar(stock);
  try {
    refreshCalendar({ eventId: undefined, reason: "error" });
    assert.equal(current.calendarMessage, failed, "published but not loaded: its popup is not there yet");
    // Loaded, gated and adopted: CalendarFrame_OnEvent raises CALENDAR_ERROR for this packet.
    stock.loaded = true;
    assert.equal(frameXmlCalendarOwnsErrors(), true);
    refreshCalendar({ eventId: undefined, reason: "error" });
    assert.equal(current.calendarMessage, undefined, "consumed before EnterWorld's notice reads it");
    // A failed owner hands the calendar back to the native window, errors included.
    stock.failed = true;
    current.calendarMessage = failed;
    refreshCalendar({ eventId: undefined, reason: "error" });
    assert.equal(current.calendarMessage, failed);
  } finally {
    unpublish();
  }
  assert.equal(frameXmlCalendarOwnsErrors(), false, "unpublished");
});
