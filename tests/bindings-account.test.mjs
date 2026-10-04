import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Key bindings and window positions in the account data (WORK_PLAN 4.12): the Unity client's
// envelope read and written by its own rules, the merge, the guard on foreign text and on size, the
// switch that keeps it all off, and the window-layout slot. The fixture is a hand-made envelope in
// the Unity client's shape (its own rows `toggleContacts` … `actionPageNext` among ours).
const account = await import("../dist/code/browser/input/BindingsAccount.js");
const sync = await import("../dist/code/browser/input/InputAccount.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");

const SAMPLE = readFileSync(new URL("./fixtures/wowclient-bindings.sample.json", import.meta.url), "utf8").trim();
const UNITY_ONLY = ["toggleContacts", "toggleGuild", "toggleMacros", "toggleLfg", "openChatCommand", "actionPagePrevious", "actionPageNext"];

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

test("the envelope is read by the Unity client's strict rules", () => {
  const parsed = account.parseBindingsEnvelope(SAMPLE);
  assert.deepEqual(parsed.core.toggleContacts, ["KeyO", ""]);
  assert.deepEqual(parsed.modifiedClicks, {}, "modifiedClicks may be absent");
  const refused = [
    "{\"x\":1}", "not json", "[]",
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
  const written = account.serialiseBindingsEnvelope(parsed);
  assert.deepEqual(Object.keys(JSON.parse(written)), ["format", "version", "core", "modules", "modifiedClicks"],
    "the Unity client's property order, all five");
});

test("the merge keeps the server's rows, lays the local changes over them and takes a claimed chord off its remote owner", () => {
  const server = account.parseBindingsEnvelope(SAMPLE);
  const local = { core: { ...server.core, jump: ["KeyO", ""] }, modules: {} };
  const merged = account.mergeServerOverLocal(server, local, new Set(["jump"]), new Set());
  assert.deepEqual(merged.core.jump, ["KeyO", ""]);
  assert.deepEqual(merged.core.toggleContacts, ["", ""], "O moved to jump here, so the Unity row lets go of it");
  assert.deepEqual(merged.core.moveForward, ["KeyW", "ArrowUp"]);
  assert.deepEqual(merged.modules["module:shop:Лавка"], ["KeyY", ""], "an unchanged module row is the server's");
  const removed = account.mergeServerOverLocal(server, { core: {}, modules: {} }, new Set(), new Set(["module:shop:Лавка"]));
  assert.equal(removed.modules["module:shop:Лавка"], undefined, "a row removed here is removed");
});

test("off by default: nothing is asked for, applied or written", () => {
  bindings.useBindingStorage(memoryStorage());
  const world = fakeWorld(SAMPLE);
  const timers = manualTimers();
  const store = new sync.BindingsAccountSync(host, { timers, enabled: () => false });
  store.attach(world);
  assert.deepEqual(world.requested, []);
  assert.equal(store.accept(2), false);
  bindings.bindKey("jump", 0, "KeyZ");
  timers.runAll();
  assert.deepEqual(world.saves, []);
  assert.equal(sync.accountSyncEnabled(sync.INPUT_ACCOUNT_SYNC_KEYS.bindings), false, "no switch set: off");
});

test("switched on: the server copy is applied, the Unity rows survive a rebinding, the write is the envelope", async () => {
  bindings.useBindingStorage(memoryStorage());
  const world = fakeWorld(SAMPLE);
  const timers = manualTimers();
  const store = new sync.BindingsAccountSync(host, { timers, enabled: () => true });
  store.attach(world);
  assert.deepEqual(world.requested, [2]);
  assert.equal(store.accept(2), true);
  assert.equal(bindings.actionFor("KeyB"), "toggleBags");
  bindings.bindKey("jump", 0, "KeyZ");
  timers.runAll();
  await settle();
  const [slot, text] = world.saves.at(-1);
  assert.equal(slot, 2);
  const written = account.parseBindingsEnvelope(text);
  assert.ok(written, "what is written is the envelope the Unity client reads");
  assert.deepEqual(written.core.jump, ["KeyZ", ""]);
  for (const name of UNITY_ONLY) assert.ok(written.core[name], `${name} kept`);
  assert.deepEqual(written.core.actionPagePrevious, ["Shift+ArrowUp", ""]);
  assert.deepEqual(written.modules["module:shop:Лавка"], ["KeyY", ""]);
  // A rebinding before the answer arrives beats the server and displaces its holder there.
  bindings.useBindingStorage(memoryStorage());
  const late = fakeWorld(undefined);
  const lateStore = new sync.BindingsAccountSync(host, { timers: manualTimers(), enabled: () => true });
  lateStore.attach(late);
  bindings.bindKey("jump", 0, "KeyO");
  late.accountData.set(2, { text: SAMPLE });
  assert.equal(lateStore.accept(2), true);
  assert.deepEqual([...bindings.keysOf("jump")], ["KeyO", ""], "the local change won");
});

test("a slot holding another client's text is neither applied nor overwritten, and says so once", async () => {
  bindings.useBindingStorage(memoryStorage());
  const foreign = "bind W MOVEFORWARD\nbind S MOVEBACKWARD\n";
  const world = fakeWorld(foreign);
  const timers = manualTimers();
  const notices = [];
  const store = new sync.BindingsAccountSync(host, { timers, enabled: () => true, onForeign: (slot) => notices.push(slot) });
  store.attach(world);
  bindings.bindKey("jump", 0, "KeyZ");
  assert.equal(store.accept(2), false);
  assert.equal(store.accept(2), false);
  bindings.bindKey("jump", 0, "KeyX");
  timers.runAll();
  store.flush();
  await settle();
  assert.deepEqual(world.saves, [], "the original client's binding text is left as it is");
  assert.deepEqual(notices, [2]);
  assert.equal(bindings.actionFor("KeyX"), "jump", "the local table still works");
});

test("a table that would not fit is not sent", async () => {
  bindings.useBindingStorage(memoryStorage());
  const big = JSON.stringify({ format: "wowclient-bindings", version: 1,
    core: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`unityAction${i}`.padEnd(60, "x"), ["Ctrl+Alt+Shift+KeyQ", "Ctrl+Alt+Shift+KeyW"]])),
    modules: {} });
  assert.ok(account.utf8Length(big) > account.ACCOUNT_DATA_WRITE_LIMIT);
  const world = fakeWorld(big);
  const timers = manualTimers();
  const store = new sync.BindingsAccountSync(host, { timers, enabled: () => true });
  store.attach(world);
  assert.equal(store.accept(2), true);
  bindings.bindKey("jump", 0, "KeyZ");
  timers.runAll();
  await settle();
  assert.deepEqual(world.saves, []);
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
