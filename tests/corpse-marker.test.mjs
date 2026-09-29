import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

// G8: a ghost must see where the body is — a red rim dot on the minimap and a distance in the
// death window — instead of bare map coordinates.

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
const { showDeath, updateDeathReclaimCountdown } = await import("../dist/code/browser/ui/Npc.js");
const { deathReclaim, deathRelease, deathStatus, deathWindow, resurrectText } = await import("../dist/code/browser/ui/Dom.js");

const deadSelfAt = (x, y, { ghost = false, health = 0 } = {}) => ({
  guid: 1n, typeId: 4,
  fields: new Map([
    [UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health],
    [UPDATE_FIELDS.PLAYER_FLAGS.offset, ghost ? 0x10 : 0],
  ]),
  position: { x, y, z: 0 },
});

function paint({ self, corpse, mapId = 0, corpseReclaimRemaining = () => 0 }) {
  game.world = {
    state: { selfGuid: 1n, objects: new Map([[1n, self]]) },
    corpse, mapId,
    resurrectRequest: undefined, targetGuid: undefined,
    corpseReclaimRemaining,
  };
  showDeath();
}

test("the death window names the walk back in yards", () => {
  try {
    // 30/40 yards away: the classic 50-yard hike, spelled out next to the coordinates.
    paint({
      self: deadSelfAt(0, 0, { ghost: true }),
      corpse: { found: true, mapId: 0, x: 30, y: 40, z: 0, corpseMapId: 0 },
    });
    assert.equal(deathWindow.hidden, false);
    assert.match(deathStatus.textContent, /~50 ярдов/);
  } finally {
    game.world = undefined;
  }
});

test("an instance corpse says which dungeon holds the body", () => {
  try {
    paint({
      self: deadSelfAt(0, 0, { ghost: true }),
      corpse: { found: true, mapId: 0, x: 30, y: 40, z: 0, corpseMapId: 571 },
    });
    assert.match(deathStatus.textContent, /подземелье 571/);
    assert.doesNotMatch(deathStatus.textContent, /ярдов/, "entrance-map coordinates are not walkable yards");
  } finally {
    game.world = undefined;
  }
});

test("no corpse yet means the release prompt, with no distance to invent", () => {
  try {
    paint({ self: deadSelfAt(0, 0), corpse: { found: false, mapId: -1, x: 0, y: 0, z: 0, corpseMapId: -1 } });
    assert.match(deathStatus.textContent, /Освободите дух/);
    assert.doesNotMatch(deathStatus.textContent, /ярдов/);
  } finally {
    game.world = undefined;
  }
});

test("a fresh death does not offer reclaim from a previous corpse query", () => {
  try {
    paint({
      self: deadSelfAt(0, 0),
      corpse: { found: true, mapId: 0, x: 30, y: 40, z: 0, corpseMapId: 0 },
    });
    assert.equal(deathWindow.hidden, false);
    assert.equal(deathRelease.hidden, false);
    assert.equal(deathReclaim.hidden, true);
    assert.doesNotMatch(deathStatus.textContent, /Тело на карте/);
  } finally {
    game.world = undefined;
  }
});

test("a ghost remains in the death window even if its health is positive", () => {
  try {
    paint({
      self: deadSelfAt(0, 0, { ghost: true, health: 1 }),
      corpse: { found: true, mapId: 0, x: 30, y: 40, z: 0, corpseMapId: 0 },
    });
    assert.equal(deathWindow.hidden, false);
    assert.equal(deathRelease.hidden, true);
    assert.equal(deathReclaim.hidden, false);
    assert.match(deathStatus.textContent, /~50 ярдов/);
  } finally {
    game.world = undefined;
  }
});

test("a player resurrection offer uses the caster GUID when the packet omits the name", () => {
  try {
    paint({ self: deadSelfAt(0, 0), corpse: undefined });
    game.world.resurrectRequest = {
      casterGuid: 2n, casterName: "", sickness: false, useTimer: true,
    };
    game.world.displayName = (guid) => guid === 2n ? "Спасатель" : "Неизвестный";
    showDeath();
    assert.equal(resurrectText.textContent, "Спасатель предлагает воскрешение.");
  } finally {
    game.world = undefined;
  }
});

test("the reclaim countdown unlocks while the ghost stands still", () => {
  try {
    paint({
      self: deadSelfAt(0, 0, { ghost: true, health: 1 }),
      corpse: { found: true, mapId: 0, x: 20, y: 20, z: 0, corpseMapId: 0 },
      corpseReclaimRemaining: (now) => Math.max(0, 30_000 - now),
    });
    updateDeathReclaimCountdown(1_000);
    assert.equal(deathReclaim.disabled, true);
    assert.match(deathReclaim.textContent, /29 с/);
    updateDeathReclaimCountdown(30_000);
    assert.equal(deathReclaim.disabled, false);
    assert.equal(deathReclaim.textContent, "Забрать тело");
  } finally {
    game.world = undefined;
  }
});

test("reclaim stays unavailable until the ghost reaches its own corpse on the same map", () => {
  try {
    const self = deadSelfAt(0, 0, { ghost: true, health: 1 });
    paint({ self, corpse: { found: true, mapId: 0, x: 100, y: 0, z: 0, corpseMapId: 0 } });
    assert.equal(deathReclaim.hidden, false, "the corpse remains visible as a destination");
    assert.equal(deathReclaim.disabled, true, "the graveyard cannot reclaim a distant body");

    self.position.x = 100;
    updateDeathReclaimCountdown();
    assert.equal(deathReclaim.disabled, false, "moving into server range unlocks without another packet");

    self.position.x = 0;
    game.world.corpse.x = 39.1;
    updateDeathReclaimCountdown();
    assert.equal(deathReclaim.disabled, true, "an absent combat reach field does not invent extra yards");
    game.world.corpse.x = 39;
    updateDeathReclaimCountdown();
    assert.equal(deathReclaim.disabled, false);

    const reach = new DataView(new ArrayBuffer(4));
    reach.setFloat32(0, 1.5, true);
    self.fields.set(UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset, reach.getUint32(0, true));
    game.world.corpse.x = 40.4;
    updateDeathReclaimCountdown();
    assert.equal(deathReclaim.disabled, false, "the server adds the player's combat reach to 39 yards");
    game.world.corpse.x = 40.6;
    updateDeathReclaimCountdown();
    assert.equal(deathReclaim.disabled, true, "outside the precise reach-adjusted radius stays unavailable");

    game.world.corpse.x = 0;
    game.world.mapId = 1;
    updateDeathReclaimCountdown();
    assert.equal(deathReclaim.disabled, true, "matching coordinates on another map are not enough");

    game.world.mapId = 0;
    game.world.corpse.corpseMapId = 571;
    updateDeathReclaimCountdown();
    assert.equal(deathReclaim.disabled, true, "an instance entrance marker is not the corpse itself");
  } finally {
    game.world = undefined;
  }
});

test("the minimap draws the player's own corpse as a rim blip on the same map", async () => {
  const source = await readFile(new URL("../src/browser/ui/Minimap.ts", import.meta.url), "utf8");
  assert.match(source, /world\?\.corpse/, "the corpse comes from the world, not from object gossip");
  assert.match(source, /corpse\.mapId === world\?\.mapId/, "an entrance-map dot never points at the wrong place");
  assert.match(source, /#ff5a5a/, "its own colour, not the lootable-body green");
  assert.match(source, /ring: true/, "ringed so it survives the rim clamp as a direction");
});
