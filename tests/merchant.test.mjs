import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBuyItem,
  buildBuybackItem,
  buildListInventory,
  buildSellItem,
  buyErrorText,
  parseBuyFailed,
  parseBuyItem,
  parseListInventory,
  parseSellItem,
  sellErrorText,
} from "../dist/code/world/VendorProtocol.js";
import {
  TRAINER_SPELL_AVAILABLE,
  TRAINER_SPELL_KNOWN,
  buildTrainerBuySpell,
  buildTrainerList,
  parseTrainerBuyFailed,
  parseTrainerBuySucceeded,
  parseTrainerList,
  trainerBuyFailureText,
  trainerSpellStateText,
} from "../dist/code/world/TrainerProtocol.js";

const encoder = new TextEncoder();

// ItemHandler.cpp SendListInventory: guid, count, then eight uint32 per item.
function listInventory(guid, items) {
  const bytes = new Uint8Array(8 + 1 + items.length * 32);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, guid, true);
  view.setUint8(8, items.length);
  items.forEach((item, index) => {
    const at = 9 + index * 32;
    view.setUint32(at, item.slot, true);
    view.setUint32(at + 4, item.itemId, true);
    view.setUint32(at + 8, item.displayId, true);
    view.setInt32(at + 12, item.leftInStock, true);
    view.setUint32(at + 16, item.price, true);
    view.setUint32(at + 20, item.maxDurability, true);
    view.setUint32(at + 24, item.buyCount, true);
    view.setUint32(at + 28, item.extendedCost, true);
  });
  return bytes;
}

test("vendor inventory decodes the eight field item entry", () => {
  const payload = listInventory(0x2aan, [
    { slot: 1, itemId: 6948, displayId: 6418, leftInStock: -1, price: 0, maxDurability: 0, buyCount: 1, extendedCost: 0 },
    { slot: 2, itemId: 117, displayId: 2473, leftInStock: 12, price: 25, maxDurability: 0, buyCount: 5, extendedCost: 0 },
  ]);
  const vendor = parseListInventory(payload);
  assert.equal(vendor.guid, 0x2aan);
  assert.equal(vendor.error, undefined);
  assert.equal(vendor.items.length, 2);
  assert.equal(vendor.items[0].leftInStock, -1); // unlimited
  assert.deepEqual(vendor.items[1], {
    slot: 2, itemId: 117, displayId: 2473, leftInStock: 12, price: 25,
    maxDurability: 0, buyCount: 5, extendedCost: 0,
  });
});

test("an empty vendor list carries the trailing error byte", () => {
  const bytes = new Uint8Array(10);
  new DataView(bytes.buffer).setBigUint64(0, 5n, true);
  const vendor = parseListInventory(bytes);
  assert.deepEqual(vendor.items, []);
  assert.equal(vendor.error, 0);
});

test("buy failure decodes with and without the optional parameter", () => {
  const short = new Uint8Array(13);
  const shortView = new DataView(short.buffer);
  shortView.setBigUint64(0, 9n, true);
  shortView.setUint32(8, 117, true);
  shortView.setUint8(12, 2);
  assert.deepEqual(parseBuyFailed(short), { guid: 9n, itemId: 117, param: undefined, error: 2 });
  assert.match(buyErrorText(2), /денег/i);

  const long = new Uint8Array(17);
  const longView = new DataView(long.buffer);
  longView.setBigUint64(0, 9n, true);
  longView.setUint32(8, 117, true);
  longView.setUint32(12, 40, true);
  longView.setUint8(16, 12);
  assert.deepEqual(parseBuyFailed(long), { guid: 9n, itemId: 117, param: 40, error: 12 });
});

test("sell errors decode, and the packet always means failure", () => {
  const bytes = new Uint8Array(17);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, 3n, true);
  view.setBigUint64(8, 0xfeedn, true);
  view.setUint8(16, 6);
  assert.deepEqual(parseSellItem(bytes), { guid: 3n, itemGuid: 0xfeedn, param: undefined, error: 6 });
  assert.match(sellErrorText(6), /пуст/i);
  assert.match(sellErrorText(42), /42/);
});

test("buy success reports the slot, remaining stock and count", () => {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, 7n, true);
  view.setUint32(8, 3, true);
  view.setInt32(12, -1, true);
  view.setUint32(16, 2, true);
  assert.deepEqual(parseBuyItem(bytes), { guid: 7n, slot: 3, leftInStock: -1, count: 2 });
});

test("client vendor packets match the handlers' reads", () => {
  assert.equal(buildListInventory(1n).length, 8);
  // HandleBuyItemOpcode reads guid, item, slot, count and one trailing byte.
  assert.equal(buildBuyItem(1n, 117, 2, 5).length, 8 + 4 + 4 + 4 + 1);
  assert.equal(buildSellItem(1n, 2n, 0).length, 8 + 8 + 4);
  assert.equal(buildBuybackItem(1n, 74).length, 8 + 4);
});

// NPCPackets.cpp TrainerList::Write: guid, type, count, 38 bytes per spell, then the greeting.
function trainerList(guid, type, spells, greeting) {
  const text = encoder.encode(greeting);
  const bytes = new Uint8Array(8 + 4 + 4 + spells.length * 38 + text.length + 1);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, guid, true);
  view.setInt32(8, type, true);
  view.setInt32(12, spells.length, true);
  spells.forEach((spell, index) => {
    const at = 16 + index * 38;
    view.setInt32(at, spell.spellId, true);
    view.setUint8(at + 4, spell.usable);
    view.setInt32(at + 5, spell.moneyCost, true);
    view.setInt32(at + 9, spell.pointCost[0], true);
    view.setInt32(at + 13, spell.pointCost[1], true);
    view.setUint8(at + 17, spell.requiredLevel);
    view.setInt32(at + 18, spell.requiredSkillLine, true);
    view.setInt32(at + 22, spell.requiredSkillRank, true);
    view.setInt32(at + 26, spell.requiredAbilities[0], true);
    view.setInt32(at + 30, spell.requiredAbilities[1], true);
    view.setInt32(at + 34, spell.requiredAbilities[2], true);
  });
  bytes.set(text, 16 + spells.length * 38);
  return bytes;
}

test("trainer list decodes the 38 byte spell entry and the trailing greeting", () => {
  const payload = trainerList(0x55n, 0, [
    {
      spellId: 1234, usable: TRAINER_SPELL_AVAILABLE, moneyCost: 1000, pointCost: [0, 0],
      requiredLevel: 10, requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [0, 0, 0],
    },
    {
      spellId: 5678, usable: TRAINER_SPELL_KNOWN, moneyCost: 0, pointCost: [0, 1],
      requiredLevel: 20, requiredSkillLine: 164, requiredSkillRank: 75, requiredAbilities: [1234, 0, 0],
    },
  ], "Чему тебя научить?");

  const trainer = parseTrainerList(payload);
  assert.equal(trainer.guid, 0x55n);
  assert.equal(trainer.trainerType, 0);
  assert.equal(trainer.greeting, "Чему тебя научить?");
  assert.equal(trainer.spells.length, 2);
  assert.equal(trainer.spells[0].moneyCost, 1000);
  assert.equal(trainer.spells[0].requiredLevel, 10);
  assert.deepEqual(trainer.spells[1].pointCost, [0, 1]);
  assert.equal(trainer.spells[1].requiredSkillLine, 164);
  assert.deepEqual(trainer.spells[1].requiredAbilities, [1234, 0, 0]);
  assert.equal(trainerSpellStateText(trainer.spells[1].usable), "уже изучено");
  assert.equal(trainerSpellStateText(trainer.spells[0].usable), "");
});

test("trainer buy results and failure reasons decode", () => {
  const success = new Uint8Array(12);
  const successView = new DataView(success.buffer);
  successView.setBigUint64(0, 0x55n, true);
  successView.setInt32(8, 1234, true);
  assert.deepEqual(parseTrainerBuySucceeded(success), { guid: 0x55n, spellId: 1234 });

  const failure = new Uint8Array(16);
  const failureView = new DataView(failure.buffer);
  failureView.setBigUint64(0, 0x55n, true);
  failureView.setInt32(8, 1234, true);
  failureView.setInt32(12, 1, true);
  assert.deepEqual(parseTrainerBuyFailed(failure), { guid: 0x55n, spellId: 1234, reason: 1 });
  // Trainer::FailReason has Unavailable at zero and NotEnoughMoney at one.
  assert.match(trainerBuyFailureText(1), /денег/i);
  assert.match(trainerBuyFailureText(0), /недоступн/i);

  assert.equal(buildTrainerList(1n).length, 8);
  assert.equal(buildTrainerBuySpell(1n, 5).length, 12);
});

test("an implausible trainer spell count is rejected", () => {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, 1n, true);
  view.setInt32(12, 0x7fff_ffff, true);
  assert.throws(() => parseTrainerList(bytes), RangeError);
});
