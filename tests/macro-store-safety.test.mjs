import assert from "node:assert/strict";
import test from "node:test";

// 5.37 (11.11): the macro stores' data safety. The character mirror is the character's own (realm + guid), the
// server's answer is the truth once it has arrived (an empty slot is no macros), and nothing is written before it.

const timers = [];
const storage = new Map();
globalThis.window ??= {};
globalThis.window.setTimeout = (run) => { timers.push(run); return timers.length; };
globalThis.window.clearTimeout = () => {};
globalThis.window.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
};

const { createMacroSlotStore } = await import("../dist/code/browser/ui/MacroStore.js");
const { putSlotMacro } = await import("../dist/code/browser/ui/MacroSlot.js");

const CHARACTER_SLOT = 5;
const KEY = "test.macros.character";
const CRLF = "\r\n";
const lines = (...rows) => rows.map((row) => row + CRLF).join("");

function runTimers() {
  for (const run of timers.splice(0)) run();
}

function world(guid, slotText) {
  const saved = [];
  return {
    saved,
    realmName: "Realm",
    state: { selfGuid: guid },
    accountData: new Map(slotText === undefined ? [] : [[CHARACTER_SLOT, { text: slotText }]]),
    requestAccountData() {},
    saveAccountData(type, text) {
      saved.push([type, text]);
      if (text) this.accountData.set(type, { text }); else this.accountData.delete(type);
      return Promise.resolve();
    },
  };
}

test("1a: the character mirror is per realm and character; B never sees or writes A's macros", () => {
  storage.clear();
  const store = createMacroSlotStore(CHARACTER_SLOT, KEY, true);
  const a = world(1n, undefined);
  store.attach(a);
  store.accept(CHARACTER_SLOT);
  store.set(putSlotMacro(store.value, { index: 37, name: "A's", body: "/a" }));
  runTimers();
  assert.equal(a.saved.length, 1);
  assert.ok(storage.has(`${KEY}:Realm/1`), "A's mirror under A's key");
  store.detach();

  const b = world(2n, undefined);
  store.attach(b);
  assert.deepEqual(store.value.macros, [], "B starts empty, not from A's mirror");
  store.accept(CHARACTER_SLOT);
  runTimers();
  assert.deepEqual(b.saved, [], "nothing of A's goes into B's slot");
  store.detach();

  // A again: A's mirror shows until the answer lands.
  const again = world(1n, undefined);
  store.attach(again);
  assert.deepEqual(store.value.macros.map((macro) => macro.name), ["A's"]);
});

test("1a: the old unscoped mirror is neither read nor removed", () => {
  storage.clear();
  storage.set(KEY, '[{"index":37,"name":"Old","body":"/old"}]');
  const store = createMacroSlotStore(CHARACTER_SLOT, KEY, true);
  assert.deepEqual(store.value.macros, [], "no scope yet: no mirror");
  store.attach(world(3n, undefined));
  assert.deepEqual(store.value.macros, []);
  assert.equal(storage.get(KEY), '[{"index":37,"name":"Old","body":"/old"}]');
});

test("1b: an empty server slot means no macros once the answer has arrived, and not before", () => {
  storage.clear();
  storage.set(`${KEY}:Realm/4`, lines("MACRO 16777217 \"Gone\" X", "/gone", "END"));
  const store = createMacroSlotStore(CHARACTER_SLOT, KEY, true);
  const w = world(4n, undefined);
  let loaded = 0;
  store.onLoaded = () => { loaded += 1; };
  store.attach(w);
  assert.deepEqual(store.value.macros.map((macro) => macro.name), ["Gone"], "before the answer the mirror shows");
  assert.equal(store.accept(CHARACTER_SLOT), true, "the empty answer is taken");
  assert.deepEqual(store.value.macros, []);
  assert.equal(loaded, 1);
  assert.equal(storage.get(`${KEY}:Realm/4`), "", "the mirror is emptied too");
  // The next change writes only itself, nothing comes back.
  store.set(putSlotMacro(store.value, { index: 37, name: "New", body: "/new" }));
  runTimers();
  assert.deepEqual(w.saved, [[CHARACTER_SLOT, lines("MACRO 16777217 \"New\" INV_Misc_QuestionMark", "/new", "END")]]);
});

test("1b: nothing is written before the answer; a Wow.exe text arriving after a change is not written over", () => {
  storage.clear();
  const store = createMacroSlotStore(CHARACTER_SLOT, KEY, true);
  const wowText = lines("MACRO 16777218 \"Wow\" Ability_Stealth", "/cast Stealth", "END");
  const w = world(5n, undefined);
  store.attach(w);
  store.set(putSlotMacro(store.value, { index: 37, name: "Early", body: "/early" }));
  runTimers();
  store.flush();
  assert.deepEqual(w.saved, [], "no write before the answer");
  w.accountData.set(CHARACTER_SLOT, { text: wowText });
  store.accept(CHARACTER_SLOT);
  runTimers();
  assert.deepEqual(w.saved, []);
  assert.deepEqual(store.value.macros.map((macro) => macro.name), ["Wow"], "the server's copy is what shows");
});
