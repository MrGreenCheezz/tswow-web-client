import assert from "node:assert/strict";
import test from "node:test";

// 5.37 (11.11): the macro slots shared with Wow.exe. Wow.exe's text is read and written back in its format, this
// client's old JSON is still read (and written as Wow.exe's text), anything else is never written over.

const timers = [];
globalThis.window ??= {};
globalThis.window.setTimeout = (run) => { timers.push(run); return timers.length; };
globalThis.window.clearTimeout = () => {};

const { parseMacroSlot, serialiseMacroSlot, putSlotMacro, removeSlotMacro, macroIconFromWow, macroIconToWow } =
  await import("../dist/code/browser/ui/MacroSlot.js");
const { createMacroSlotStore } = await import("../dist/code/browser/ui/MacroStore.js");

const CRLF = "\r\n";
const lines = (...rows) => rows.map((row) => row + CRLF).join("");

const WOW_ACCOUNT = lines(
  "MACRO 2 \"Bandage\" INV_Misc_Bandage_15", "/use Heavy Frostweave Bandage", "END",
  "MACRO 40 \"Mount\" ability_mount_ridinghorse", "/cast Swift Brown Horse", "END",
  "MACRO 7 \"Plain\" ", "/sit", "END",
);

function runTimers() {
  for (const run of timers.splice(0)) run();
}

function storeOver(slot, text, characterSet) {
  const saved = [];
  const world = {
    realmName: "Realm", state: { selfGuid: 9n },
    accountData: new Map(text === undefined ? [] : [[slot, { text }]]),
    requestAccountData() {},
    saveAccountData(type, written) { saved.push([type, written]); return Promise.resolve(); },
  };
  const store = createMacroSlotStore(slot, `test.macro-slot.${slot}`, characterSet);
  store.attach(world);
  const accepted = store.accept(slot);
  return { store, saved, accepted };
}

test("Wow.exe's ids name slots; an id with no slot takes the lowest free one; icons become texture paths", () => {
  const slot = parseMacroSlot(WOW_ACCOUNT, false);
  assert.deepEqual(slot.macros.map((macro) => [macro.index, macro.name]), [[1, "Mount"], [2, "Bandage"], [7, "Plain"]]);
  assert.equal(slot.macros[0].icon, "Interface\\Icons\\ability_mount_ridinghorse");
  assert.equal(slot.macros[2].icon, undefined, "an empty icon shows the question mark here");
  assert.deepEqual(slot.origins[1], { id: 40, icon: "ability_mount_ridinghorse" });
  // Unchanged, it is written back exactly as Wow.exe wrote it.
  assert.equal(serialiseMacroSlot(slot, false), WOW_ACCOUNT);
});

test("a character set: id 0x1000000+n takes slot 36+n; macros beyond 18 ride along unseen and are written back", () => {
  let text = "";
  for (let n = 1; n <= 20; n += 1) text += lines(`MACRO ${0x1000000 + n} "C${String(n).padStart(2, "0")}" X`, `/c${n}`, "END");
  const slot = parseMacroSlot(text, true);
  assert.equal(slot.macros.length, 18);
  assert.equal(slot.macros[0].index, 37);
  assert.equal(slot.origins[37].id, 0x1000001);
  assert.deepEqual(slot.spare.map((macro) => macro.name), ["C19", "C20"]);
  assert.equal(serialiseMacroSlot(slot, true), text);
});

test("a change keeps every other macro, the id and an icon this client cannot show; a new macro gets its slot's id", () => {
  let slot = parseMacroSlot(WOW_ACCOUNT, false);
  slot = putSlotMacro(slot, { ...slot.macros.find((macro) => macro.index === 2), body: "/use Frostweave Bandage" });
  slot = putSlotMacro(slot, { index: 3, name: "New", body: "/dance" });
  slot = putSlotMacro(slot, { index: 1, name: "Mount", body: "/cast Swift Brown Horse\n", icon: "Interface\\Icons\\Spell_Nature_Swiftness" });
  assert.equal(serialiseMacroSlot(slot, false), lines(
    "MACRO 2 \"Bandage\" INV_Misc_Bandage_15", "/use Frostweave Bandage", "END",
    "MACRO 40 \"Mount\" Spell_Nature_Swiftness", "/cast Swift Brown Horse", "END",
    "MACRO 3 \"New\" INV_Misc_QuestionMark", "/dance", "END",
    "MACRO 7 \"Plain\" ", "/sit", "END",
  ));
  // A slot whose own id is taken gets one more than the set's highest, as Wow.exe's CreateMacro would.
  const crowded = { macros: [{ index: 1, name: "A", body: "/a" }], origins: {}, spare: [{ id: 1, name: "S", icon: "X", body: "" }] };
  assert.match(serialiseMacroSlot(crowded, false), /MACRO 2 "A"/);
  // Deleting a macro drops its id with it.
  assert.equal(removeSlotMacro(slot, 1).origins[1], undefined);
});

test("icons: Wow.exe's name and this client's path both ways", () => {
  assert.equal(macroIconFromWow("INV_Misc_QuestionMark"), undefined);
  assert.equal(macroIconFromWow(""), undefined);
  assert.equal(macroIconToWow(undefined), "INV_Misc_QuestionMark");
  assert.equal(macroIconToWow("Interface\\Icons\\Spell_Holy_Heal"), "Spell_Holy_Heal");
  assert.equal(macroIconToWow("Interface\\Buttons\\Ui-Something"), "INV_Misc_QuestionMark", "only Interface\\Icons\\ can be kept");
});

test("this client's JSON is read; text neither format reads is not a value", () => {
  const json = parseMacroSlot('[{"index":1,"name":"Gm","body":".gm fly on\\n.mod speed 10"}]', false);
  assert.deepEqual(json.macros, [{ index: 1, name: "Gm", body: ".gm fly on\n.mod speed 10" }]);
  assert.equal(serialiseMacroSlot(json, false), lines("MACRO 1 \"Gm\" INV_Misc_QuestionMark", ".gm fly on", ".mod speed 10", "END"));
  assert.equal(parseMacroSlot("something else entirely", false), undefined);
  assert.deepEqual(parseMacroSlot("", false).macros, []);
});

test("store: Wow.exe's text is read and a change is written back in Wow.exe's text", () => {
  const { store, saved, accepted } = storeOver(4, WOW_ACCOUNT, false);
  assert.equal(accepted, true);
  assert.equal(store.foreign, false);
  assert.deepEqual(store.value.macros.map((macro) => macro.name), ["Mount", "Bandage", "Plain"]);
  store.set(putSlotMacro(store.value, { index: 7, name: "Plain", body: "/sit\n/wave" }));
  runTimers();
  assert.deepEqual(saved, [[4, lines(
    "MACRO 2 \"Bandage\" INV_Misc_Bandage_15", "/use Heavy Frostweave Bandage", "END",
    "MACRO 40 \"Mount\" ability_mount_ridinghorse", "/cast Swift Brown Horse", "END",
    "MACRO 7 \"Plain\" ", "/sit", "/wave", "END",
  )]]);
});

test("store: the character slot reads ids from 0x1000001 and writes them back", () => {
  const text = lines("MACRO 16777218 \"Mine\" Ability_Stealth", "/cast Stealth", "END");
  const { store, saved } = storeOver(5, text, true);
  assert.deepEqual(store.value.macros.map((macro) => macro.index), [38]);
  store.set(putSlotMacro(store.value, { index: 37, name: "Other", body: "/x" }));
  runTimers();
  assert.deepEqual(saved, [[5, lines("MACRO 16777218 \"Mine\" Ability_Stealth", "/cast Stealth", "END", "MACRO 16777217 \"Other\" INV_Misc_QuestionMark", "/x", "END")]]);
});

test("store: this client's JSON is read and the next change goes out as Wow.exe's text", () => {
  const { store, saved, accepted } = storeOver(4, '[{"index":3,"name":"Old","body":"/old"}]', false);
  assert.equal(accepted, true);
  store.set(putSlotMacro(store.value, { index: 4, name: "More", body: "/more" }));
  runTimers();
  assert.deepEqual(saved, [[4, lines("MACRO 4 \"More\" INV_Misc_QuestionMark", "/more", "END", "MACRO 3 \"Old\" INV_Misc_QuestionMark", "/old", "END")]]);
});

test("store: text neither format reads is never written over; the change stays here", () => {
  const { store, saved, accepted } = storeOver(4, "#unknown format\nkey=value\n", false);
  assert.equal(accepted, false);
  assert.equal(store.foreign, true);
  store.set(putSlotMacro(store.value, { index: 1, name: "Here", body: "/here" }));
  runTimers();
  store.flush();
  assert.deepEqual(saved, []);
  assert.equal(store.value.macros[0].name, "Here");
});

test("store: an empty slot is filled with Wow.exe's text", () => {
  const { store, saved } = storeOver(4, undefined, false);
  assert.equal(store.foreign, false);
  store.set(putSlotMacro(store.value, { index: 1, name: "First", body: "/first" }));
  runTimers();
  assert.deepEqual(saved, [[4, lines("MACRO 1 \"First\" INV_Misc_QuestionMark", "/first", "END")]]);
});
