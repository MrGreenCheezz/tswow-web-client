import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 5.37 (15.11): the key bindings' account-data store in Wow.exe's text. The server's answer is the truth (both
// slots, the character's set in force when its slot holds text — 0x00562d60), nothing is written before both
// answers, the old JSON envelope is read and converted at the next change, lines this client does not hold
// survive a change, and SaveBindings moves the set (0x005640c0, 0x0055f3d0).

const { BindingsSlotSync } = await import("../dist/code/browser/input/BindingsSlotSync.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const bindingSet = await import("../dist/code/browser/input/BindingSet.js");

const ENVELOPE = readFileSync(new URL("./fixtures/wowclient-bindings.sample.json", import.meta.url), "utf8").trim();
const CRLF = "\r\n";
const lines = (...rows) => rows.map((row) => row + CRLF).join("");

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, String(value)) };
}

function fakeWorld(slots) {
  const saves = [];
  const accountData = new Map();
  return {
    saves, accountData,
    answer() { for (const [slot, text] of Object.entries(slots)) if (text) accountData.set(Number(slot), { text }); },
    requestAccountData() {},
    saveAccountData: (type, value) => {
      saves.push([type, value]);
      if (value) accountData.set(type, { text: value }); else accountData.delete(type);
      return Promise.resolve();
    },
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

function attached(slots) {
  bindings.useBindingStorage(memoryStorage());
  const world = fakeWorld(slots);
  const timers = manualTimers();
  const store = new BindingsSlotSync(host, { timers, enabled: () => true });
  store.attach(world);
  return { world, timers, store };
}

function answer({ world, store }) {
  world.answer();
  store.accept(2);
  return store.accept(3);
}

test("nothing is written before both answers; a change made meanwhile is laid over the answer, then written", async () => {
  const wow = lines("BINDINGMODE 0", "bind F RAIDTARGET1", "modifiedclick ALT SELFCAST");
  const run = attached({ 2: wow });
  bindings.bindKey("jump", 0, "KeyZ");
  run.timers.runAll();
  run.store.flush();
  run.world.answer();
  assert.equal(run.store.accept(2), false, "one answer is not both");
  run.timers.runAll();
  await settle();
  assert.deepEqual(run.world.saves, [], "nothing before both answers");
  assert.equal(run.store.accept(3), true);
  assert.deepEqual(bindings.bindingsOf("jump"), ["KeyZ", "Numpad0"], "the early change survives the answer");
  assert.deepEqual(bindings.bindingsOf("assistTarget"), ["", ""], "the answer's own lines apply too");
  run.timers.runAll();
  await settle();
  assert.equal(run.world.saves.length, 1);
  assert.equal(run.world.saves[0][0], 2);
  assert.equal(run.world.saves[0][1], lines(
    "BINDINGMODE 0", "bind F RAIDTARGET1", "bind Z JUMP", "bind SPACE NONE", "modifiedclick ALT SELFCAST",
  ), "Wow.exe's lines survive; the change is written as differences from the defaults");
});

test("the server's answer is the truth: empty slots are the default keys, and nothing is written for them", async () => {
  bindings.useBindingStorage(memoryStorage());
  bindings.bindKey("jump", 0, "KeyQ");
  const world = fakeWorld({});
  const timers = manualTimers();
  const store = new BindingsSlotSync(host, { timers, enabled: () => true });
  store.attach(world);
  assert.equal(answer({ world, store }), true);
  assert.deepEqual(bindings.bindingsOf("jump"), bindings.DEFAULT_BINDINGS.jump, "this browser's keys gave way to the slot's");
  timers.runAll();
  store.flush();
  await settle();
  assert.deepEqual(world.saves, []);
});

test("the old JSON envelope is read, not written over until a change, then written as Wow.exe's text", async () => {
  const run = attached({ 2: ENVELOPE });
  assert.equal(answer(run), true);
  const envelope = JSON.parse(ENVELOPE);
  // Read by the table's own reader (a pre-4.11 table's untouched rows take the stock defaults there).
  assert.deepEqual(bindings.bindingsOf("moveForward"), envelope.core.moveForward, "the envelope's keys are in force");
  run.timers.runAll();
  await settle();
  assert.deepEqual(run.world.saves, [], "reading converts nothing");
  bindings.bindKey("sitOrStand", 1, "KeyY");
  run.timers.runAll();
  await settle();
  assert.equal(run.world.saves.length, 1);
  const [slot, written] = run.world.saves[0];
  assert.equal(slot, 2);
  assert.ok(written.startsWith("BINDINGMODE 0\r\n"), "Wow.exe's text, not JSON");
  assert.ok(written.includes("bind Y SITORSTAND\r\n"));
  assert.ok(!written.includes("{"));
});

test("the character's set is in force when its slot holds text: changes go to slot 3, slot 2 is left", async () => {
  const run = attached({ 2: lines("BINDINGMODE 0", "bind SPACE NONE", "bind Q JUMP"), 3: lines("BINDINGMODE 0", "bind SPACE NONE", "bind X JUMP") });
  answer(run);
  assert.equal(bindingSet.currentBindingSet(), 2);
  assert.ok(bindings.bindingsOf("jump").includes("KeyX"), "the character's text, not the account's");
  assert.ok(!bindings.bindingsOf("jump").includes("KeyQ"));
  bindings.bindKey("toggleAutoRun", 0, "KeyR");
  run.timers.runAll();
  await settle();
  assert.deepEqual(run.world.saves.map(([slot]) => slot), [3]);
  assert.ok(run.world.saves[0][1].includes("bind X JUMP\r\n"));
});

test("SaveBindings(account) from the character's set writes slot 2 and empties slot 3; LoadBindings writes nothing", async () => {
  const run = attached({ 2: lines("BINDINGMODE 0", "bind SPACE NONE", "bind Q JUMP"), 3: lines("BINDINGMODE 0", "bind SPACE NONE", "bind X JUMP", "bind BUTTON5 JUMP") });
  answer(run);
  bindingSet.loadBindingSet(1);
  assert.ok(bindings.bindingsOf("jump").includes("KeyQ"), "the window shows the account's set");
  run.timers.runAll();
  await settle();
  assert.deepEqual(run.world.saves, [], "showing a set is not saving it");
  bindingSet.saveBindingSet(1);
  await settle();
  assert.deepEqual(run.world.saves.map(([slot, text]) => [slot, text === "" ? "" : "text"]), [[3, ""]],
    "slot 2 already says this; the character's slot is emptied");
  assert.equal(bindingSet.currentBindingSet(), 1);
  bindings.bindKey("toggleAutoRun", 0, "KeyR");
  run.timers.runAll();
  await settle();
  assert.equal(run.world.saves.at(-1)[0], 2, "from now on the account's slot");
  assert.ok(run.world.saves.at(-1)[1].includes("bind Q JUMP\r\n"));
});

test("the stock window's API: GetCurrentBindingSet, the switch's LoadBindings and its Cancel, SaveBindings", async () => {
  const { FrameXmlBindingModel, FRAMEXML_BINDING_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlBinding.js");
  const run = attached({ 2: lines("BINDINGMODE 0", "bind SPACE NONE", "bind Q JUMP"), 3: lines("BINDINGMODE 0", "bind SPACE NONE", "bind X JUMP") });
  answer(run);
  const model = new FrameXmlBindingModel();
  const seam = { keyBindings: model };
  assert.deepEqual(FRAMEXML_BINDING_BINDINGS.GetCurrentBindingSet(seam, []), [2]);
  // KeyBindingFrameCharacterButton unchecked: LoadBindings(ACCOUNT_BINDINGS) shows the account's keys.
  FRAMEXML_BINDING_BINDINGS.LoadBindings(seam, [1]);
  assert.ok(bindings.bindingsOf("jump").includes("KeyQ"));
  // Cancel: LoadBindings(GetCurrentBindingSet()) puts the character's keys back.
  FRAMEXML_BINDING_BINDINGS.LoadBindings(seam, [2]);
  assert.ok(bindings.bindingsOf("jump").includes("KeyX"));
  assert.ok(!bindings.bindingsOf("jump").includes("KeyQ"));
  run.timers.runAll();
  await settle();
  assert.deepEqual(run.world.saves, [], "looking and cancelling write nothing");
  FRAMEXML_BINDING_BINDINGS.SaveBindings(seam, [1]);
  await settle();
  assert.equal(bindingSet.currentBindingSet(), 1);
  assert.deepEqual(run.world.saves.map(([slot]) => slot).sort(), [2, 3], "the account's slot gets the keys, the character's is emptied");
  assert.equal(run.world.saves.find(([slot]) => slot === 3)[1], "");
  assert.ok(run.world.saves.find(([slot]) => slot === 2)[1].includes("bind X JUMP\r\n"));
});

test("review 5: after the window viewed the account's set, a write of the character's keeps its Wow.exe-only lines", async () => {
  const { FrameXmlBindingModel, FRAMEXML_BINDING_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlBinding.js");
  const run = attached({
    2: lines("BINDINGMODE 0", "bind SPACE NONE", "bind Q JUMP"),
    3: lines("BINDINGMODE 0", "bind F RAIDTARGET1", "bind SPACE NONE", "bind X JUMP"),
  });
  answer(run);
  const seam = { keyBindings: new FrameXmlBindingModel() };
  FRAMEXML_BINDING_BINDINGS.LoadBindings(seam, [1]);
  FRAMEXML_BINDING_BINDINGS.LoadBindings(seam, [2]);
  bindings.bindKey("toggleAutoRun", 0, "KeyR");
  run.timers.runAll();
  await settle();
  const toThree = run.world.saves.filter(([slot]) => slot === 3);
  assert.equal(toThree.length, 1);
  assert.ok(toThree[0][1].includes("bind F RAIDTARGET1\r\n"), "the raid mark's line is kept, not turned into NONE");
  assert.ok(!toThree[0][1].includes("bind F NONE"));
});

test("SaveBindings(character) from the account's set copies the account's lines into slot 3", async () => {
  const run = attached({ 2: lines("BINDINGMODE 0", "bind F RAIDTARGET1", "BINDINGMODE 1", "bind W CAMERAZOOMIN") });
  answer(run);
  assert.equal(bindingSet.currentBindingSet(), 1);
  bindings.bindKey("toggleAutoRun", 0, "KeyR");
  bindingSet.saveBindingSet(2);
  await settle();
  const toThree = run.world.saves.filter(([slot]) => slot === 3);
  assert.equal(toThree.length, 1);
  assert.ok(toThree[0][1].includes("bind F RAIDTARGET1\r\n") && toThree[0][1].includes("bind W CAMERAZOOMIN\r\n"));
  assert.ok(toThree[0][1].includes("bind R TOGGLEAUTORUN\r\n"));
  assert.ok(!run.world.saves.some(([slot]) => slot === 2), "the account's slot is not touched");
});
