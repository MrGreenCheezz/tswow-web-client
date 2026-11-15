import assert from "node:assert/strict";
import test from "node:test";

// Review of 4.12 (02.10): a slot is written only after the server has answered for it. Slots 2/3 are
// Wow.exe's bindings caches (5.37: written in its text since 15.11), slot 6 Wow.exe's layout cache; a
// binding changed (a SetBinding from an add-on's load, a key set by hand) or a window dragged while the
// answer is still travelling — the FrameXML mount holds the main thread for seconds at world entry — used
// to be written after 1.5 s, or on leaving the world, over whatever the slot held.
const sync = await import("../dist/code/browser/input/InputAccount.js");
const { BindingsSlotSync } = await import("../dist/code/browser/input/BindingsSlotSync.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");

const WOW = "BINDINGMODE 0\r\nbind W MOVEFORWARD\r\nbind BUTTON4 TOGGLEAUTORUN\r\n";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, String(value)) };
}

function fakeWorld(slot, text) {
  const saves = [];
  const accountData = new Map();
  return {
    saves, accountData,
    answer() { if (text !== undefined) accountData.set(slot, { text }); },
    requestAccountData() {},
    saveAccountData: (type, value) => { saves.push([type, value]); accountData.set(type, { text: value }); return Promise.resolve(); },
  };
}

function manualTimers() {
  const pending = new Set();
  return {
    set: (run) => { const entry = { run }; pending.add(entry); return entry; },
    clear: (entry) => pending.delete(entry),
    runAll() { for (const entry of [...pending]) { pending.delete(entry); entry.run(); } },
  };
}

const host = { tables: bindings.bindingTables, apply: bindings.applyBindingTables, onChanged: bindings.onBindingsChanged };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("slots 2/3: nothing is written before the answers, leaving the world before them included", async () => {
  bindings.useBindingStorage(memoryStorage());
  const world = fakeWorld(2, WOW);
  const timers = manualTimers();
  const store = new BindingsSlotSync(host, { timers, enabled: () => true });
  store.attach(world);
  bindings.bindKey("jump", 0, "KeyZ");
  timers.runAll();
  store.detach();
  await settle();
  assert.deepEqual(world.saves, [], "a change made while the answer travels waits for it");
});

test("slots 2/3: a change made before the answer is laid over it and written with the original's lines", async () => {
  bindings.useBindingStorage(memoryStorage());
  const world = fakeWorld(2, WOW);
  const timers = manualTimers();
  const store = new BindingsSlotSync(host, { timers, enabled: () => true });
  store.attach(world);
  bindings.bindKey("jump", 0, "KeyZ");
  timers.runAll();
  await settle();
  assert.deepEqual(world.saves, []);
  world.answer();
  store.accept(2);
  assert.equal(store.accept(3), true);
  timers.runAll();
  await settle();
  assert.equal(world.saves.length, 1);
  assert.equal(world.saves[0][0], 2);
  assert.ok(world.saves[0][1].includes("bind Z JUMP\r\n"), "the local change wins");
  assert.ok(world.saves[0][1].includes("bind BUTTON4 TOGGLEAUTORUN\r\n"), "Wow.exe's mouse key rides along");
});

test("slot 6: a window dragged before the answer does not overwrite the original client's layout", async () => {
  let layout = { bags: { left: 1, top: 1 } };
  let listener;
  const layoutHost = { layout: () => layout, apply: () => {}, onChanged: (fn) => { listener = fn; } };
  const world = fakeWorld(6, "VERSION 5\nWorldMapFrame 0 0");
  const timers = manualTimers();
  const store = new sync.LayoutAccountSync(layoutHost, { timers, enabled: () => true });
  store.attach(world);
  layout = { bags: { left: 50, top: 60 } };
  listener(layout);
  timers.runAll();
  store.detach();
  await settle();
  assert.deepEqual(world.saves, [], "leaving the world before the answer writes nothing either");
});

test("the next world entry waits for its own answers (the stores live for the whole page)", async () => {
  bindings.useBindingStorage(memoryStorage());
  const timers = manualTimers();
  const store = new BindingsSlotSync(host, { timers, enabled: () => true });
  const first = fakeWorld(2, WOW);
  store.attach(first);
  first.answer();
  store.accept(2);
  assert.equal(store.accept(3), true);
  store.detach();
  const second = fakeWorld(2, WOW);
  store.attach(second);
  bindings.bindKey("jump", 0, "KeyX");
  timers.runAll();
  store.flush();
  await settle();
  assert.deepEqual(second.saves, [], "the first world's answers do not open the second world's slots");
});
