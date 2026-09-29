import assert from "node:assert/strict";
import test from "node:test";

function makeNode(tag, id) {
  const node = {
    tagName: String(tag).toUpperCase(), id: id ?? "", children: [], dataset: {},
    className: "", textContent: "", hidden: false, tabIndex: -1, value: "", checked: false,
    listeners: new Map(), attributes: new Map(), style: {},
    append(...children) { for (const child of children) { child.parentNode = node; node.children.push(child); } },
    replaceChildren(...children) { node.children = children; for (const child of children) child.parentNode = node; },
    remove() {},
    addEventListener(name, handler) { node.listeners.set(name, handler); },
    setAttribute(name, value) { node.attributes.set(name, String(value)); },
    getAttribute(name) { return node.attributes.get(name) ?? null; },
    classList: {
      add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
      remove(...names) { node.className = node.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
      toggle(name, force) {
        const has = node.className.split(" ").includes(name);
        const next = force === undefined ? !has : !!force;
        if (next) node.classList.add(name);
        else node.classList.remove(name);
      },
      contains(name) { return node.className.split(" ").includes(name); },
    },
    querySelector() { return makeNode("button"); },
  };
  return node;
}

function fakeDocument() {
  const byId = new Map();
  return {
    createElement: (tag) => makeNode(tag),
    body: makeNode("body"),
    documentElement: makeNode("html"),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, makeNode("div", id));
      return byId.get(id);
    },
    querySelectorAll: () => [],
    __byId: byId,
  };
}

globalThis.document = fakeDocument();
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };

const { bagSearchMatches } = await import("../dist/code/browser/ui/Bags.js");
const { bagSection, itemSlot } = await import("../dist/code/browser/ui/ItemSlots.js");

function slotWith(entry) {
  return entry === 0
    ? { index: 0, item: undefined, guid: 0n, bag: 255, slot: 23 }
    : { index: 0, guid: 7n, bag: 255, slot: 23, item: { guid: 7n, typeId: 1, fields: new Map() } };
}

test("bag search matches case-insensitively and treats blank as everything", () => {
  assert.equal(bagSearchMatches("Рубаха", ""), true);
  assert.equal(bagSearchMatches("Рубаха", "  "), true);
  assert.equal(bagSearchMatches("Лечебное зелье", "лечебное"), true);
  assert.equal(bagSearchMatches("Лечебное зелье", "ЗЕЛЬЕ"), true);
  assert.equal(bagSearchMatches("Лечебное зелье", "мечи"), false);
});

test("dimmed slots keep their content and stay in the grid", () => {
  const dimmed = itemSlot(slotWith(6948), "", true);
  assert.ok(dimmed.className.split(" ").includes("is-dimmed"), "a miss dims");
  const plain = itemSlot(slotWith(6948), "", false);
  assert.ok(!plain.className.split(" ").includes("is-dimmed"), "a hit does not");
  const section = bagSection("Рюкзак", [slotWith(6948), slotWith(0)], (slot) => slot.item !== undefined);
  const grids = section.children.filter((child) => child.className === "bag-grid");
  assert.equal(grids.length, 1);
  assert.deepEqual(
    grids[0].children.map((child) => child.className.split(" ").includes("is-dimmed")),
    [true, false],
    "empty slots never dim",
  );
});
