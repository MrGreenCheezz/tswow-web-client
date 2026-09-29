import assert from "node:assert/strict";
import test from "node:test";

// `showWorldState` calls `renderInventory` once a frame for as long as packets arrive — in a crowd,
// every frame — and each call walked every slot, rebuilt the entry list and the signature string,
// and found nothing changed. With the client's store in place the inventory is built again only
// when the store's inventory watch says a slot could have moved.

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

const byId = new Map();
globalThis.document = {
  createElement: (tag) => makeNode(tag),
  body: makeNode("body"),
  documentElement: makeNode("html"),
  getElementById: (id) => {
    if (!byId.has(id)) byId.set(id, makeNode("div", id));
    return byId.get(id);
  },
  querySelectorAll: () => [],
};
globalThis.location = { origin: "http://127.0.0.1:5173", protocol: "http:", hostname: "127.0.0.1" };
globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { renderInventory } = await import("../dist/code/browser/ui/Bags.js");

const SELF = 0x10n;
const ITEM = 0x4000000000000301n;

function object(guid, typeId) {
  return {
    guid, typeId, position: typeId >= 3 ? { x: 0, y: 0, z: 0, orientation: 0 } : undefined,
    movementFlags: 0, updateFlags: 0, targetGuid: undefined, runSpeed: undefined, turnRate: undefined,
    transport: undefined, speeds: undefined, motion: undefined, glide: undefined, transportTime: undefined,
    fields: new Map(),
  };
}

test("a crowd's frames reuse the inventory; the player's own change rebuilds it on the next frame", () => {
  const state = new WorldState();
  const store = new WorldStore(state);
  state.objects.set(SELF, object(SELF, 4));
  state.selfGuid = SELF;
  state.objects.set(ITEM, object(ITEM, 1));
  store.objectCreated(ITEM, 1);
  state.setField(ITEM, UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 2589);
  state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, Number(ITEM & 0xffffffffn));
  state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 1, Number(ITEM >> 32n));
  state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset, 100);
  const crowd = Array.from({ length: 200 }, (_, index) => BigInt(0x3000 + index));
  for (const guid of crowd) state.objects.set(guid, object(guid, 4));
  store.flush();
  const asked = [];
  game.store = store;
  game.itemMetadata = { load: async (entries) => { asked.push(entries); return false; }, get: () => undefined };
  try {
    renderInventory(state);
    const money = document.getElementById("inventory-money");
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0], [2589]);
    for (let frame = 1; frame <= 10; frame += 1) {
      for (const guid of crowd) state.move(guid, { flags: 1, position: { x: frame, y: 0, z: 0, orientation: 0 } });
      store.flush();
      renderInventory(state);
    }
    // It used to be asked on every one of those frames — two promises each — for a list it had
    // already answered.
    assert.equal(asked.length, 1, "the unchanged inventory is not handed to the metadata client again");
    // …except once a second, which is how a failed entry is re-armed after its back-off.
    const clock = performance.now;
    const later = clock.call(performance) + 1_000;
    performance.now = () => later;
    try {
      renderInventory(state);
      renderInventory(state);
    } finally {
      performance.now = clock;
    }
    assert.equal(asked.length, 2, "a second later it is asked once more");
    assert.ok(asked.every((entries) => entries === asked[0]), "from the one inventory built before the crowd moved");

    state.setField(ITEM, UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 6948);
    state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_COINAGE.offset, 250);
    store.flush();
    renderInventory(state);
    assert.notEqual(asked.at(-1), asked[0], "an item of the player's own changing builds it again");
    assert.deepEqual(asked.at(-1), [6948]);
    assert.match(money.textContent, /2/, "and the coinage beside it follows");
  } finally {
    game.store = undefined;
    game.itemMetadata = undefined;
  }
});

test("a state without the client's store is built every time, as before", () => {
  const state = new WorldState();
  state.objects.set(SELF, object(SELF, 4));
  state.selfGuid = SELF;
  const asked = [];
  game.store = undefined;
  game.itemMetadata = { load: async (entries) => { asked.push(entries); return false; }, get: () => undefined };
  try {
    renderInventory(state);
    renderInventory(state);
    assert.equal(asked.length, 2);
    assert.notEqual(asked[0], asked[1]);
  } finally {
    game.itemMetadata = undefined;
  }
});
