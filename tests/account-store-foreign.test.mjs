import assert from "node:assert/strict";
import test from "node:test";

// 4.16 (11.11): a settings change must not write over account-data slot 1 while it holds Wow.exe's own config
// cache (text this client cannot read), and «Сбросить настройки» keeps the one-time move's mark.

const timers = [];
globalThis.window ??= {};
globalThis.window.setTimeout = (run) => { timers.push(run); return timers.length; };
globalThis.window.clearTimeout = () => {};

const { AccountStore } = await import("../dist/code/browser/AccountStore.js");
const { defaultSettings, resetSettingValues } = await import("../dist/code/browser/ui/SettingsModel.js");

function storeOver(text, keepForeign) {
  const saved = [];
  const world = {
    accountData: new Map([[1, { text }]]),
    requestAccountData() {},
    saveAccountData(slot, written) { saved.push([slot, written]); return Promise.resolve(); },
  };
  const store = new AccountStore({
    slot: 1, mirrorKey: "test.account-store-foreign", fallback: () => ({ a: 0 }),
    parse: (raw) => { try { const value = JSON.parse(raw); return value && typeof value === "object" ? value : undefined; } catch { return undefined; } },
    serialise: (value) => JSON.stringify(value),
    ...(keepForeign ? { keepForeign: true } : {}),
  });
  store.attach(world);
  store.accept(1);
  return { store, saved };
}

function runTimers() {
  for (const run of timers.splice(0)) run();
}

test("a slot holding Wow.exe's config is never written over; the value is still kept here", () => {
  const { store, saved } = storeOver('SET cameraDistanceMax "50"\nSET profanityFilter "0"\n', true);
  assert.equal(store.foreign, true);
  store.set({ a: 1 });
  runTimers();
  store.flush();
  assert.deepEqual(saved, [], "nothing goes to the server");
  assert.deepEqual(store.value, { a: 1 });
});

test("the store's own text, an empty slot, or a store without keepForeign still save", () => {
  for (const [text, keep] of [['{"a":2}', true], ["", true], ["SET x 1", false]]) {
    const { store, saved } = storeOver(text, keep);
    assert.equal(store.foreign, false, JSON.stringify(text));
    store.set({ a: 3 });
    runTimers();
    assert.deepEqual(saved, [[1, '{"a":3}']], JSON.stringify(text));
  }
});

test("the reset keeps actionBarStockLayout and resets the options", () => {
  const current = { ...defaultSettings(), actionBarStockLayout: 0x2a3, minimapRotate: true };
  const reset = resetSettingValues(current);
  assert.equal(reset.actionBarStockLayout, 0x2a3, "the move's mark stays");
  assert.equal(reset.minimapRotate, defaultSettings().minimapRotate);
  assert.deepEqual({ ...reset, actionBarStockLayout: 0 }, defaultSettings());
});
