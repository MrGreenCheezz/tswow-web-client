// Plan item 3.19: SetCVar's third argument raises CVAR_UPDATE(event, value) as Wow.exe 0x514c10
// signals event 0x12a; the CVars the stock UI writes and its modified clicks survive a restart.
import assert from "node:assert/strict";
import test from "node:test";

const { FRAMEXML_NEUTRAL_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const {
  FrameXmlCVarStore, frameXmlCVarStorageKey, installFrameXmlCVarPersistence,
  FRAMEXML_CVAR_MAX_VALUE, FRAMEXML_CVAR_MAX_NAMES,
} = await import("../dist/code/browser/framexml/FrameXmlCVarPersistence.js");

function memoryStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); } };
}

/** A manual scheduler: the store's delayed write runs when the test says so. */
function manualSchedule() {
  const pending = [];
  return {
    schedule: (run) => { const entry = { run, live: true }; pending.push(entry); return () => { entry.live = false; }; },
    runAll: () => { for (const entry of pending.splice(0)) if (entry.live) entry.run(); },
  };
}

const KEY = frameXmlCVarStorageKey("Account");

function boot(storage, { seamSetCVar } = {}) {
  const vm = new GlueLuaVm();
  const events = [];
  const clock = manualSchedule();
  const store = new FrameXmlCVarStore(storage, KEY, clock.schedule);
  vm.setGlobal("__fxNeutralImpl", {});
  vm.setGlobal("__fxAddonModules", []);
  vm.setGlobal("__fxLocale", "ruRU");
  const loaded = vm.execute(FRAMEXML_NEUTRAL_PRELUDE, "@cvar:neutral");
  assert.equal(loaded.ok, true, loaded.error);
  if (seamSetCVar) {
    // The seam's composition (FrameXmlWorldSeam.ts): a settings-backed name is handled by the host.
    vm.registerGlobal("__fxSeam_SetCVar", (args) => [seamSetCVar(args[0], args[1])]);
    const composed = vm.execute(`
      local impl = __fxNeutralImpl
      local neutral = impl.SetCVar
      impl.SetCVar = function(...)
        local handled = __fxSeam_SetCVar(...)
        if handled == true then return end
        return neutral(...)
      end`, "@cvar:seam");
    assert.equal(composed.ok, true, composed.error);
  }
  installFrameXmlCVarPersistence(vm, { raise: (event, ...args) => { events.push([event, ...args]); }, store });
  const globals = vm.execute(`
    SetCVar, GetCVar, RegisterCVar = __fxNeutralImpl.SetCVar, __fxNeutralImpl.GetCVar, __fxNeutralImpl.RegisterCVar
    SetModifiedClick, GetModifiedClick = __fxNeutralImpl.SetModifiedClick, __fxNeutralImpl.GetModifiedClick`, "@cvar:globals");
  assert.equal(globals.ok, true, globals.error);
  const lua = (source) => {
    const run = vm.execute(`__out = ${source}`, "@cvar:probe");
    assert.equal(run.ok, true, run.error);
    return vm.getGlobal("__out");
  };
  const exec = (source) => { const run = vm.execute(source, "@cvar:exec"); assert.equal(run.ok, true, run.error); };
  return { vm, events, store, clock, lua, exec };
}

test("SetCVar with an event name raises CVAR_UPDATE(event, value) once; without one, nothing", () => {
  const { vm, events, exec } = boot(memoryStorage());
  try {
    exec(`SetCVar("statusText", "1", "STATUS_TEXT_DISPLAY")`);
    assert.deepEqual(events, [["CVAR_UPDATE", "STATUS_TEXT_DISPLAY", "1"]]);
    exec(`SetCVar("statusText", "0")`);
    assert.equal(events.length, 1, "no third argument, no event");
    exec(`SetCVar("showTargetCastbar", 1, "SHOW_TARGET_CASTBAR")`);
    assert.deepEqual(events[1], ["CVAR_UPDATE", "SHOW_TARGET_CASTBAR", "1"], "the value as the string written");
    exec(`SetCVar("locale", "enUS", "LOCALE")`);
    assert.equal(events.length, 2, "a read-only CVar signals nothing");
  } finally { vm.close(); }
});

test("a settings-backed CVar handled by the seam still raises CVAR_UPDATE but is not kept here", () => {
  const storage = memoryStorage();
  const handled = [];
  const { vm, events, exec, store } = boot(storage, {
    seamSetCVar: (name, value) => {
      if (String(name).toLowerCase() !== "rotateminimap") return false;
      handled.push([name, value]);
      return true;
    },
  });
  try {
    exec(`SetCVar("rotateMinimap", "1", "ROTATE_MINIMAP")`);
    assert.deepEqual(handled, [["rotateMinimap", "1"]]);
    assert.deepEqual(events, [["CVAR_UPDATE", "ROTATE_MINIMAP", "1"]]);
    store.flush();
    assert.deepEqual(store.record().cvars, {}, "the browser setting carries it");
  } finally { vm.close(); }
});

test("written CVars are kept and seeded back before the corpus reads them", () => {
  const storage = memoryStorage();
  const first = boot(storage);
  try {
    first.exec(`SetCVar("threatWarning", "1")`);
    first.exec(`SetCVar("fooBar", 2)`);
    first.exec(`SetCVar("locale", "enUS")`);
    assert.equal(storage.map.size, 0, "the write waits for the delay");
    first.clock.runAll();
    assert.deepEqual(JSON.parse(storage.map.get(KEY)).cvars, { threatwarning: "1", foobar: "2" });
  } finally { first.vm.close(); }
  const second = boot(storage);
  try {
    assert.equal(second.lua(`GetCVar("fooBar")`), "2");
    assert.equal(second.lua(`GetCVar("threatWarning")`), "1", "the saved value beats the seeded default");
    second.exec(`RegisterCVar("fooBar", "9")`);
    assert.equal(second.lua(`GetCVar("fooBar")`), "2", "RegisterCVar does not overwrite a saved value");
    assert.equal(second.lua(`GetCVar("locale")`), "ruRU");
  } finally { second.vm.close(); }
});

test("SetModifiedClick survives a restart", () => {
  const storage = memoryStorage();
  const first = boot(storage);
  try {
    assert.equal(first.lua(`GetModifiedClick("SELFCAST")`), "ALT");
    first.exec(`SetModifiedClick("SELFCAST", "CTRL")`);
    first.store.flush();
  } finally { first.vm.close(); }
  assert.deepEqual(JSON.parse(storage.map.get(KEY)).modifiedClicks, { SELFCAST: "CTRL" });
  const second = boot(storage);
  try {
    assert.equal(second.lua(`GetModifiedClick("SELFCAST")`), "CTRL");
    assert.equal(second.lua(`GetModifiedClick("FOCUSCAST")`), "NONE", "the rest keep their defaults");
  } finally { second.vm.close(); }
});

test("the store rejects junk and oversized records and survives a throwing storage", () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({
    cvars: { ok: "1", "bad name": "1", long: "x".repeat(FRAMEXML_CVAR_MAX_VALUE + 1), num: 3 },
    modifiedClicks: [1, 2],
  }) });
  const store = new FrameXmlCVarStore(storage, KEY, () => () => {});
  assert.deepEqual(store.record(), { cvars: { ok: "1" }, modifiedClicks: {} });
  assert.equal(store.noteCVar("x", "y".repeat(FRAMEXML_CVAR_MAX_VALUE + 1)), false);
  for (let index = 0; index < FRAMEXML_CVAR_MAX_NAMES + 5; index += 1) store.noteCVar(`n${index}`, "1");
  assert.equal(Object.keys(store.record().cvars).length, FRAMEXML_CVAR_MAX_NAMES);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  const quiet = new FrameXmlCVarStore(broken, KEY, (run) => { run(); return () => {}; });
  assert.equal(quiet.noteCVar("a", "1"), true, "the session value stays although storage throws");
  assert.deepEqual(new FrameXmlCVarStore(memoryStorage({ [KEY]: "{not json" }), KEY).record(), { cvars: {}, modifiedClicks: {} });
});

test("only a string (or number) third argument is an event name, as lua_isstring decides", () => {
  const { vm, events, exec } = boot(memoryStorage());
  try {
    exec(`SetCVar("statusText", "1", true)`);
    exec(`SetCVar("statusText", "1", {})`);
    exec(`SetCVar("statusText", "1", nil)`);
    assert.deepEqual(events, []);
    exec(`SetCVar("statusText", nil, 7)`);
    assert.deepEqual(events, [["CVAR_UPDATE", "7", ""]], "nil writes the empty string");
  } finally { vm.close(); }
});

// The core folds only Latin letters in account names (Utf8ToUpperOnlyLatin, AccountMgr.cpp); the
// saved-variable key folds the same way (FrameXmlSavedVariables.ts). Two accounts whose names differ
// only in Cyrillic case are two accounts and keep two records.
test("the record key folds Latin case only, as the account names do", () => {
  assert.equal(frameXmlCVarStorageKey("Test"), frameXmlCVarStorageKey("TEST"));
  assert.notEqual(frameXmlCVarStorageKey("Вася"), frameXmlCVarStorageKey("вася"));
});
