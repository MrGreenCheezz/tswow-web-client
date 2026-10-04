// 4.04: the native HUD's unit card beside the cursor (Controls.ts → ui/UnitTooltip.ts through the
// shared tooltip's cursor mode), its suppression under the stock HUD, and the cost rule: a pointer
// moving over the same unit moves the card and does not rebuild it.
import assert from "node:assert/strict";
import test from "node:test";

let clock = 10_000;
const created = [];
function make(tag) {
  const listeners = new Map();
  const classes = new Set();
  const node = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
    hidden: false, id: "", listeners, attributes: new Map(), rebuilds: 0,
    style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
    classList: {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      toggle: (name, force) => { const on = force ?? !classes.has(name); if (on) classes.add(name); else classes.delete(name); return on; },
      contains: (name) => classes.has(name),
    },
    append(...children) { node.children.push(...children); },
    replaceChildren(...children) { node.rebuilds += 1; node.children = children; },
    remove() {}, focus() {}, blur() {},
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
    setAttribute(name, value) { node.attributes.set(name, String(value)); },
    getAttribute(name) { return node.attributes.get(name) ?? null; },
    removeAttribute(name) { node.attributes.delete(name); },
    setPointerCapture() {}, querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
    getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 40, top: 0, left: 0, right: 100, bottom: 40 }; },
    getContext() { return null; },
  };
  created.push(node);
  return node;
}
const byId = new Map();
globalThis.document = {
  createElement: make, createElementNS: (_ns, tag) => make(tag), createTextNode: (text) => ({ textContent: text }),
  createDocumentFragment: () => make("fragment"), body: make("body"), documentElement: make("html"), head: make("head"),
  getElementById(id) { if (!byId.has(id)) { const node = make("div"); node.id = id; byId.set(id, node); } return byId.get(id); },
  querySelector() { return make("div"); }, querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {},
};
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};
globalThis.performance = { now: () => clock };

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { wireControls } = await import("../dist/code/browser/input/Controls.js");
const { NATIVE_LANES_REPLACED } = await import("../dist/code/browser/ui/NativeHudReplacement.js");

const canvas = document.getElementById("world-canvas");
wireControls();
const pointerMove = canvas.listeners.get("pointermove");
const pointerLeave = canvas.listeners.get("pointerleave");
const move = (x, y = 10) => { clock += 1_000; pointerMove({ buttons: 0, clientX: x, clientY: y, movementX: 0, movementY: 0 }); };

const F = UPDATE_FIELDS;
const objects = new Map([
  [1n, { guid: 1n, typeId: 4, fields: new Map([[F.UNIT_FIELD_LEVEL.offset, 10]]) }],
  [2n, { guid: 2n, typeId: 3, position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map([
    [F.OBJECT_FIELD_ENTRY.offset, 99], [F.UNIT_FIELD_LEVEL.offset, 5], [F.UNIT_FIELD_HEALTH.offset, 40],
    [F.UNIT_FIELD_MAXHEALTH.offset, 40],
  ]) }],
]);
let templateCalls = 0;
game.world = {
  state: { selfGuid: 1n, objects },
  names: { get: () => undefined },
  knownSpells: [],
  creatureTemplate(entry) {
    templateCalls += 1;
    return { entry, found: true, name: "Кабан", subName: "", flags: 0, creatureType: 1, classification: 0 };
  },
};
game.collision = undefined;
game.scene = { pick: (x) => (x >= 100 && x < 200 ? 2n : undefined) };

const tooltipElement = () => created.find((node) => node.id === "ui-tooltip");

test("over a creature the native HUD shows its card at the cursor, and leaving hides it", () => {
  move(120);
  const box = tooltipElement();
  assert.ok(box, "the shared tooltip element exists");
  assert.equal(box.hidden, false);
  assert.match(box.className, /is-cursor/);
  assert.equal(box.children[0]?.textContent, "Кабан");
  assert.equal(box.children.length, 2, "the name and the level line");
  pointerLeave();
  assert.equal(box.hidden, true, "leaving the canvas takes it down");
});

test("moving over the same unit moves the card without rebuilding it", () => {
  move(120);
  const box = tooltipElement();
  const rebuilds = box.rebuilds;
  move(130, 20);
  move(140, 30);
  assert.equal(box.rebuilds, rebuilds, "no DOM rebuild while the unit and what it says are unchanged");
  assert.equal(box.style.left, "156px", "but the card follows the pointer");
  objects.get(2n).fields.set(F.UNIT_FIELD_LEVEL.offset, 6);
  move(150);
  assert.equal(box.rebuilds, rebuilds + 1, "a changed level is a rebuild");
  pointerLeave();
});

test("under the stock HUD the native card is not drawn — the stock GameTooltip owns the mouseover", () => {
  document.body.classList.add(NATIVE_LANES_REPLACED);
  try {
    const box = tooltipElement();
    move(120);
    assert.equal(box.hidden, true);
  } finally {
    document.body.classList.remove(NATIVE_LANES_REPLACED);
    pointerLeave();
  }
});

test("bare ground shows no card", () => {
  move(120);
  move(900);
  assert.equal(tooltipElement().hidden, true);
  assert.ok(templateCalls > 0);
});
