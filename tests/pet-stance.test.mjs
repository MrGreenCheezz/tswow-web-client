import assert from "node:assert/strict";
import test from "node:test";
import {
  ACT_COMMAND, ACT_REACTION, COMMAND_ATTACK, COMMAND_FOLLOW, COMMAND_STAY,
  REACT_AGGRESSIVE, REACT_DEFENSIVE, REACT_PASSIVE, packPetAction,
} from "../dist/code/world/PetProtocol.js";

// G5: the bar already casts, toggles autocast and reorders — the missing piece was showing which
// stance and command the pet is actually holding.

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "",
    textContent: "", title: "", hidden: false, type: "", parentNode: undefined,
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      add(...names) { for (const name of names) node.classList._set.add(name); node.className = [...node.classList._set].join(" "); },
      remove(...names) { for (const name of names) node.classList._set.delete(name); node.className = [...node.classList._set].join(" "); },
      toggle(name, force) {
        const want = force === undefined ? !node.classList._set.has(name) : force;
        if (want) node.classList._set.add(name);
        else node.classList._set.delete(name);
        node.className = [...node.classList._set].join(" ");
        return want;
      },
      contains: (name) => node.classList._set.has(name),
      _set: new Set(),
    },
    append(...kids) { for (const kid of kids) { kid.parentNode = node; node.children.push(kid); } },
    prepend(...kids) { for (const kid of kids.reverse()) { kid.parentNode = node; node.children.unshift(kid); } },
    replaceChildren(...kids) { node.children = [...kids]; for (const kid of kids) kid.parentNode = node; },
    remove() {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((kid) => kid !== node);
      node.parentNode = undefined;
    },
    addEventListener() {}, removeEventListener() {},
    setAttribute(name, value) { node[name] = value; },
    getAttribute(name) { return node[name] ?? null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }; },
  };
  return node;
}

const byId = new Map();
for (const id of ["world-viewport", "bottom-hud-center"]) byId.set(id, makeNode("div"));

globalThis.document = {
  createElement: (tag) => makeNode(tag),
  body: makeNode("body"),
  documentElement: { style: { setProperty() {}, removeProperty() {} } },
  getElementById: (id) => byId.get(id) ?? null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.window = {
  innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return true; },
};
globalThis.Event = class { constructor(type) { this.type = type; } };

const { game } = await import("../dist/code/browser/game/Context.js");
const { resetPetBar, showPetBar } = await import("../dist/code/browser/ui/PetBar.js");

const button = (action, type) => ({ slot: 0, packed: packPetAction(action, type), action, type });

function petWorld(reactState, commandState) {
  return {
    petSpells: {
      closed: false, guid: 7n, creatureFamily: 1, duration: 0,
      reactState, commandState, flags: 0,
      bar: [
        button(COMMAND_ATTACK, ACT_COMMAND), button(COMMAND_FOLLOW, ACT_COMMAND),
        button(COMMAND_STAY, ACT_COMMAND),
        { slot: 3, packed: 0, action: 0, type: 0 }, { slot: 4, packed: 0, action: 0, type: 0 },
        { slot: 5, packed: 0, action: 0, type: 0 }, { slot: 6, packed: 0, action: 0, type: 0 },
        button(REACT_PASSIVE, ACT_REACTION), button(REACT_DEFENSIVE, ACT_REACTION),
        button(REACT_AGGRESSIVE, ACT_REACTION),
      ],
      spells: [], cooldowns: [],
    },
  };
}

function activeLabels() {
  const bar = byId.get("bottom-hud-center").children
    .flatMap((box) => box.children ?? [])
    .find((node) => node.className === "pet-bar-row");
  assert.ok(bar, "the pet bar row is on screen");
  return bar.children
    .filter((button) => !button.hidden && button.classList.contains("is-active"))
    .map((button) => button.children.find((kid) => kid.tagName === "SPAN")?.textContent);
}

test("the holding stance and command read off the packet, not off the clicks", () => {
  try {
    game.world = petWorld(REACT_DEFENSIVE, COMMAND_ATTACK);
    showPetBar();
    assert.deepEqual(activeLabels().sort(), ["Атаковать", "Защита"].sort());

    resetPetBar();
    game.world = petWorld(REACT_PASSIVE, COMMAND_FOLLOW);
    showPetBar();
    assert.deepEqual(activeLabels().sort(), ["Следовать", "Пассивно"].sort());
  } finally {
    resetPetBar();
    game.world = undefined;
  }
});
