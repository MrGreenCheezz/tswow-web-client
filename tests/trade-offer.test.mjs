import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { firstFreeTradeSlot } from "../dist/code/world/TradeProtocol.js";

// `ItemSlots.js` resolves `Dom.ts` handles at import time, so the document stub goes first
// and the module arrives dynamically — the same order `loot.test.mjs` uses for `Npc.js`.
const fakeNode = () => {
  const node = {
    children: [], dataset: {}, className: "", textContent: "", hidden: false, disabled: false,
    value: "", type: "",
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append() {}, appendChild(child) { return child; }, replaceChildren() {},
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector: () => fakeNode(), querySelectorAll: () => [],
  };
  return node;
};
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.document = {
  createElement: fakeNode, createElementNS: (_ns, _tag) => fakeNode(),
  body: fakeNode(),
  getElementById: fakeNode,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
const { ITEM_DRAG_FORMAT, readItemDrag } = await import("../dist/code/browser/ui/ItemSlots.js");

// G3: offering into the trade — the menu entry and the window drop land in the same slot,
// and the gold field was already in the window.

function fakeConnection() {
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return new Promise(() => {}); },
    close() {},
  };
}

test("the first free offer slot skips taken ones and never the untradeable slot", () => {
  assert.equal(firstFreeTradeSlot([]), 0);
  assert.equal(firstFreeTradeSlot([0, 1, 3]), 2, "a gap is reused before the tail");
  assert.equal(firstFreeTradeSlot([1, 0, 2, 3, 4, 5]), undefined, "slots 0-5 full means no room");
  assert.equal(firstFreeTradeSlot([0, 1, 2, 3, 4, 5, 6]), undefined, "slot 6 never trades");
});

test("a bag drag reads back its address, anything else is not an item", () => {
  const drag = (format, body) => ({ getData: (wanted) => (wanted === format ? body : "") });
  assert.deepEqual(
    readItemDrag(drag(ITEM_DRAG_FORMAT, JSON.stringify({ bag: 1, slot: 7 }))),
    { bag: 1, slot: 7 },
  );
  assert.equal(readItemDrag(drag(ITEM_DRAG_FORMAT, "not-json")), undefined);
  assert.equal(readItemDrag(drag(ITEM_DRAG_FORMAT, JSON.stringify({ bag: "x" }))), undefined);
  assert.equal(readItemDrag(drag("text/plain", "hi")), undefined, "a foreign drag is ignored");
  assert.equal(readItemDrag(undefined), undefined);
});

test("offerTradeItem reaches the wire only while the window is open", () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  world.offerTradeItem(0, 1, 7);
  assert.deepEqual(connection.sent, [], "no window, no packet");
  world.tradeOpen = true;
  world.offerTradeItem(0, 1, 7);
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].opcode, OPCODES.CMSG_SET_TRADE_ITEM);
  world.close();
});

test("offering the same bag item twice does not trigger the core's duplicate-item trade cancel", () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  world.tradeOpen = true;
  world.offerTradeItem(0, 255, 23);
  world.offerTradeItem(1, 255, 23);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [OPCODES.CMSG_SET_TRADE_ITEM]);
  assert.deepEqual(world.ownTradeOffer().items.map(({ slot }) => slot), [0]);
  assert.match(world.tradeMessage ?? "", /уже предложен/i);

  world.clearTradeItem(0);
  world.offerTradeItem(1, 255, 23);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [
    OPCODES.CMSG_SET_TRADE_ITEM, OPCODES.CMSG_CLEAR_TRADE_ITEM, OPCODES.CMSG_SET_TRADE_ITEM,
  ], "clearing the first slot permits a new offer of the same item");
  world.close();
});

test("the trade window accepts a dropped bag item into the first free slot", async () => {
  const source = await readFile(new URL("../src/browser/ui/Social.ts", import.meta.url), "utf8");
  assert.match(source, /readItemDrag\(event\.dataTransfer\)/, "the drop reads the bag drag");
  assert.match(source, /firstFreeTradeSlot\(world\.ownTradeOffer\(\)\.items/, "menu and drop share the local slot choice");
  assert.match(source, /world\.offerTradeItem\(free, drag\.bag, drag\.slot\)/, "the drop offers at bag and slot");
  assert.match(source, /Свободных слотов обмена нет/, "a full window says so instead of eating the drop");
});
