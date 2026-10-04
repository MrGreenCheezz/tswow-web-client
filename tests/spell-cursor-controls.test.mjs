// Plan item 2.05 (mechanism M3): the world canvas and Escape with the item-target cursor up
// (input/Controls.ts). SpellIsTargeting/SpellStopTargeting reach it through the native targeting
// step; a right click drops it; a left click on the world takes nothing and keeps it.
import assert from "node:assert/strict";
import test from "node:test";

// A document just real enough for Controls.ts to import (the same double as creature-gather's).
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const listeners = new Map();
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "", listeners,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
      removeEventListener() {},
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      setPointerCapture() {}, releasePointerCapture() {},
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 }; },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const toggled = [];
document.body.classList.toggle = (name, value) => { toggled.push([name, value]); };

const { game } = await import("../dist/code/browser/game/Context.js");
const cursor = await import("../dist/code/browser/game/SpellCursor.js");
const { wireControls } = await import("../dist/code/browser/input/Controls.js");
const { frameXmlNativeTargeting, runFrameXmlNativeEscape } =
  await import("../dist/code/browser/framexml/FrameXmlGameMenuController.js");

wireControls();
const canvas = document.getElementById("world-canvas");
const handler = (name) => (canvas.listeners.get(name) ?? [])[0];

function click(button) {
  const buttons = button === 0 ? 1 : 2;
  const base = { pointerId: 1, clientX: 100, clientY: 100, movementX: 0, movementY: 0, preventDefault() {} };
  handler("pointerdown")({ ...base, button, buttons });
  handler("pointerup")({ ...base, button, buttons: 0 });
}

function liveWorld() {
  const selected = [];
  return {
    selected, mapId: 0, state: { selfGuid: 1n, objects: new Map() }, selectTarget(guid) { selected.push(guid); },
    aurasFor: () => [],
  };
}

test("the native targeting step answers SpellIsTargeting and SpellStopTargeting for the item cursor", () => {
  const world = liveWorld();
  game.world = world;
  try {
    assert.equal(frameXmlNativeTargeting(), false);
    cursor.armItemTarget(world, 13262);
    assert.equal(frameXmlNativeTargeting(), true, "SpellIsTargeting");
    assert.deepEqual(toggled.at(-1), ["spell-item-cursor", true], "the cast cursor over the windows");
    assert.equal(runFrameXmlNativeEscape("stopTargeting"), true, "SpellStopTargeting drops it");
    assert.equal(cursor.pendingItemTarget(), undefined);
    assert.deepEqual(toggled.at(-1), ["spell-item-cursor", false]);
    assert.equal(runFrameXmlNativeEscape("stopTargeting"), false, "and only once");
  } finally {
    cursor.cancelItemTarget();
    game.world = undefined;
  }
});

test("on the world canvas a left click keeps the cursor; a unit is not selected, bare ground is a ground click; a right click drops it", () => {
  const world = liveWorld();
  world.state.objects.set(7n, { guid: 7n, typeId: 3, fields: new Map() });
  game.world = world;
  const previousScene = game.scene;
  try {
    cursor.armItemTarget(world, 13262);
    game.scene = { pick: () => 7n };
    click(0);
    assert.equal(cursor.pendingItemTarget()?.spellId, 13262, "the world has no item to take");
    assert.deepEqual(world.selected, [], "a unit under the click is not selected (0x00524bf0)");
    game.scene = { pick: () => undefined };
    click(0);
    assert.equal(cursor.pendingItemTarget()?.spellId, 13262, "the cursor stays");
    assert.deepEqual(world.selected, [undefined], "bare ground is the ordinary ground click (0x00527360)");
    world.selected.length = 0;
    click(2);
    assert.equal(cursor.pendingItemTarget(), undefined, "a right click is SpellStopTargeting");
    assert.deepEqual(world.selected, [], "and opens nothing");
  } finally {
    game.scene = previousScene;
    cursor.cancelItemTarget();
    game.world = undefined;
  }
});

test("a native item slot's click goes to the cursor before the repair cursor, refusals keep it", async () => {
  const { clickItemTargetSlot } = await import("../dist/code/browser/ui/ItemTargetClick.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const statuses = [];
  const calls = [];
  const world = {
    ...liveWorld(),
    itemTemplates: new Map([[2589, { flags: 0 }]]),
    onSpellStatus(text, error) { statuses.push([text, error]); },
    useItemOnItem(...args) { calls.push(args); return true; },
  };
  game.world = world;
  const linen = { typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 2589]]) };
  try {
    assert.equal(clickItemTargetSlot(linen, 0x302n), false, "no cursor: the slot's own click");
    game.spells.set(31252, { id: 31252, requiredTargetMode: 2, effects: [127, 0, 0] });
    cursor.armItemTarget(world, 31252);
    assert.equal(clickItemTargetSlot(linen, 0x302n), true, "linen cannot be prospected: eaten");
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0][1], true);
    assert.equal(cursor.pendingItemTarget()?.spellId, 31252, "and the cursor stays");
    cursor.armItemTarget(world, 2823, { bag: 255, slot: 23, guid: 0x301n });
    assert.equal(clickItemTargetSlot(linen, 0x302n), true);
    assert.deepEqual(calls, [[255, 23, 0x301n, 2823, 0x302n]]);
  } finally {
    game.spells.delete(31252);
    cursor.cancelItemTarget();
    game.world = undefined;
  }
  const { readFile } = await import("node:fs/promises");
  const slots = await readFile(new URL("../src/browser/ui/ItemSlots.ts", import.meta.url), "utf8");
  const target = slots.indexOf("clickItemTargetSlot(slot.item, slot.guid");
  const repair = slots.indexOf("clickRepairSlot(slot.item, slot.guid)");
  assert.ok(target > 0 && repair > target, "the item-target listener is registered before the repair one");
});
