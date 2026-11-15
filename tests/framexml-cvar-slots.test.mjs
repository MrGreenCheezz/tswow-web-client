// 5.37 (15.11): the stock interface's own CVars that Wow.exe keeps in the account's config slots (flags 0x10/0x20 of
// framexml/WowCVarRegistry.ts) reach the FrameXML VM from the slots (at boot and when the answer comes later), the
// stock interface's writes go back to them, and GetCVarDefault answers the registered default.
import assert from "node:assert/strict";
import test from "node:test";

const { FRAMEXML_NEUTRAL_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { installFrameXmlCVarPersistence } = await import("../dist/code/browser/framexml/FrameXmlCVarPersistence.js");
const { setStockCVarSlots } = await import("../dist/code/browser/ui/StockCVarSlots.js");

function fakeSlots(rows) {
  const notes = [];
  let listener;
  return {
    notes,
    push(next) { rows = next; listener?.(next); },
    rows: () => rows,
    note: (name, value) => { notes.push([name, value]); return true; },
    subscribe: (fn) => { listener = fn; return () => { listener = undefined; }; },
  };
}

function boot() {
  const vm = new GlueLuaVm();
  vm.setGlobal("__fxNeutralImpl", {});
  vm.setGlobal("__fxAddonModules", []);
  vm.setGlobal("__fxLocale", "ruRU");
  const loaded = vm.execute(FRAMEXML_NEUTRAL_PRELUDE, "@slots:neutral");
  assert.equal(loaded.ok, true, loaded.error);
  installFrameXmlCVarPersistence(vm, { raise: () => {} });
  const lua = (source) => {
    const run = vm.execute(`__out = ${source}`, "@slots:probe");
    assert.equal(run.ok, true, run.error);
    return vm.getGlobal("__out");
  };
  return { vm, lua };
}

test("slot values seed the VM, later answers reach it, the interface's writes go to the slots, defaults are Wow.exe's", () => {
  const slots = fakeSlots([["trackedQuests", "v##A"], ["minimapZoom", "1"]]);
  setStockCVarSlots(slots);
  const { vm, lua } = boot();
  try {
    assert.equal(lua(`__fxNeutralImpl.GetCVar("trackedQuests")`), "v##A", "seeded at boot");
    assert.equal(lua(`__fxNeutralImpl.GetCVar("MINIMAPZOOM")`), "1");
    slots.push([["lfgSelectedRoles", "6"]]);
    assert.equal(lua(`__fxNeutralImpl.GetCVar("lfgSelectedRoles")`), "6", "an answer after the boot");
    vm.execute(`__fxNeutralImpl.SetCVar("minimapZoom", "4")`, "@slots:set");
    assert.deepEqual(slots.notes.at(-1), ["minimapzoom", "4"], "the write is reported (the store maps the name)");
    assert.equal(lua(`__fxNeutralImpl.GetCVarDefault("minimapZoom")`), "3", "0x0051d9b0 registers it with \"3\"");
    assert.equal(lua(`__fxNeutralImpl.GetCVarDefault("showToastWindow")`), "1");
    assert.equal(lua(`__fxNeutralImpl.GetCVarDefault("noSuchCVarAnywhere")`), undefined);
  } finally {
    vm.close();
    setStockCVarSlots(undefined);
  }
});
