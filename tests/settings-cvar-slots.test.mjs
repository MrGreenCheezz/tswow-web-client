import assert from "node:assert/strict";
import test from "node:test";

// 5.37 (15.11): the settings over the account's data. The stock CVars Wow.exe keeps in slots 0/1 (flags 0x10/0x20 of
// its registrations, framexml/WowCVarRegistry.ts) as its own `SET name "value"` lines (reader 0x00766400, writer
// 0x007670e0 → 0x00767030 → 0x00766640); every other setting in slot 6 beside the window layout; the stock interface's
// own slot CVars too. Review of 15.11: a slot that answered with no line means the registered default; nothing of one
// login reaches the next; what the server holds moves on its COMPLETE only; the old JSON is rewritten after slot 6.

const timers = [];
const storage = new Map();
globalThis.window ??= {};
globalThis.window.setTimeout = (run) => { timers.push(run); return timers.length; };
globalThis.window.clearTimeout = () => {};
globalThis.window.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
};

const text = await import("../dist/code/browser/ui/CVarCacheText.js");
const { SettingsAccountStore, mappedSettingsCVarRows } = await import("../dist/code/browser/ui/SettingsAccountStore.js");
const { SETTINGS_CVAR_SLOTS } = await import("../dist/code/browser/ui/SettingsCVarSlots.js");
const { defaultSettings } = await import("../dist/code/browser/ui/SettingsModel.js");
const registry = await import("../dist/code/browser/framexml/WowCVarRegistry.js");
const layout = await import("../dist/code/browser/input/InputAccount.js");

const runTimers = () => { for (const run of timers.splice(0)) run(); };
const set = (...rows) => rows.map((row) => `${row}\n`).join("");

const ACCOUNT = set('SET scriptErrors "1"', 'SET flaggedTutorials "v##M##%##&"', 'SET autoLootDefault "1"', 'SET cameraDistanceMaxFactor "1"');
const CHARACTER = set('SET minimapZoom "2"', 'SET trackedQuests "v"', 'SET nameplateShowFriends "1"');
const WINDOWS = { bags: { left: 10, top: 20 } };
const ENVELOPE = (settings) => layout.serialiseLayoutEnvelope(WINDOWS, settings);

function world(slots, { guid = 7n, realm = "Realm" } = {}) {
  const saved = [];
  return {
    saved,
    realmName: realm,
    state: { selfGuid: guid },
    accountData: new Map(Object.entries(slots).map(([slot, value]) => [Number(slot), { text: value }])),
    requestAccountData() {},
    saveAccountData(type, value) {
      saved.push([type, value]);
      if (value) this.accountData.set(type, { text: value }); else this.accountData.delete(type);
      return Promise.resolve();
    },
  };
}

let refused = [];
function freshStore({ keepStorage = false } = {}) {
  if (!keepStorage) storage.clear();
  timers.length = 0;
  refused = [];
  return new SettingsAccountStore({ mirrorKey: "test.settings", onRefused: (slot) => refused.push(slot) });
}

function answerAll(store) {
  store.accept(0);
  store.accept(1);
  return store.accept(6);
}

/** The server's SMSG_UPDATE_ACCOUNT_DATA_COMPLETE for a slot (WorldClient raises ACCOUNT_DATA_CHANGED with it). */
const complete = (store, slot) => store.accept(slot);
const savedTo = (w, slot) => w.saved.filter(([type]) => type === slot).map(([, value]) => value);

test("the reader's grammar: a BOM, CRLF or LF, quoted values, any case of SET; other lines kept as they are", () => {
  const lines = text.parseCVarCacheText('﻿SET a "1 2"\r\nset B 3\r\n\r\n  SET c "x"\nSETd 1\nSET "e" "y"\n');
  assert.deepEqual(lines.map((line) => line.kind === "set" ? [line.name, line.value] : ["other", line.raw]), [
    ["a", "1 2"], ["B", "3"], ["other", '  SET c "x"'], ["other", "SETd 1"], ["e", "y"],
  ]);
  assert.equal(text.cvarLineValue(lines, "b"), "3", "names without case");
});

test("rewriting: the last line of a name in place in its own spelling, a new one at the end, a default removed", () => {
  const lines = text.parseCVarCacheText(set('SET AutoLootDefault "0"', 'SET x "keep me"', 'SET rotateMinimap "1"'));
  const out = text.renderCVarCacheText(text.withCVarValues(lines, new Map([
    ["autoLootDefault", "1"], ["rotateMinimap", undefined], ["blockTrades", "1"],
  ])));
  assert.equal(out, set('SET AutoLootDefault "1"', 'SET x "keep me"', 'SET blockTrades "1"'));
});

test("the registry: flags and defaults as Wow.exe registers them; the setting rows come from it", () => {
  assert.equal(registry.wowCVarSlot("trackedQuests"), 1, "0x120");
  assert.equal(registry.wowCVarSlot("flaggedTutorials"), 0, "0x110");
  assert.equal(registry.wowCVar("minimapZoom").defaultValue, "3");
  assert.equal(registry.wowCVarSlot("cameraBobbing"), undefined, "flag 0: Config.wtf");
  assert.equal(registry.wowCVarSlot("uiScale"), undefined);
  assert.equal(mappedSettingsCVarRows().length, SETTINGS_CVAR_SLOTS.length);
  assert.deepEqual(SETTINGS_CVAR_SLOTS.map((row) => row.cvar).sort(), [
    "ShowAllSpellRanks", "ShowClassColorInNameplate", "assistAttack", "autoDismount", "autoDismountFlying", "autoLootDefault",
    "autoRangedCombat", "autoStand", "blockTrades", "cameraDistanceMaxFactor", "cameraPivot", "cameraSmoothStyle", "cameraTerrainTilt",
    "cameraWaterCollision", "cameraYawMoveSpeed", "cameraYawSmoothSpeed", "chatBubbles", "deselectOnClick", "enableCombatText",
    "equipmentManager", "lootUnderMouse", "mouseInvertPitch", "nameplateAllowOverlap", "nameplateShowEnemies",
    "nameplateShowFriends", "rotateMinimap", "showVKeyCastbar", "stopAutoAttackOnTargetChange",
  ].sort());
});

test("nothing is applied or written before slots 0, 1 and 6 have all answered", () => {
  const store = freshStore();
  const w = world({ 0: ACCOUNT, 1: CHARACTER, 6: ENVELOPE({ renderScale: 60 }) });
  store.attach(w);
  store.set({ ...store.value, mouseInvertPitch: true });
  assert.equal(store.accept(0), false);
  assert.equal(store.accept(1), false);
  runTimers();
  store.flush();
  assert.deepEqual(w.saved, []);
  assert.equal(store.accept(6), true);
  assert.equal(store.value.autoLoot, true);
  assert.equal(store.value.renderScale, 60);
  assert.equal(store.value.mouseInvertPitch, true, "the change made meanwhile keeps its value");
  runTimers();
  assert.deepEqual(w.saved, [[0, ACCOUNT + 'SET mouseInvertPitch "1"\n']]);
});

test("the CVar settings: a change writes its slot with every other line as Wow.exe wrote it", () => {
  const store = freshStore();
  const w = world({ 0: ACCOUNT, 1: CHARACTER, 6: ENVELOPE({}) });
  store.attach(w);
  answerAll(store);
  assert.equal(store.value.plateFriends, true, "nameplateShowFriends \"1\" from slot 1");
  runTimers();
  assert.deepEqual(w.saved, [], "reading writes nothing");
  store.set({ ...store.value, autoLoot: false });
  runTimers();
  assert.deepEqual(w.saved, [[0, set('SET scriptErrors "1"', 'SET flaggedTutorials "v##M##%##&"', 'SET cameraDistanceMaxFactor "1"')]],
    "the default needs no line (0x00767030); the rest of the slot is untouched");
  store.set({ ...store.value, plateFriends: false, blockTrades: true });
  runTimers();
  assert.deepEqual(w.saved.at(-1), [1, set('SET minimapZoom "2"', 'SET trackedQuests "v"', 'SET blockTrades "1"')]);
});

test("this client's own settings go to slot 6 beside the windows, never into a config slot", () => {
  const store = freshStore();
  const w = world({ 0: ACCOUNT, 1: CHARACTER, 6: ENVELOPE({}) });
  store.attach(w);
  answerAll(store);
  store.set({ ...store.value, renderScale: 75, grassRadius: 40 });
  runTimers();
  assert.deepEqual(w.saved.map(([slot]) => slot), [6]);
  const written = JSON.parse(w.saved[0][1]);
  assert.deepEqual(written.windows, WINDOWS, "the layout is kept");
  assert.equal(written.settings.renderScale, 75);
  assert.equal(written.settings.grassRadius, 40);
  assert.equal(written.settings.autoLoot, undefined, "a CVar setting is not duplicated there");
  assert.deepEqual(layout.parseLayoutEnvelope(w.saved[0][1]), WINDOWS, "the layout store still reads its envelope");
});

test("slot 6 is the truth for this client's settings: another browser starts from it, not from defaults", () => {
  const store = freshStore();
  const w = world({ 6: ENVELOPE({ renderScale: 55, experimentalLootBeams: false }) });
  store.attach(w);
  assert.equal(answerAll(store), true);
  assert.equal(store.value.renderScale, 55);
  assert.equal(store.value.experimentalLootBeams, false);
  runTimers();
  assert.deepEqual(w.saved, []);
});

test("review 2: a slot that answered with no line is the registered default, never this browser's (another character's)", () => {
  const store = freshStore();
  const a = world({ 0: ACCOUNT, 1: CHARACTER, 6: ENVELOPE({ renderScale: 50 }) }, { guid: 1n });
  store.attach(a);
  answerAll(store);
  store.set({ ...store.value, blockTrades: true, mouseInvertPitch: true });
  runTimers();
  store.detach();
  assert.equal(JSON.parse(storage.get("test.settings")).blockTrades, true, "this browser's copy says A's");
  // Character B (same page) has nothing of these in its slots: Wow.exe's defaults, and its own settings' defaults.
  const b = world({ 0: "", 1: "", 6: "" }, { guid: 2n });
  store.attach(b);
  answerAll(store);
  assert.equal(store.value.blockTrades, false, "blockTrades \"0\" registered default");
  assert.equal(store.value.mouseInvertPitch, false);
  assert.equal(store.value.renderScale, defaultSettings().renderScale, "slot 6 without settings: the defaults, not A's");
  store.set({ ...store.value, plateFriends: true });
  runTimers();
  assert.deepEqual(b.saved, [[1, set('SET nameplateShowFriends "1"')]], "B's slot gets only B's change");
});

test("review 1: nothing of one login reaches the next: stock CVars of character A or account A never go to B's slots", () => {
  const store = freshStore();
  const a = world({ 0: ACCOUNT, 1: CHARACTER, 6: ENVELOPE({}) }, { guid: 1n });
  store.attach(a);
  answerAll(store);
  assert.equal(store.note("worldMapOpacity", "0.7"), true);
  assert.equal(store.note("chatMouseScroll", "0"), true);
  // A slot CVar whose default Wow.exe computes (cameraSavedDistance, 0x005fd910): no answer value replaces A's.
  assert.equal(store.note("cameraSavedDistance", "15"), true);
  runTimers();
  store.detach();
  // Character B of the same account: its own worldMapOpacity line.
  const b = world({ 0: "", 1: set('SET worldMapOpacity "0.2"'), 6: ENVELOPE({}) }, { guid: 2n });
  store.attach(b);
  answerAll(store);
  store.set({ ...store.value, plateFriends: true });
  runTimers();
  assert.deepEqual(savedTo(b, 1), [set('SET worldMapOpacity "0.2"', 'SET nameplateShowFriends "1"')], "B's line stays B's");
  complete(store, 1);
  // B sets the same value A had: it is B's change and is written.
  store.note("worldMapOpacity", "0.7");
  runTimers();
  assert.equal(savedTo(b, 1).at(-1), set('SET worldMapOpacity "0.7"', 'SET nameplateShowFriends "1"'));
  store.detach();
  // Another account (another realm here): slot 0 gets nothing of account A's chatMouseScroll.
  const c = world({ 0: "", 1: "", 6: ENVELOPE({}) }, { guid: 3n, realm: "Other" });
  store.attach(c);
  answerAll(store);
  store.set({ ...store.value, mouseInvertPitch: true });
  runTimers();
  assert.deepEqual(savedTo(c, 0), [set('SET mouseInvertPitch "1"')]);
});

test("review 3: what the server holds moves on its COMPLETE; a text the core would drop is not sent and the player is told", () => {
  const store = freshStore();
  const w = world({ 0: ACCOUNT, 1: CHARACTER, 6: ENVELOPE({}) });
  store.attach(w);
  answerAll(store);
  store.set({ ...store.value, autoLoot: false });
  runTimers();
  assert.equal(w.saved.length, 1);
  // No COMPLETE (the socket dropped): putting the value back is sent too, since the server may still hold it.
  store.set({ ...store.value, autoLoot: true });
  runTimers();
  assert.deepEqual(w.saved.at(-1), [0, ACCOUNT]);
  complete(store, 0);
  store.set({ ...store.value, autoLoot: false });
  store.set({ ...store.value, autoLoot: true });
  runTimers();
  assert.equal(w.saved.length, 2, "confirmed: the same text again is not sent");
  // A blob over the limit (0xFFFF, MiscHandler.cpp:914) is refused here.
  store.note("trackedQuests", "x".repeat(70_000));
  runTimers();
  assert.equal(w.saved.length, 2);
  assert.deepEqual(refused, [1]);
});

test("review 4: the old slot-1 JSON is rewritten only after slot 6 is confirmed; slot 0 is not touched by it", () => {
  const store = freshStore();
  const json = JSON.stringify({ renderScale: 80, experimentalLootBeams: false, plateFriends: true, autoLoot: true });
  const w = world({ 0: set('SET scriptErrors "1"'), 1: json, 6: layout.serialiseLayoutEnvelope(WINDOWS) });
  store.attach(w);
  assert.equal(answerAll(store), true);
  assert.equal(store.value.renderScale, 80);
  assert.equal(store.value.plateFriends, true, "the character's CVar from the JSON");
  assert.equal(store.value.autoLoot, false, "an account CVar: slot 0 has no line, so Wow.exe's default");
  runTimers();
  assert.deepEqual(w.saved.map(([slot]) => slot), [6], "slot 6 first; slot 1 still holds the JSON");
  const envelope = JSON.parse(savedTo(w, 6)[0]);
  assert.deepEqual(envelope.windows, WINDOWS);
  assert.equal(envelope.settings.renderScale, 80);
  store.detach();
  assert.deepEqual(w.saved.map(([slot]) => slot), [6], "leaving before the COMPLETE: the JSON stays");
  // Again, with the COMPLETE of slot 6.
  const again = freshStore();
  const w2 = world({ 0: set('SET scriptErrors "1"'), 1: json, 6: layout.serialiseLayoutEnvelope(WINDOWS) });
  again.attach(w2);
  answerAll(again);
  runTimers();
  complete(again, 6);
  runTimers();
  assert.deepEqual(savedTo(w2, 1), [set('SET nameplateShowEnemies "1"', 'SET nameplateShowFriends "1"')],
    "now the JSON becomes Wow.exe's lines (enemy plates: this client's former default, carried explicitly)");
  assert.deepEqual(savedTo(w2, 0), []);
  // The next login, in yet another browser, reads the same settings from the converted slots.
  const next = freshStore();
  const w3 = world({ 0: w2.accountData.get(0).text, 1: savedTo(w2, 1)[0], 6: savedTo(w2, 6)[0] });
  next.attach(w3);
  answerAll(next);
  for (const id of ["renderScale", "experimentalLootBeams", "plateFriends", "autoLoot"]) assert.equal(next.value[id], again.value[id], id);
  runTimers();
  assert.deepEqual(w3.saved, []);
});

test("carry-over: rows the old JSON does not name keep this client's former defaults; slot 1's as explicit lines", async () => {
  const { cvarTextOfSettings, settingValueOfCVarText } = await import("../dist/code/browser/framexml/FrameXmlSettingsCVar.js");
  const defaults = defaultSettings();
  // Derived from the table and the settings model: every synced row whose default here is not Wow.exe's.
  const differing = mappedSettingsCVarRows().filter((row) =>
    settingValueOfCVarText(row.binding, cvarTextOfSettings(row.binding, defaults)) !== settingValueOfCVarText(row.binding, row.wowDefault));
  assert.ok(differing.some((row) => row.slot === 1) && differing.some((row) => row.slot === 0), "both kinds exist today");
  const store = freshStore();
  const w = world({ 0: "", 1: JSON.stringify({ renderScale: 80 }), 6: layout.serialiseLayoutEnvelope(WINDOWS) });
  store.attach(w);
  answerAll(store);
  runTimers();
  complete(store, 6);
  runTimers();
  const written = text.parseCVarCacheText(savedTo(w, 1)[0] ?? "");
  for (const row of differing) {
    const ours = defaults[row.binding.setting];
    if (row.slot === 1) {
      assert.equal(store.value[row.binding.setting], ours, `${row.cvar}: what the character had here`);
      assert.equal(text.cvarLineValue(written, row.cvar), cvarTextOfSettings(row.binding, defaults), `${row.cvar}: an explicit line`);
    } else {
      // Account-wide: not carried — a missing slot-0 line may be Wow.exe's or another character's choice.
      assert.equal(store.value[row.binding.setting], settingValueOfCVarText(row.binding, row.wowDefault), `${row.cvar}: Wow.exe's default`);
    }
  }
  assert.deepEqual(savedTo(w, 0), [], "slot 0 is not written by the carry-over");
  // A fresh character (no old JSON) gets Wow.exe's defaults, and nothing is written.
  const fresh = freshStore();
  const f = world({ 0: "", 1: "", 6: "" }, { guid: 99n });
  fresh.attach(f);
  answerAll(fresh);
  for (const row of differing) {
    assert.equal(fresh.value[row.binding.setting], settingValueOfCVarText(row.binding, row.wowDefault), `${row.cvar} fresh`);
  }
  runTimers();
  assert.deepEqual(f.saved, []);
});

test("review 4: while slot 6 holds another client's text, the old JSON is never rewritten", () => {
  const store = freshStore();
  const w = world({ 1: JSON.stringify({ renderScale: 80, plateFriends: true }), 6: "VERSION 5\nWorldMapFrame 0 0" });
  store.attach(w);
  answerAll(store);
  assert.equal(store.value.renderScale, 80);
  store.set({ ...store.value, blockTrades: true, renderScale: 90 });
  runTimers();
  store.flush();
  assert.deepEqual(w.saved, []);
});

test("the stock interface's own CVars: read from their slot (a missing line is the default), written back, a default removed", () => {
  const store = freshStore();
  const w = world({ 0: ACCOUNT, 1: CHARACTER, 6: ENVELOPE({}) });
  const pushed = [];
  store.subscribe((rows) => pushed.push(rows));
  store.attach(w);
  answerAll(store);
  const rows = Object.fromEntries(store.rows());
  assert.equal(rows.minimapZoom, "2");
  assert.equal(rows.trackedQuests, "v");
  assert.equal(rows.flaggedTutorials, "v##M##%##&");
  assert.equal(rows.worldMapOpacity, "0", "no line: the registered default, for the VM too");
  assert.equal(rows.autoLootDefault, undefined, "a setting's CVar is the settings' business");
  assert.equal(pushed.length, 1, "a VM booted before the answers gets them");
  assert.equal(store.note("webclient_renderScale", "1"), false, "not a CVar of Wow.exe");
  assert.equal(store.note("cameraBobbing", "1"), false, "Config.wtf, not a slot");
  assert.equal(store.note("trackedQuests", "v##A"), true);
  store.note("minimapZoom", "3");
  runTimers();
  assert.deepEqual(w.saved, [[1, set('SET trackedQuests "v##A"', 'SET nameplateShowFriends "1"')]],
    "minimapZoom back on its default \"3\" has no line; the rest stays");
});
