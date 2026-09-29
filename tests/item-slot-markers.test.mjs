import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

/**
 * The slot markers need a DOM, not a browser: the same fake the FrameXML item-tooltip test uses,
 * with the two additions these assertions read — a working `classList` and a settable `style`.
 */
function fakeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {}, hidden: false,
    textContent: "", title: "", tabIndex: -1, className: "",
    append(...children) { node.children.push(...children); },
    replaceChildren(...children) { node.children = [...children]; },
    addEventListener() {}, removeEventListener() {},
    setAttribute(name, value) { node[name] = String(value); },
    getAttribute() { return null; },
    remove() {},
    querySelector() { return fakeNode("button"); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40 }; },
    classList: {
      add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
      remove(...names) { node.className = node.className.split(" ").filter((item) => !names.includes(item)).join(" "); },
      toggle(name, enabled) { if (enabled) this.add(name); else this.remove(name); },
      contains(name) { return node.className.split(" ").includes(name); },
    },
  };
  return node;
}

const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
const previousLocation = globalThis.location;
const previousStorage = globalThis.localStorage;
globalThis.document = {
  createElement: fakeNode,
  body: fakeNode("body"),
  addEventListener() {},
  getElementById() { return fakeNode("div"); },
  querySelectorAll() { return []; },
};
globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1:5173", search: "" };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const { itemSlot } = await import("../dist/code/browser/ui/ItemSlots.js");
const { game } = await import("../dist/code/browser/game/Context.js");

function descendants(node) {
  const found = [node];
  for (const child of node.children ?? []) found.push(...descendants(child));
  return found;
}
const hasClass = (node, name) => descendants(node).some((entry) => entry.className.split(" ").includes(name));
const classed = (node, name) => descendants(node).find((entry) => entry.className.split(" ").includes(name));

function item(entry, pairs = []) {
  const fields = new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry], ...pairs]);
  return { guid: 2n, typeId: 1, fields };
}
const slot = (bag, index, entry, pairs = []) => ({
  bag, slot: index, index, guid: 2n, item: item(entry, pairs),
});

test.after(() => {
  globalThis.document = previousDocument;
  globalThis.window = previousWindow;
  globalThis.location = previousLocation;
  globalThis.localStorage = previousStorage;
});

test("a damaged item carries its wear bar, a broken one is marked", () => {
  const worn = itemSlot(slot(255, 0, 99001, [
    [UPDATE_FIELDS.ITEM_FIELD_DURABILITY.offset, 40],
    [UPDATE_FIELDS.ITEM_FIELD_MAXDURABILITY.offset, 100],
  ]));
  const bar = classed(worn, "item-wear");
  assert.ok(bar, "damaged gear carries a wear bar");
  assert.equal(descendants(bar)[1].style.width, "40%");
  assert.match(worn["aria-label"], /прочность 40 из 100/);
  assert.equal(hasClass(worn, "is-broken"), false);

  const broken = itemSlot(slot(255, 0, 99001, [
    [UPDATE_FIELDS.ITEM_FIELD_DURABILITY.offset, 0],
    [UPDATE_FIELDS.ITEM_FIELD_MAXDURABILITY.offset, 100],
  ]));
  assert.ok(hasClass(broken, "is-broken"), "a broken item marks its border");
  assert.ok(classed(broken, "item-wear")?.className.split(" ").includes("broken"));
  assert.match(broken["aria-label"], /предмет сломан/);

  const intact = itemSlot(slot(255, 0, 99001, [
    [UPDATE_FIELDS.ITEM_FIELD_DURABILITY.offset, 100],
    [UPDATE_FIELDS.ITEM_FIELD_MAXDURABILITY.offset, 100],
  ]));
  assert.equal(classed(intact, "item-wear"), undefined, "full durability is not worth a bar");
  assert.equal(hasClass(intact, "is-broken"), false);
});

test("an enchanted or socketed item shows a marker, a plain one does not", () => {
  const socketed = itemSlot(slot(255, 0, 99001, [
    [UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + 2 * 3, 37220],
  ]));
  assert.ok(hasClass(socketed, "item-enchant"));
  const plain = itemSlot(slot(255, 0, 99001));
  assert.equal(hasClass(plain, "item-enchant"), false);
});

test("the item-level badge is for equipment, and only once the template answers", () => {
  const previousWorld = game.world;
  game.world = { itemTemplate: () => ({ itemLevel: 264 }) };
  try {
    const equipped = itemSlot(slot(255, 0, 99001));
    const badge = classed(equipped, "item-level");
    assert.equal(badge?.textContent, "264");
    const bagged = itemSlot(slot(255, 23, 99001));
    assert.equal(classed(bagged, "item-level"), undefined, "a bag slot is not an upgrade comparison");
  } finally {
    game.world = previousWorld;
  }
});

test("an empty slot shows none of the item markers", () => {
  const empty = itemSlot({ bag: 255, slot: 23, index: 0, guid: 0n, item: undefined });
  for (const marker of ["item-wear", "item-enchant", "item-level", "is-broken", "stack-count"]) {
    assert.equal(hasClass(empty, marker), false, `${marker} must not appear on an empty slot`);
  }
});
