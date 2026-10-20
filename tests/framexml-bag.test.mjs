import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-bag-controller.test.mjs
{
const controller = await import("../dist/code/browser/framexml/FrameXmlBagController.js");

function owner() {
  return {
    open: false,
    backpackToggles: 0,
    bagToggles: [],
    keyringToggles: 0,
    closes: 0,
    disposals: 0,
    isOpen() { return this.open; },
    toggleBackpack() { this.open = !this.open; this.backpackToggles++; },
    toggleBag(index) { this.bagToggles.push(index); this.open = true; },
    toggleKeyring() { this.keyringToggles++; this.open = !this.open; },
    toggleAllBags() { this.open = !this.open; },
    close() { this.open = false; this.closes++; },
    dispose() { this.disposals++; },
  };
}

test("stock bags controller routes all bag verbs through one owner", () => {
  const first = owner();
  const releaseFirst = controller.publishFrameXmlBags(first);

  assert.equal(controller.frameXmlBagsOpen(), false);
  assert.equal(controller.toggleFrameXmlBags(), true);
  assert.equal(first.open, true);
  assert.equal(controller.toggleFrameXmlBackpack(), true);
  assert.equal(first.backpackToggles, 1);
  assert.equal(controller.toggleFrameXmlBag(2), true);
  assert.deepEqual(first.bagToggles, [2]);
  assert.equal(controller.toggleFrameXmlKeyring(), true);
  assert.equal(first.keyringToggles, 1);
  assert.equal(controller.closeFrameXmlBags(), true);
  assert.equal(first.closes, 1);
  assert.equal(controller.frameXmlBagsOpen(), false);
  releaseFirst();
  assert.equal(first.disposals, 1, "owner disposal releases lifetime compatibility state");
  assert.equal(controller.toggleFrameXmlBags(), false);
});

test("a stale bag cleanup cannot clear the current owner", () => {
  const first = owner();
  const releaseFirst = controller.publishFrameXmlBags(first);
  const second = owner();
  const releaseSecond = controller.publishFrameXmlBags(second);

  assert.equal(first.closes, 1, "publishing a replacement closes the old owner");
  assert.equal(first.disposals, 1, "publishing a replacement disposes the old owner");
  releaseFirst();
  assert.equal(controller.toggleFrameXmlBackpack(), true);
  assert.equal(second.backpackToggles, 1);
  releaseSecond();
  releaseSecond();
  assert.equal(controller.frameXmlBagsOpen(), false);
});

test("without a gated owner the caller keeps the native fallback", () => {
  assert.equal(controller.toggleFrameXmlBags(), false);
  assert.equal(controller.toggleFrameXmlBackpack(), false);
  assert.equal(controller.toggleFrameXmlBag(1), false);
  assert.equal(controller.toggleFrameXmlKeyring(), false);
  assert.equal(controller.closeFrameXmlBags(), false);
});
}

// ── framexml-bag-lifetime-globals.test.mjs
{
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
}

// ── framexml-bag-seam.test.mjs
{
const {
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

test("the stock container C-API keeps bag ids distinct and exposes item tuple fields", () => {
  assert.equal(FRAMEXML_SEAM_EVENTS.bagUpdate, "BAG_UPDATE");
  assert.equal(FRAMEXML_SEAM_EVENTS.itemLockChanged, "ITEM_LOCK_CHANGED");
  assert.equal(FRAMEXML_SEAM_EVENTS.bagUpdateCooldown, "BAG_UPDATE_COOLDOWN");
  for (const name of [
    "GetContainerNumSlots",
    "GetContainerNumFreeSlots",
    "GetContainerItemInfo",
    "GetContainerItemLink",
    "GetContainerItemCooldown",
    "GetBagName",
    "UseContainerItem",
  ]) assert.equal(typeof FRAMEXML_SEAM_BINDINGS[name], "function", name);

  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 10 });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("GetContainerNumSlots", 0), [16]);
  assert.deepEqual(call("GetContainerNumSlots", 1), [4], "bag 1 is the carried container in host slot 19");
  assert.deepEqual(call("GetContainerNumFreeSlots", 0), [15, 0]);
  assert.deepEqual(call("GetContainerItemInfo", 0, 1), [
    "Interface\\Icons\\INV_Potion_54", 5, undefined, 1, undefined,
  ]);
  assert.deepEqual(call("GetContainerItemInfo", 0, 2), [], "empty slots answer Lua nil");
  assert.deepEqual(call("GetContainerItemLink", 0, 2), []);
  assert.deepEqual(call("GetContainerItemCooldown", 0, 1), [0, 0, 0]);
  assert.deepEqual(call("GetBagName", 0), ["Рюкзак"]);
  assert.deepEqual(call("GetContainerItemInfo", 1, 1), [
    "Interface\\Icons\\INV_Potion_54", 1, undefined, 1, undefined,
  ]);
  assert.deepEqual(call("GetContainerNumFreeSlots", 1), [3, 0]);
  assert.deepEqual(call("GetBagName", 1), ["Сумка"]);
  assert.deepEqual(call("UseContainerItem", 0, 1), []);
  assert.deepEqual(seam.usedContainerItems, [{ bag: 255, slot: 23 }]);
  assert.deepEqual(call("UseContainerItem", 1, 1), []);
  assert.deepEqual(seam.usedContainerItems, [{ bag: 255, slot: 23 }, { bag: 19, slot: 0 }]);
  assert.deepEqual(call("GetContainerNumSlots", -2), [32]);
  assert.deepEqual(call("GetContainerNumFreeSlots", -2), [32, 0]);
  assert.deepEqual(call("GetBagName", -2), ["Связка ключей"]);
  assert.equal(seam.setContainerItem(-2, 1, {
    texture: "Interface\\Icons\\INV_Misc_Key_05", count: 1,
  }), 1);
  assert.deepEqual(call("GetContainerItemInfo", -2, 1), [
    "Interface\\Icons\\INV_Misc_Key_05", 1, undefined, undefined, undefined,
  ]);
  assert.deepEqual(call("UseContainerItem", -2, 1), []);
  assert.deepEqual(seam.usedContainerItems, [
    { bag: 255, slot: 23 }, { bag: 19, slot: 0 }, { bag: 255, slot: 86 },
  ]);
  assert.deepEqual(call("GetContainerNumSlots", -999), [0], "unsupported container is empty");
  assert.ok(fired.some(([event, id]) => event === FRAMEXML_SEAM_EVENTS.bagUpdate && id === 0));
});

test("a canned container mutation emits the stock BAG_UPDATE signature", () => {
  const seam = new CannedWorldSeam();
  let now = 20;
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => now });
  fired.length = 0;
  assert.equal(seam.setContainerItem(0, 1, undefined), 1);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.bagUpdate, 0]]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetContainerItemInfo(seam, [0, 1]), []);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.UseContainerItem(seam, [0, 1]), []);
  assert.deepEqual(seam.usedContainerItems, [], "empty slots cannot be used");
  now += 1;
  assert.equal(seam.setContainerItem(0, 2, {
    texture: "Interface\\Icons\\INV_Misc_QuestionMark", count: 2, quality: 0,
    locked: true, readable: false, cooldown: [3, 4, 1], link: "|Hitem:13446|h[Зелье]|h",
  }), 1);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetContainerItemInfo(seam, [0, 2]), [
    "Interface\\Icons\\INV_Misc_QuestionMark", 2, true, 0, false,
  ]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetContainerItemCooldown(seam, [0, 2]), [3, 4, 1]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetContainerItemLink(seam, [0, 2]), ["|Hitem:13446|h[Зелье]|h"]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.UseContainerItem(seam, [0, 2]), []);
  assert.deepEqual(seam.usedContainerItems, [{ bag: 255, slot: 24 }]);
});

test("live container texture cache changes repaint once at the existing poll boundary", () => {
  const selfGuid = 0x10n;
  const itemGuid = 0x20n;
  const playerFields = new Map([
    [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, Number(itemGuid)],
    [UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 1, 0],
    [UPDATE_FIELDS.PLAYER_FIELD_KEYRING_SLOT_1.offset, Number(0x30n)],
    [UPDATE_FIELDS.PLAYER_FIELD_KEYRING_SLOT_1.offset + 1, 0],
  ]);
  const itemFields = new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 13446],
    [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 2],
  ]);
  const keyFields = new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 20815],
  ]);
  const worldEvents = { on: () => () => {} };
  const anyListeners = new Set();
  const store = {
    field: () => () => {},
    any: (listener) => { anyListeners.add(listener); return () => anyListeners.delete(listener); },
  };
  const player = { guid: selfGuid, typeId: 4, fields: playerFields };
  const used = [];
  const world = {
    state: {
      selfGuid,
      objects: new Map([
        [selfGuid, player],
        [itemGuid, { guid: itemGuid, fields: itemFields }],
        [0x30n, { guid: 0x30n, fields: keyFields }],
      ]),
    },
    actionButtons: [], casts: new Map(), events: worldEvents, itemTemplates: new Map([
      [13446, { entry: 13446, found: true, name: "Зелье", quality: 1, bagFamily: 0 }],
    ]),
    cooldownRemaining: () => 0,
    useItem: (...args) => { used.push(args); },
  };
  let texture;
  let clock = 10;
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    itemTexture: (entry) => entry === 20815 ? "Interface\\Icons\\INV_Misc_Key_05" : texture,
  });
  const pump = {
    fire: (event, ...args) => { fired.push([event, ...args]); return 1; },
    now: () => clock,
  };
  seam.attach(pump);
  fired.length = 0;
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetContainerItemInfo(seam, [0, 1]), [
    undefined, 2, undefined, 1, undefined,
  ]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetContainerNumSlots(seam, [-2]), [32]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetContainerNumFreeSlots(seam, [-2]), [31, 0]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetBagName(seam, [-2]), ["Связка ключей"]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetContainerItemInfo(seam, [-2, 1]), [
    "Interface\\Icons\\INV_Misc_Key_05", 1, undefined, undefined, undefined,
  ]);
  FRAMEXML_SEAM_BINDINGS.UseContainerItem(seam, [-2, 1]);
  assert.deepEqual(used, [ [255, 86, 0x30n] ]);
  fired.length = 0;
  keyFields.set(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 2);
  for (const listener of anyListeners) listener();
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.bagUpdate, -2]],
    "one WorldStore.any batch repaints only the changed keyring");
  fired.length = 0;
  seam.tick(clock);
  fired.length = 0;
  texture = "https://cached.invalid/item/13446";
  clock += 0.04;
  seam.tick(clock);
  assert.deepEqual(fired, [], "sub-60ms ticks do not rescan containers");
  clock += 0.03;
  seam.tick(clock);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.bagUpdate, 0]]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetContainerItemInfo(seam, [0, 1]), [
    "https://cached.invalid/item/13446", 2, undefined, 1, undefined,
  ]);
  seam.detach();
  assert.equal(anyListeners.size, 0);
});

test("money uses authoritative player coinage and dedupes PLAYER_MONEY", () => {
  assert.equal(FRAMEXML_SEAM_EVENTS.playerMoney, "PLAYER_MONEY");
  assert.equal(typeof FRAMEXML_SEAM_BINDINGS.GetMoney, "function");

  const canned = new CannedWorldSeam();
  const fired = [];
  canned.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 1 });
  fired.length = 0;
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetMoney(canned, []), [123456]);
  assert.equal(canned.setPlayerMoney(123456), 0, "unchanged coinage stays quiet");
  assert.equal(canned.setPlayerMoney(123457), 1);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.playerMoney]]);
});

test("live GetMoney follows PLAYER_FIELD_COINAGE once per changed field", () => {
  const selfGuid = 0x40n;
  const playerFields = new Map([
    [UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset, 5000],
  ]);
  const anyListeners = new Set();
  const store = {
    field: () => () => {},
    any: (listener) => { anyListeners.add(listener); return () => anyListeners.delete(listener); },
  };
  const world = {
    state: {
      selfGuid,
      objects: new Map([[selfGuid, { guid: selfGuid, typeId: 4, fields: playerFields }]]),
    },
    actionButtons: [], casts: new Map(), events: { on: () => () => {} }, itemTemplates: new Map(),
    cooldownRemaining: () => 0,
  };
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: () => undefined,
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 1 });
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetMoney(seam, []), [5000]);
  fired.length = 0;
  playerFields.set(UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset, 5001);
  for (const listener of anyListeners) listener();
  for (const listener of anyListeners) listener();
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.playerMoney]], "same coinage does not duplicate");
  seam.detach();
});
}
