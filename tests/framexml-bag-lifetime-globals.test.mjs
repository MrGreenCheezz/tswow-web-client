import assert from "node:assert/strict";
import test from "node:test";

// The bag gate's stand-ins (FrameXmlWorldMount.ts frameXmlBagGate): a hidden, unnamed bridge frame
// answers InterfaceOptionsFrame/BankFrame/MerchantFrame/StackSplitFrame while the real frame is not
// loaded. The options chain loads later, on the first «Интерфейс» (FrameXmlOptionsOwner.ts), and its
// real InterfaceOptionsFrame takes the global over. Releasing the bag owner must then leave it:
// a global is released only while it still holds the frame the gate put there.
const { installOwnedGlobals, releaseOwnedGlobals } = await import("../dist/code/browser/framexml/FrameXmlBagCompat.js");
const { GlueLuaRef } = await import("../dist/code/browser/glue/GlueLua.js");

/** A VM with only globals: every write is logged with what it replaced. */
function fakeVm() {
  const globals = new Map();
  const cleared = [];
  const released = [];
  return {
    globals, cleared, released,
    getGlobal(name) { return globals.get(name); },
    setGlobal(name, value) {
      if (value === undefined) {
        cleared.push(name);
        globals.delete(name);
      } else globals.set(name, value);
    },
    release(ref) { released.push(ref.key); },
  };
}

/** What the gate installs: [name, frame] pairs, set in order. */
function install(vm, pairs) {
  for (const [name, frame] of pairs) vm.setGlobal(name, frame);
  return pairs;
}

const proxy = () => ({ name: undefined, type: "Frame", visible: false });
const real = (name) => ({ name, type: "Frame", visible: false });

test("a stand-in that still holds its global is released", () => {
  const vm = fakeVm();
  const stand = proxy();
  releaseOwnedGlobals(vm, install(vm, [["InterfaceOptionsFrame", stand], ["BankFrame", stand]]));
  assert.equal(vm.globals.has("InterfaceOptionsFrame"), false);
  assert.equal(vm.globals.has("BankFrame"), false);
});

test("the options chain's real InterfaceOptionsFrame outlives the bag owner that aliased it", () => {
  const vm = fakeVm();
  const stand = proxy();
  const installed = install(vm, [["InterfaceOptionsFrame", stand], ["MerchantFrame", stand]]);
  const options = real("InterfaceOptionsFrame");
  vm.setGlobal("InterfaceOptionsFrame", options); // the lazy chain: the original wins
  releaseOwnedGlobals(vm, installed);
  assert.equal(vm.globals.get("InterfaceOptionsFrame") === options, true, "the real frame is still the global");
  assert.deepEqual(vm.cleared, ["MerchantFrame"], "only the global still holding the stand-in is cleared");
});

test("the same for BankFrame, and for a real frame that replaced a real frame of the same name", () => {
  const vm = fakeVm();
  const stand = proxy();
  const loaded = real("StackSplitFrame");
  const installed = install(vm, [["BankFrame", stand], ["StackSplitFrame", loaded]]);
  const bank = real("BankFrame");
  const reloaded = real("StackSplitFrame");
  vm.setGlobal("BankFrame", bank);
  // A second StackSplitFrame.xml: another frame under the same name — not the one the gate installed.
  vm.setGlobal("StackSplitFrame", reloaded);
  releaseOwnedGlobals(vm, installed);
  assert.equal(vm.globals.get("BankFrame") === bank, true);
  assert.equal(vm.globals.get("StackSplitFrame") === reloaded, true, "compared by reference, not by name");
  assert.deepEqual(vm.cleared, []);
});

test("another stand-in (unnamed too) under the global is not this gate's", () => {
  const vm = fakeVm();
  const ours = proxy();
  const theirs = proxy();
  const installed = install(vm, [["InterfaceOptionsFrame", ours]]);
  vm.setGlobal("InterfaceOptionsFrame", theirs);
  releaseOwnedGlobals(vm, installed);
  assert.equal(vm.globals.get("InterfaceOptionsFrame") === theirs, true);
});

test("release runs newest first", () => {
  const vm = fakeVm();
  const stand = proxy();
  releaseOwnedGlobals(vm, install(vm, [
    ["InterfaceOptionsFrame", stand], ["BankFrame", stand], ["MerchantFrame", stand], ["StackSplitFrame", stand],
  ]));
  assert.deepEqual(vm.cleared, ["StackSplitFrame", "MerchantFrame", "BankFrame", "InterfaceOptionsFrame"]);
});

test("a global that cannot be read is left alone; a table read back is released, not cleared", () => {
  const vm = fakeVm();
  const stand = proxy();
  const installed = install(vm, [["InterfaceOptionsFrame", stand], ["BankFrame", stand], ["MerchantFrame", stand]]);
  const table = new GlueLuaRef(41, "table");
  vm.setGlobal("BankFrame", table);
  const read = vm.getGlobal;
  vm.getGlobal = (name) => {
    if (name === "InterfaceOptionsFrame") throw new Error("closed state");
    return read(name);
  };
  releaseOwnedGlobals(vm, installed);
  assert.deepEqual(vm.cleared, ["MerchantFrame"]);
  assert.equal(vm.globals.get("InterfaceOptionsFrame") === stand, true, "unreadable: not touched");
  assert.deepEqual(vm.released, [41], "the scratch handle getGlobal returned is released");
});

test("a stand-in is installed only where the global is still empty: a real frame that took it over is never covered", () => {
  const vm = fakeVm();
  const stand = proxy();
  const options = real("InterfaceOptionsFrame");
  vm.setGlobal("InterfaceOptionsFrame", options);
  const installed = [];
  installOwnedGlobals(vm, [["InterfaceOptionsFrame", stand], ["BankFrame", stand], ["MerchantFrame", stand]], installed);
  assert.deepEqual(installed.map(([name]) => name), ["BankFrame", "MerchantFrame"], "only the empty globals are the gate's");
  assert.equal(vm.globals.get("InterfaceOptionsFrame") === options, true, "the real frame keeps its global");
  assert.equal(vm.globals.get("BankFrame") === stand, true);
  releaseOwnedGlobals(vm, installed);
  assert.equal(vm.globals.get("InterfaceOptionsFrame") === options, true);
  assert.deepEqual(vm.cleared, ["MerchantFrame", "BankFrame"]);
});

test("installing again over the gate's own stand-in keeps it installed; a table or unreadable global is left alone", () => {
  const vm = fakeVm();
  const stand = proxy();
  vm.setGlobal("InterfaceOptionsFrame", stand);
  vm.setGlobal("BankFrame", new GlueLuaRef(52, "table"));
  const read = vm.getGlobal;
  vm.getGlobal = (name) => {
    if (name === "StackSplitFrame") throw new Error("closed state");
    return read(name);
  };
  const installed = [];
  installOwnedGlobals(vm, [["InterfaceOptionsFrame", stand], ["BankFrame", stand], ["StackSplitFrame", stand]], installed);
  assert.deepEqual(installed.map(([name]) => name), ["InterfaceOptionsFrame"]);
  assert.deepEqual(vm.released, [52], "the scratch handle is released");
  assert.equal(vm.globals.has("StackSplitFrame"), false, "unreadable: nothing written");
});

test("a VM that refuses an install throws with what it installed so far listed for release", () => {
  const vm = fakeVm();
  const stand = proxy();
  const write = vm.setGlobal;
  vm.setGlobal = (name, value) => {
    if (name === "MerchantFrame" && value !== undefined) throw new Error("refused");
    write(name, value);
  };
  const installed = [];
  assert.throws(() => installOwnedGlobals(vm, [["InterfaceOptionsFrame", stand], ["MerchantFrame", stand]], installed),
    /refused/);
  assert.deepEqual(installed.map(([name]) => name), ["InterfaceOptionsFrame"]);
  releaseOwnedGlobals(vm, installed);
  assert.equal(vm.globals.has("InterfaceOptionsFrame"), false);
});

test("a VM that refuses a write does not stop the rest", () => {
  const vm = fakeVm();
  const stand = proxy();
  const installed = install(vm, [["InterfaceOptionsFrame", stand], ["BankFrame", stand]]);
  const write = vm.setGlobal;
  vm.setGlobal = (name, value) => {
    if (name === "BankFrame") throw new Error("refused");
    write(name, value);
  };
  releaseOwnedGlobals(vm, installed);
  assert.deepEqual(vm.cleared, ["InterfaceOptionsFrame"]);
});
