import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BINDINGS, INPUT_ACTIONS } from "../dist/code/browser/input/Bindings.js";
import { COMMAND_ATTACK, packPetAction, ACT_COMMAND } from "../dist/code/world/PetProtocol.js";

// Q5: the hunter's key — `Shift+T` beside the character's own `T` — sending the pet at the
// current target through the existing `commandPet` path.

test("pet attack ships bound and alone on its chord", () => {
  const row = INPUT_ACTIONS.find((entry) => entry.action === "petAttack");
  assert.ok(row, "the bindings window lists it");
  assert.equal(row.group, "Цель");
  assert.deepEqual(DEFAULT_BINDINGS.petAttack, ["Shift+KeyT", ""]);
  const holders = INPUT_ACTIONS.filter((entry) =>
    (DEFAULT_BINDINGS[entry.action] ?? []).includes("Shift+KeyT"));
  assert.deepEqual(holders.map((entry) => entry.action), ["petAttack"],
    "no two actions ship with the same key");
});

function makeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], hidden: false, disabled: false,
    value: "", textContent: "", type: "",
    dataset: {}, id: "", className: "", title: "",
    style: { setProperty() {}, removeProperty() {} },
    parentNode: undefined, listeners: new Map(),
    classList: {
      _set: new Set(),
      add(...names) { for (const name of names) node.classList._set.add(name); },
      remove(...names) { for (const name of names) node.classList._set.delete(name); },
      toggle() { return false; },
      contains: (name) => node.classList._set.has(name),
    },
    append(...kids) { for (const kid of kids) { kid.parentNode = node; node.children.push(kid); } },
    prepend(...kids) { for (const kid of [...kids].reverse()) { kid.parentNode = node; node.children.unshift(kid); } },
    replaceChildren(...kids) { node.children = [...kids]; },
    remove() {},
    addEventListener(type, run) {
      const list = node.listeners.get(type) ?? [];
      list.push(run);
      node.listeners.set(type, list);
    },
    removeEventListener() {},
    setAttribute(name, value) { node[name] = value; },
    getAttribute(name) { return node[name] ?? null; },
    removeAttribute() {},
    focus() {}, blur() {},
    querySelector() { return makeNode("button"); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return node;
}

const byId = new Map();
globalThis.document = {
  createElement: (tag) => makeNode(tag),
  createElementNS: (_ns, tag) => makeNode(tag),
  body: makeNode("body"),
  documentElement: makeNode("html"),
  createTextNode: (text) => ({ textContent: text }),
  getElementById: (id) => {
    if (!byId.has(id)) {
      const node = makeNode("div");
      node.id = id;
      byId.set(id, node);
    }
    return byId.get(id);
  },
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800 };
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const { runAction } = await import("../dist/code/browser/input/Actions.js");

// A pet bar: three commands and one spell, exactly the shape `parsePetSpells` builds.
const petBar = () => ({
  closed: false, guid: 7n,
  bar: Array.from({ length: 10 }, (_, slot) => ({
    slot, packed: packPetAction(slot, ACT_COMMAND), action: slot, type: ACT_COMMAND,
  })),
});
// A vehicle bar: the high byte is the slot index offset by eight, no ACT_* state.
const vehicleBar = () => ({
  closed: false, guid: 9n,
  bar: Array.from({ length: 10 }, (_, slot) => ({
    slot, packed: (8 + slot) * 0x1000000 + 1000 + slot, action: 1000 + slot, type: 8 + slot,
  })),
});

test("the key sends an attack through the current target and stays silent otherwise", () => {
  const commands = [];
  try {
    game.world = {
      targetGuid: 0xabn,
      petSpells: petBar(),
      commandPet: (command, target) => commands.push([command, target]),
    };
    assert.equal(runAction("petAttack"), true);
    assert.deepEqual(commands, [[COMMAND_ATTACK, undefined]], "the target defaults inside commandPet");
    assert.equal(COMMAND_ATTACK, 2);

    game.world = { targetGuid: 0xabn, petSpells: undefined, commandPet: (...args) => commands.push(args) };
    assert.equal(runAction("petAttack"), false, "no pet, no packet");

    game.world = {
      targetGuid: 0xabn, petSpells: { ...petBar(), closed: true },
      commandPet: (...args) => commands.push(args),
    };
    assert.equal(runAction("petAttack"), false, "a dismissed bar is not an order");

    game.world = {
      targetGuid: 0xabn, petSpells: vehicleBar(),
      commandPet: (...args) => commands.push(args),
    };
    assert.equal(runAction("petAttack"), false, "a siege engine has no pet to send");
    assert.deepEqual(commands, [[COMMAND_ATTACK, undefined]], "and nothing was sent for any of the three");
  } finally {
    game.world = undefined;
  }
});
