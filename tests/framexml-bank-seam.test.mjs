import assert from "node:assert/strict";
import test from "node:test";

// The stock BankFrame's C API over a player inventory: the three ways stock addresses the bank
// (container -1/5..11, inventory ids 40..74, PLAYERBANKSLOTS_CHANGED 1..35), and the moves the
// client makes (right-click across the bank, bag slots through the item cursor, split, purchase).
// MPQ-free; BankFrame.lua runs in framexml-bank-vertical.test.mjs.
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const {
  FRAMEXML_BANK_BINDINGS, FrameXmlBankModel, frameXmlBankButtonInventoryId, frameXmlBankContainer,
  frameXmlBankInventorySlot, frameXmlIsBankContainer,
} = await import("../dist/code/browser/framexml/FrameXmlBank.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { bankSlotResultText } = await import("../dist/code/world/BankProtocol.js");

const ENTRY = UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset;
const STACK = UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset;
const item = (entry, count = 1) => ({ fields: new Map([[ENTRY, entry], [STACK, count]]) });
const slot = (bag, index, object, guid) => ({ index, item: object, guid: object ? guid : 0n, bag, slot: index });

/** 28 bank slots (two filled), one bank bag in slot 67 (4 slots, one filled), two slots bought. */
function inventory() {
  const bank = Array.from({ length: 28 }, (_, index) => ({ index, item: undefined, guid: 0n, bag: 255, slot: 39 + index }));
  bank[0] = { ...bank[0], item: item(2589, 20), guid: 101n };
  bank[27] = { ...bank[27], item: item(5179), guid: 102n };
  const bagItem = item(4496);
  const bankBag = { bag: bagItem, guid: 200n, bagSlot: 67, slots: [slot(67, 0, item(765, 3), 201n), slot(67, 1), slot(67, 2), slot(67, 3)] };
  const backpack = Array.from({ length: 16 }, (_, index) => ({ index, item: undefined, guid: 0n, bag: 255, slot: 23 + index }));
  backpack[2] = { ...backpack[2], item: item(118, 5), guid: 301n };
  return { equipment: [], backpack, bags: [], keyring: [], bank, bankBags: [bankBag], bankBagSlotsBought: 2, buyback: [] };
}

const TEMPLATES = new Map([
  [4496, { found: true, name: "Маленький коричневый мешочек", bagFamily: 0, itemClass: 1, startQuest: 0 }],
  [5179, { found: true, name: "Письмо Хогарта", bagFamily: 0, itemClass: 12, startQuest: 3102 }],
  [765, { found: true, name: "Сребролист", bagFamily: 0, itemClass: 7, startQuest: 0 }],
]);

function fixture({ closed = false, cursor } = {}) {
  const calls = [];
  let state = inventory();
  const world = {
    bankerGuid: closed ? undefined : 7n,
    buyBankSlot: () => calls.push(["buy"]),
    depositToBank: (bag, slot) => calls.push(["deposit", bag, slot]),
    withdrawFromBank: (bag, slot) => calls.push(["withdraw", bag, slot]),
    storeItemInBag: (bag, slot, into) => calls.push(["store", bag, slot, into]),
    splitItem: (...args) => calls.push(["split", ...args]),
  };
  const model = new FrameXmlBankModel({
    world: () => world,
    inventory: () => state,
    itemTemplate: (entry) => TEMPLATES.get(entry),
    questLogged: (questId) => questId === 3102,
    cursorSlot: () => cursor,
    clickBankSlot: (bag, slotId) => { calls.push(["click", bag, slotId]); return true; },
    clearCursor: () => calls.push(["clear"]),
    containerSlot: (bagId, index) => bagId === 0 ? state.backpack[index - 1] : undefined,
  });
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  const call = (name, ...args) => FRAMEXML_BANK_BINDINGS[name]({ bank: model }, args);
  return { model, world, calls, fired, call, set state(next) { state = next; }, get state() { return state; } };
}

test("BankButtonIDToInvSlotID: generic 1..28 are inventory 40..67, bag buttons 5..11 are 68..74", () => {
  assert.equal(frameXmlBankButtonInventoryId(1, false), 40);
  assert.equal(frameXmlBankButtonInventoryId(28, false), 67);
  assert.equal(frameXmlBankButtonInventoryId(5, true), 68);
  assert.equal(frameXmlBankButtonInventoryId(11, true), 74);
  assert.equal(frameXmlBankButtonInventoryId(29, false), undefined);
  assert.equal(frameXmlBankButtonInventoryId(4, true), undefined);
  const { call } = fixture();
  assert.deepEqual(call("BankButtonIDToInvSlotID", 3), [42]);
  assert.deepEqual(call("BankButtonIDToInvSlotID", 6, 1), [69]);
  assert.deepEqual(call("BankButtonIDToInvSlotID", 6, undefined), [45], "nil isBag: a generic button");
});

test("the bank as containers and as inventory ids reads the same player slots", () => {
  const state = inventory();
  const bank = frameXmlBankContainer(-1, state);
  assert.equal(bank.slots.length, 28);
  assert.equal(bank.slots[0].guid, 101n);
  const bag = frameXmlBankContainer(5, state, (entry) => TEMPLATES.get(entry));
  assert.deepEqual([bag.slots.length, bag.name, bag.bagFamily], [4, "Маленький коричневый мешочек", 0]);
  assert.equal(frameXmlBankContainer(6, state), undefined, "a bought slot with no bag has no container");
  assert.equal(frameXmlBankContainer(4, state), undefined, "4 is a carried bag, not the bank's");
  assert.ok([-1, 5, 11].every(frameXmlIsBankContainer) && ![-2, 0, 4, 12].some(frameXmlIsBankContainer));
  assert.equal(frameXmlBankInventorySlot(state, 40).guid, 101n, "inventory 40 is bank slot 39");
  assert.equal(frameXmlBankInventorySlot(state, 68).guid, 200n, "inventory 68 is the bag in bank bag slot 67");
  assert.equal(frameXmlBankInventorySlot(state, 69).item, undefined);
  assert.equal(frameXmlBankInventorySlot(state, 23), undefined, "equipment ids are the seam's own");
});

test("GetContainerItemQuestInfo answers from the item template, for bank and carried bags alike", () => {
  const { call } = fixture();
  assert.deepEqual(call("GetContainerItemQuestInfo", -1, 28), [true, 3102, true], "a quest item that starts a logged quest");
  assert.deepEqual(call("GetContainerItemQuestInfo", -1, 1), [false], "no template: an ordinary item");
  assert.deepEqual(call("GetContainerItemQuestInfo", 5, 1), [false, undefined, undefined]);
  assert.deepEqual(call("GetContainerItemQuestInfo", 0, 3), [false], "the backpack goes through the seam's projection");
});

test("right-click moves across the bank only while the banker's permission stands", () => {
  const open = fixture();
  assert.equal(open.model.useContainerItem(-1, 1), true);
  assert.equal(open.model.useContainerItem(5, 1), true);
  assert.equal(open.model.useContainerItem(0, 3), true);
  assert.equal(open.model.useContainerItem(-1, 2), false, "an empty slot is nobody's move");
  assert.deepEqual(open.calls, [["withdraw", 255, 39], ["withdraw", 67, 0], ["deposit", 255, 25]],
    "CMSG_AUTOSTORE_BANK_ITEM out, CMSG_AUTOBANK_ITEM in, addressed as the opcodes address them");
  const shut = fixture({ closed: true });
  assert.equal(shut.model.useContainerItem(0, 3), false, "no banker: the ordinary item use");
  assert.deepEqual(shut.calls, []);
  open.model.muted(() => assert.equal(open.model.useContainerItem(-1, 1), true));
  assert.equal(open.calls.length, 3, "muted sends nothing");
});

test("bag slots go through the one item cursor; a split lands on its own side; purchase needs the banker", () => {
  const empty = fixture();
  assert.deepEqual(empty.call("PutItemInBag", 69), [false], "no cursor item: stock opens the bag");
  empty.call("PickupBagFromSlot", 68);
  assert.deepEqual(empty.calls, [["click", 255, 67]], "the bag itself onto the cursor");
  empty.call("PickupBagFromSlot", 20);
  assert.equal(empty.calls.length, 1, "a carried bag slot is not the bank's");

  const held = fixture({ cursor: { bag: 255, slot: 25 } });
  assert.deepEqual(held.call("PutItemInBag", 68), [true]);
  assert.deepEqual(held.call("PutItemInBag", 69), [true]);
  assert.deepEqual(held.calls, [["store", 255, 25, 67], ["clear"], ["click", 255, 68]],
    "into the bag in slot 67 (CMSG_AUTOSTORE_BAG_ITEM); into the empty slot 68 itself");

  const { call, calls } = fixture();
  call("SplitContainerItem", -1, 1, 5);
  call("SplitContainerItem", 0, 3, 2);
  call("SplitContainerItem", -1, 1, 20);
  assert.deepEqual(calls, [["split", 255, 39, 255, 40, 5], ["split", 255, 25, 255, 23, 2]],
    "to the first free bank slot and the first free backpack slot; a whole stack is not a split");
  call("PurchaseSlot");
  assert.deepEqual(calls.at(-1), ["buy"]);
  const shut = fixture({ closed: true });
  shut.call("PurchaseSlot");
  shut.call("SplitContainerItem", -1, 1, 5);
  assert.deepEqual(shut.calls, []);
  assert.deepEqual(call("ResetCursor"), []);
});

test("one inventory mutation: PLAYERBANKSLOTS_CHANGED per moved slot, BAG_UPDATE per changed bank bag", () => {
  const fx = fixture();
  fx.model.reconcile();
  assert.deepEqual(fx.fired, [], "attach took the baseline");
  const next = inventory();
  next.bank[4] = { ...next.bank[4], item: item(2589, 1), guid: 103n };
  next.bankBags[0].slots[0] = slot(67, 0, item(765, 4), 201n);
  next.bankBags.push({ bag: item(4496), guid: 210n, bagSlot: 68, slots: [slot(68, 0)] });
  fx.state = next;
  fx.model.reconcile();
  assert.deepEqual(fx.fired, [["PLAYERBANKSLOTS_CHANGED", 5], ["PLAYERBANKSLOTS_CHANGED", 30], ["BAG_UPDATE", 5], ["BAG_UPDATE", 6]],
    "slot 5; bag slot 2 is 28 + 2; bag 5's stack moved; bag 6 appeared");
  fx.model.reconcile();
  assert.equal(fx.fired.length, 4, "no change, no edge");
});

test("no banker, no bank edges: a closed bank is not measured, and opening it takes a fresh baseline", () => {
  const fx = fixture({ closed: true });
  const moved = inventory();
  moved.bank[4] = { ...moved.bank[4], item: item(2589, 1), guid: 103n };
  fx.state = moved;
  fx.model.reconcile();
  assert.deepEqual(fx.fired, [], "the store's per-frame edge costs nothing while no banker is open");
  fx.world.bankerGuid = 7n;
  fx.model.reconcile();
  assert.deepEqual(fx.fired, [], "a world without BANK_OPENED is re-baselined on the first edge after opening");
  const next = inventory();
  next.bank[4] = { ...next.bank[4], item: item(2589, 1), guid: 103n };
  next.bank[5] = { ...next.bank[5], item: item(2589, 2), guid: 104n };
  fx.state = next;
  fx.model.reconcile();
  assert.deepEqual(fx.fired, [["PLAYERBANKSLOTS_CHANGED", 6]]);
});

test("a slot repaints when its item's icon or quality arrives, a bank bag when its name does", () => {
  let appearance = () => "";
  const templates = new Map(TEMPLATES);
  let state = inventory();
  const model = new FrameXmlBankModel({
    world: () => ({ bankerGuid: 7n }),
    inventory: () => state,
    itemTemplate: (entry) => templates.get(entry),
    itemAppearance: (entry) => appearance(entry),
  });
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  appearance = (entry) => entry === 5179 ? "1:Interface\\Icons\\INV_Letter_01" : "";
  model.reconcile();
  assert.deepEqual(fired, [["PLAYERBANKSLOTS_CHANGED", 28]]);
  templates.set(4496, { ...templates.get(4496), name: "Мешочек" });
  model.reconcile();
  assert.deepEqual(fired.slice(1), [["BAG_UPDATE", 5]]);
});

test("a refused purchase is said in UIErrorsFrame in the client's words, only while stock owns the bank", () => {
  const listeners = [];
  const world = {
    bankerGuid: 7n,
    bankMessage: undefined,
    events: { on(name, listener) { if (name === "BANK_OPENED") listeners.push(listener); return () => {}; } },
  };
  const answer = (result) => {
    world.bankMessage = { text: bankSlotResultText(result), error: result !== 3 };
    for (const listener of listeners) listener({ bankerGuid: world.bankerGuid });
  };
  const model = new FrameXmlBankModel({ world: () => world, inventory: () => undefined });
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  answer(1);
  assert.deepEqual(fired, [], "unpublished: the native window prints the answer itself");
  const strings = new Map([
    ["ERR_BANKSLOT_FAILED_TOO_MANY", "Вы уже используете все ячейки для сумок!"],
    ["ERR_BANKSLOT_INSUFFICIENT_FUNDS", "У вас недостаточно средств."],
    ["ERR_BANKSLOT_NOTBANKER", "Это не банкир!"],
  ]);
  model.owned = true;
  model.useGlobalStrings((name) => strings.get(name));
  answer(1);
  answer(0);
  answer(2);
  answer(3);
  assert.deepEqual(fired, [
    ["UI_ERROR_MESSAGE", "У вас недостаточно средств."],
    ["UI_ERROR_MESSAGE", "Вы уже используете все ячейки для сумок!"],
    ["UI_ERROR_MESSAGE", "Это не банкир!"],
  ], "SMSG_BUY_BANK_SLOT_RESULT 1, 0, 2 (Player.h:122-124); 3 bought the slot and says nothing");
  model.useGlobalStrings(undefined);
  answer(1);
  assert.deepEqual(fired.at(-1), ["UI_ERROR_MESSAGE", "Не хватает денег на ячейку банка"], "no VM strings: the world's own words");
  model.muted(() => answer(1));
  assert.equal(fired.length, 4, "a muted probe says nothing");
});

test("the seam table carries the bank C API; a seam without the model answers nothing", () => {
  for (const name of Object.keys(FRAMEXML_BANK_BINDINGS)) assert.ok(FRAMEXML_SEAM_BINDINGS[name], name);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.PutItemInBag({}, [68]), []);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.BankButtonIDToInvSlotID({}, [1]), [40], "a pure mapping needs no model");
});
