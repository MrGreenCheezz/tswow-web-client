import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  LOOT_CORPSE,
  LOOT_SLOT_ALLOW_LOOT,
  LOOT_SLOT_LOCKED,
  LOOT_SLOT_OWNER,
  LOOT_SLOT_ROLL_ONGOING,
} from "../dist/code/world/LootProtocol.js";
import {
  defaultSettings,
  settingDefinition,
} from "../dist/code/browser/ui/SettingsModel.js";

// G1: «Забрать всё» / авто-лут / shift-клик.
//
// `takeAllLoot` is a thin loop over the existing guards: money through `takeLootMoney`,
// slots through `takeLootSlot`, so locked / roll-ongoing / taken slots never move.

function fakeConnection() {
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return new Promise(() => {}); },
    close() {},
  };
}

const slot = (index, slotType, taken = false) => ({
  index, itemId: 1000 + index, count: 1, displayId: 5000 + index,
  randomSuffix: 0, randomPropertyId: 0, slotType, taken,
});

function worldWithLoot(connection, loot) {
  const world = new WorldClient(connection);
  world.loot = loot;
  return world;
}

test("takeAllLoot takes money and every freely takeable slot in wire order", () => {
  const connection = fakeConnection();
  const world = worldWithLoot(connection, {
    guid: 1n, lootType: LOOT_CORPSE, gold: 1234, error: undefined,
    slots: [
      slot(0, LOOT_SLOT_ALLOW_LOOT),
      slot(1, LOOT_SLOT_LOCKED),
      slot(2, LOOT_SLOT_OWNER),
      slot(3, LOOT_SLOT_ROLL_ONGOING),
      slot(4, LOOT_SLOT_ALLOW_LOOT, true),
    ],
  });
  world.takeAllLoot();
  const opcodes = connection.sent.map((entry) => entry.opcode);
  assert.deepEqual(opcodes, [
    OPCODES.CMSG_LOOT_MONEY,
    OPCODES.CMSG_AUTOSTORE_LOOT_ITEM,
    OPCODES.CMSG_AUTOSTORE_LOOT_ITEM,
  ]);
  assert.deepEqual(
    connection.sent.filter((entry) => entry.opcode === OPCODES.CMSG_AUTOSTORE_LOOT_ITEM)
      .map((entry) => entry.payload[0]),
    [0, 2],
    "locked, roll-ongoing and already-taken slots are left alone",
  );
  world.close();
});

test("takeAllLoot sends nothing for an error window, an empty window or a closed client", () => {
  const refused = fakeConnection();
  const refusedWorld = worldWithLoot(refused, { guid: 2n, lootType: 0, gold: 0, error: 6, slots: [] });
  refusedWorld.takeAllLoot();
  assert.deepEqual(refused.sent, [], "a LootError refusal takes nothing");
  refusedWorld.close();

  const empty = fakeConnection();
  const emptyWorld = worldWithLoot(empty, { guid: 3n, lootType: LOOT_CORPSE, gold: 0, error: undefined, slots: [] });
  emptyWorld.takeAllLoot();
  assert.deepEqual(empty.sent, [], "an empty corpse sends no packets");
  emptyWorld.close();

  const shut = fakeConnection();
  const shutWorld = worldWithLoot(shut, {
    guid: 4n, lootType: LOOT_CORPSE, gold: 50, error: undefined, slots: [slot(0, LOOT_SLOT_ALLOW_LOOT)],
  });
  shutWorld.close();
  shutWorld.takeAllLoot();
  assert.deepEqual(shut.sent, [], "a closed client stays silent");
});

test("autoLoot is a declared Игра switch, off by default", () => {
  const definition = settingDefinition("autoLoot");
  assert.ok(definition, "the setting exists so the window can draw it");
  assert.equal(definition.group, "Игра");
  assert.equal(definition.kind, "boolean");
  assert.equal(defaultSettings().autoLoot, false, "opt-in: yesterday's loot window keeps its clicks");
});

// The window half runs over the same document stub `loot.test.mjs` uses: `Dom.ts` resolves
// every handle (including the new `#loot-all`) at import time, so the stub has to answer any id.
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "",
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
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
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const { showLoot } = await import("../dist/code/browser/ui/Npc.js");
const { lootAll } = await import("../dist/code/browser/ui/Dom.js");
const { settingsStore } = await import("../dist/code/browser/ui/Settings.js");

function stubWorld(loot, calls) {
  return {
    loot,
    takeLootSlot() {},
    takeLootMoney() {},
    takeAllLoot() { calls.push("take-all"); },
    itemTemplate: () => undefined,
    state: { selfGuid: undefined, objects: new Map() },
  };
}

function paint(loot, calls) {
  game.sound = { play() {} };
  // The loot fixture has no audio data: a missing name is a completed lookup, not an in-flight
  // request. Mirror SoundClient's answer-state contract so PlaySound does not queue a retry.
  game.soundKits = {
    named: () => undefined, namedAnswered: () => true,
    kit: (id) => ({ id, name: "x" }),
  };
  game.itemMetadata = { get: () => undefined, load: async () => false, displayIconUrl: (id) => `/item-icon/${id}` };
  game.world = stubWorld(loot, calls);
  showLoot();
}

test("the take-all button shows only while something takeable remains", () => {
  const calls = [];
  try {
    paint({
      guid: 11n, lootType: LOOT_CORPSE, gold: 0, error: undefined,
      slots: [slot(0, LOOT_SLOT_ALLOW_LOOT)],
    }, calls);
    assert.equal(lootAll.hidden, false, "one takeable slot is enough to offer it");
    assert.equal(calls.length, 0, "auto-loot is off by default, so painting takes nothing");

    paint({ guid: 12n, lootType: LOOT_CORPSE, gold: 0, error: undefined, slots: [] }, calls);
    assert.equal(lootAll.hidden, true, "an empty corpse offers nothing");

    paint({ guid: 13n, lootType: 0, gold: 0, error: 6, slots: [] }, calls);
    assert.equal(lootAll.hidden, true, "a refusal offers nothing either");
  } finally {
    game.world = undefined;
  }
});

test("auto-loot fires once per opening, never on repaints", () => {
  const calls = [];
  settingsStore.set({ ...settingsStore.value, autoLoot: true });
  try {
    const opening = {
      guid: 21n, lootType: LOOT_CORPSE, gold: 100, error: undefined,
      slots: [slot(0, LOOT_SLOT_ALLOW_LOOT)],
    };
    paint(opening, calls);
    assert.equal(calls.length, 1, "opening with auto-loot takes all");
    paint(opening, calls);
    paint(opening, calls);
    assert.equal(calls.length, 1, "the repaints after each taken slot stay silent");
    paint({ ...opening }, calls);
    assert.equal(calls.length, 2, "the same corpse opened again is a new opening");
  } finally {
    settingsStore.set({ ...settingsStore.value, autoLoot: false });
    game.world = undefined;
  }
});

test("shift-click on a loot slot is wired to take-all", async () => {
  const source = await readFile(new URL("../src/browser/ui/Npc.ts", import.meta.url), "utf8");
  assert.match(source, /event\.shiftKey/, "the slot click reads the shift key");
  assert.match(source, /shiftKey\) world\.takeAllLoot\(\)/, "shift goes to take-all, plain click to the slot");
  assert.match(source, /settingOn\("autoLoot"\)/, "auto-loot is gated on the setting, not always on");
});
