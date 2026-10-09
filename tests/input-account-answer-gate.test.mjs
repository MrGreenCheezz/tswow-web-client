import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Review of 4.12 (02.10): a slot is written only after the server has answered for it. Slot 2 is
// shared with the Unity client and with Wow.exe's bindings cache, slot 6 with Wow.exe's layout
// cache; a binding changed (a SetBinding from an add-on's load, a key set by hand) or a window
// dragged while the answer is still travelling — the FrameXML mount holds the main thread for
// seconds at world entry — used to be written after 1.5 s, or on leaving the world, over whatever
// the slot held. Same fixtures as bindings-account.test.mjs.
const sync = await import("../dist/code/browser/input/InputAccount.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");

const SAMPLE = readFileSync(new URL("./fixtures/wowclient-bindings.sample.json", import.meta.url), "utf8").trim();

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

test("slot 2: nothing is written before the answer, and a foreign answer is then left alone", async () => {
  bindings.useBindingStorage(memoryStorage());
  const world = fakeWorld(2, "bind W MOVEFORWARD\n");
  const timers = manualTimers();
  const store = new sync.BindingsAccountSync(host, { timers, enabled: () => true });
  store.attach(world);
  bindings.bindKey("jump", 0, "KeyZ");
  timers.runAll();
  store.flush();
  await settle();
  assert.deepEqual(world.saves, [], "a change made while the answer travels waits for it");
  world.answer();
  assert.equal(store.accept(2), false);
  timers.runAll();
  store.detach();
  await settle();
  assert.deepEqual(world.saves, [], "the other client's text survives");
});

test("slot 2: a change made before the answer is merged over it and written once the answer is in", async () => {
  bindings.useBindingStorage(memoryStorage());
  const world = fakeWorld(2, SAMPLE);
  const timers = manualTimers();
  const store = new sync.BindingsAccountSync(host, { timers, enabled: () => true });
  store.attach(world);
  bindings.bindKey("jump", 0, "KeyZ");
  timers.runAll();
  await settle();
  assert.deepEqual(world.saves, []);
  world.answer();
  assert.equal(store.accept(2), true);
  timers.runAll();
  await settle();
  assert.equal(world.saves.length, 1);
  const written = JSON.parse(world.saves[0][1]);
  assert.equal(written.core.jump[0], "KeyZ", "the local change wins");
  assert.ok("toggleContacts" in written.core, "the Unity rows ride along");
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

test("the next world entry waits for its own answer (the stores live for the whole page)", async () => {
  bindings.useBindingStorage(memoryStorage());
  const timers = manualTimers();
  const store = new sync.BindingsAccountSync(host, { timers, enabled: () => true });
  const first = fakeWorld(2, SAMPLE);
  store.attach(first);
  first.answer();
  assert.equal(store.accept(2), true);
  store.detach();
  const second = fakeWorld(2, "bind W MOVEFORWARD\n");
  store.attach(second);
  bindings.bindKey("jump", 0, "KeyX");
  timers.runAll();
  store.flush();
  await settle();
  assert.deepEqual(second.saves, [], "the first world's answer does not open the second world's slot");
});
