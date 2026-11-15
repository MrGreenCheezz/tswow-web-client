import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Key bindings and window positions in the account data (WORK_PLAN 4.12): the envelope written into slot 2
// before 5.37 still read by the Unity client's strict rules, the switches, the size guard, and the window-layout
// slot. Since 5.37 slot 2 is written in Wow.exe's text (bindings-slot-sync.test.mjs, bindings-cache-text.test.mjs).
const account = await import("../dist/code/browser/input/BindingsAccount.js");
const sync = await import("../dist/code/browser/input/InputAccount.js");
const { BindingsSlotSync } = await import("../dist/code/browser/input/BindingsSlotSync.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");

const SAMPLE = readFileSync(new URL("./fixtures/wowclient-bindings.sample.json", import.meta.url), "utf8").trim();

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, String(value)) };
}

function fakeWorld(text) {
  const saves = [];
  const requested = [];
  const accountData = new Map(text === undefined ? [] : [[2, { text }]]);
  return {
    saves, requested, accountData,
    requestAccountData: (type) => requested.push(type),
    saveAccountData: (type, value) => { saves.push([type, value]); accountData.set(type, { text: value }); return Promise.resolve(); },
  };
}

function manualTimers() {
  const pending = new Set();
  return {
    pending,
    set: (run) => { const entry = { run }; pending.add(entry); return entry; },
    clear: (entry) => pending.delete(entry),
    runAll() { for (const entry of [...pending]) { pending.delete(entry); entry.run(); } },
  };
}

const host = { tables: bindings.bindingTables, apply: bindings.applyBindingTables, onChanged: bindings.onBindingsChanged };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the envelope of before 5.37 is read by the Unity client's strict rules", () => {
  const parsed = account.parseBindingsEnvelope(SAMPLE);
  assert.deepEqual(parsed.core.toggleContacts, ["KeyO", ""]);
  assert.deepEqual(parsed.modifiedClicks, {}, "modifiedClicks may be absent");
  const refused = [
    "{\"x\":1}", "not json", "[]", "BINDINGMODE 0\r\nbind W MOVEFORWARD\r\n",
    JSON.stringify({ format: "wowclient-bindings", version: 2, core: {}, modules: {} }),
    JSON.stringify({ format: "wowclient-bindings", version: 1, core: {}, modules: {}, extra: 1 }),
    JSON.stringify({ format: "wowclient-bindings", version: "1", core: {}, modules: {} }),
    JSON.stringify({ format: "wowclient-bindings", version: 1, core: { jump: ["Space"] }, modules: {} }),
    JSON.stringify({ format: "wowclient-bindings", version: 1, core: { jump: ["Space", 3] }, modules: {} }),
    JSON.stringify({ format: "wowclient-bindings", version: 1, core: { jump: ["x".repeat(129), ""] }, modules: {} }),
    JSON.stringify({ format: "wowclient-bindings", version: 1, core: {}, modules: {}, modifiedClicks: { SELFCAST: "META" } }),
    JSON.stringify({ format: "wowclient-bindings", version: 1, core: Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`a${i}`, ["", ""]])), modules: {} }),
  ];
  for (const text of refused) assert.equal(account.parseBindingsEnvelope(text), undefined, text.slice(0, 80));
});

test("off: nothing is asked for, applied or written", () => {
  bindings.useBindingStorage(memoryStorage());
  const world = fakeWorld(SAMPLE);
  const timers = manualTimers();
  const store = new BindingsSlotSync(host, { timers, enabled: () => false });
  store.attach(world);
  assert.deepEqual(world.requested, []);
  assert.equal(store.accept(2), false);
  assert.equal(store.accept(3), false);
  bindings.bindKey("jump", 0, "KeyZ");
  timers.runAll();
  assert.deepEqual(world.saves, []);
});

test("the switches are on unless set to off (owner, 12.10)", () => {
  const saved = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  try {
    const key = sync.INPUT_ACCOUNT_SYNC_KEYS.bindings;
    assert.equal(sync.accountSyncEnabled(key), true, "no switch set: on");
    values.set(key, "on");
    assert.equal(sync.accountSyncEnabled(key), true);
    values.set(key, "off");
    assert.equal(sync.accountSyncEnabled(key), false, "«off» turns it off");
    assert.equal(sync.accountSyncEnabled(sync.INPUT_ACCOUNT_SYNC_KEYS.layout), true, "each slot has its own switch");
    delete globalThis.localStorage;
    assert.equal(sync.accountSyncEnabled(key), false, "no store at all: off, nothing to merge the server's copy into");
  } finally {
    if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved;
  }
});

test("both binding slots are asked for", () => {
  bindings.useBindingStorage(memoryStorage());
  const world = fakeWorld(undefined);
  const store = new BindingsSlotSync(host, { timers: manualTimers(), enabled: () => true });
  store.attach(world);
  assert.deepEqual(world.requested, [2, 3]);
});

test("a text that would not fit is not sent", async () => {
  bindings.useBindingStorage(memoryStorage());
  const big = Array.from({ length: 2000 }, (_, i) => `bind JOYBUTTON${i} SOME_ADDON_COMMAND_NUMBER_${i}`.padEnd(60, "X")).join("\r\n");
  assert.ok(account.utf8Length(big) > account.ACCOUNT_DATA_WRITE_LIMIT);
  const world = fakeWorld(big);
  const timers = manualTimers();
  const store = new BindingsSlotSync(host, { timers, enabled: () => true });
  store.attach(world);
  store.accept(2);
  assert.equal(store.accept(3), true);
  bindings.bindKey("jump", 0, "KeyZ");
  timers.runAll();
  await settle();
  assert.deepEqual(world.saves, []);
});

test("review 15.11: slot 6 is asked for once — the page's layout store only listens, and its COMPLETE is not re-read", () => {
  let layout = { bags: { left: 1, top: 1 } };
  const applied = [];
  const layoutHost = { layout: () => layout, apply: (next) => applied.push(next), onChanged: () => {} };
  const world = { ...fakeWorld(undefined), accountData: new Map([[6, { text: sync.serialiseLayoutEnvelope({ a: { left: 1, top: 2 } }) }]]) };
  const store = new sync.LayoutAccountSync(layoutHost, { timers: manualTimers(), enabled: () => true });
  store.requestsSlot = false;
  store.attach(world);
  assert.deepEqual(world.requested, []);
  assert.equal(store.accept(6), true, "the answer the settings store asked for is taken");
  world.accountData.set(6, { text: sync.serialiseLayoutEnvelope({ a: { left: 9, top: 9 } }) });
  assert.equal(store.accept(6), false, "a later event is a write's COMPLETE");
  assert.equal(applied.length, 1);
});

test("5.37: the layout store reads and writes slot 6 with the settings beside the windows, and keeps them", async () => {
  const withSettings = sync.serialiseLayoutEnvelope({ bags: { left: 5, top: 5 } }, { renderScale: 70 });
  assert.deepEqual(sync.parseLayoutEnvelope(withSettings), { bags: { left: 5, top: 5 } });
  assert.equal(sync.parseLayoutEnvelope('{"format":"wowclient-layout","version":1,"windows":{},"other":1}'), undefined);
  let layout = { bags: { left: 1, top: 1 } };
  let listener;
  const layoutHost = { layout: () => layout, apply: () => {}, onChanged: (fn) => { listener = fn; } };
  const world = { ...fakeWorld(undefined), accountData: new Map([[6, { text: withSettings }]]) };
  const timers = manualTimers();
  const store = new sync.LayoutAccountSync(layoutHost, { timers, enabled: () => true });
  store.attach(world);
  assert.equal(store.accept(6), true);
  layout = { bags: { left: 30, top: 40 } };
  listener(layout);
  timers.runAll();
  await settle();
  const written = JSON.parse(world.saves.at(-1)[1]);
  assert.deepEqual(written.settings, { renderScale: 70 }, "the settings ride along");
  assert.deepEqual(written.windows, { bags: { left: 30, top: 40 } });
});

test("window positions: the layout envelope, foreign text left alone, a window moved meanwhile keeps its place", async () => {
  assert.deepEqual(sync.parseLayoutEnvelope(sync.serialiseLayoutEnvelope({ bags: { left: 10, top: 20 } })), { bags: { left: 10, top: 20 } });
  assert.deepEqual(sync.parseLayoutEnvelope('{"format":"wowclient-layout","version":1,"windows":{"a":{"left":"x","top":1},"b":{"left":1,"top":2}}}'),
    { b: { left: 1, top: 2 } }, "a placement that is not two numbers is dropped");
  assert.equal(sync.parseLayoutEnvelope("VERSION 5\nWorldMapFrame 0 0"), undefined, "the original client's layout text");
  let layout = { bags: { left: 1, top: 1 } };
  let listener;
  const applied = [];
  const layoutHost = {
    layout: () => layout,
    apply: (next) => { applied.push(next); layout = { ...layout, ...next }; },
    onChanged: (fn) => { listener = fn; },
  };
  const world = { ...fakeWorld(undefined), accountData: new Map() };
  const timers = manualTimers();
  const store = new sync.LayoutAccountSync(layoutHost, { timers, enabled: () => true });
  store.attach(world);
  assert.deepEqual(world.requested, [6]);
  layout = { bags: { left: 50, top: 60 } };
  listener(layout);
  world.accountData.set(6, { text: sync.serialiseLayoutEnvelope({ bags: { left: 5, top: 5 }, map: { left: 7, top: 8 } }) });
  assert.equal(store.accept(6), true);
  assert.deepEqual(applied.at(-1), { bags: { left: 50, top: 60 }, map: { left: 7, top: 8 } });
  timers.runAll();
  await settle();
  assert.equal(world.saves.at(-1)[0], 6);
  assert.deepEqual(sync.parseLayoutEnvelope(world.saves.at(-1)[1]), { bags: { left: 50, top: 60 }, map: { left: 7, top: 8 } });
  const foreignWorld = { ...fakeWorld(undefined), accountData: new Map([[6, { text: "VERSION 5\n" }]]) };
  const foreignStore = new sync.LayoutAccountSync(layoutHost, { timers: manualTimers(), enabled: () => true });
  foreignStore.attach(foreignWorld);
  assert.equal(foreignStore.accept(6), false);
  foreignStore.flush();
  assert.deepEqual(foreignWorld.saves, []);
});
