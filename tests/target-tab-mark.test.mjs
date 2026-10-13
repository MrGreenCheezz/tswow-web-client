// Plan item 1.10 (12.10): TargetLastTarget with nothing remembered (0x00525d70) and ClearTarget (0x00525fc0, what
// Escape and /cleartarget run) zero the Tab list's mark, DAT_00bd08cc — the build time 0x00524fc0 reads; zero means
// "build a fresh list" — before they look at the selection, so they drop the list with nothing selected too
// (.runtime/re-2026-10-04/l2-targeting/g1.c, g2.c; re-2026-10-01/a9-combat/e2.c). Here both returned early without a
// selection and Tab kept its old list: after the target left sight, the next Tab within 3 s stepped through the old
// order instead of the nearest unit now. With nothing selected the press drops the list only (game/Targeting.ts
// `dropTabList`): no packet, no history.
import assert from "node:assert/strict";
import test from "node:test";

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
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};
globalThis.HTMLInputElement = class {};
globalThis.HTMLSelectElement = class {};
globalThis.HTMLTextAreaElement = class {};

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { TargetHistory } = await import("../dist/code/world/TargetHistory.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { cycleEnemyTarget, targetLastUnit, targetSelectionKind } = await import("../dist/code/browser/game/Targeting.js");
const { runFrameXmlNativeEscape } = await import("../dist/code/browser/framexml/FrameXmlGameMenuController.js");
const { wireControls } = await import("../dist/code/browser/input/Controls.js");

wireControls();

const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const FACTION = UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;

/** Faction template 2 is hostile to the player, anything else friendly. */
const factions = { ready: true, reaction: (_mine, theirs) => (theirs === 2 ? -1 : 1), factionOf: () => undefined };

function unit(guid, { typeId = 3, x = 0, y = 0, faction = 2 } = {}) {
  const fields = new Map([[HEALTH, 100], [FACTION, faction], [FLAGS, typeId === 4 ? 0x8 : 0]]);
  return { guid, typeId, position: { x, y, z: 0, orientation: 0 }, fields };
}

const SELF = 1n;
const BOAR = 10n; // 5 yd ahead
const WOLF = 11n; // 12 yd ahead
const OGRE = 12n; // 20 yd ahead

/** A world client's selection surface: a clear counts `selectionClears` and, without a selection, sends nothing. */
function fixedWorld() {
  const objects = new Map([
    [SELF, unit(SELF, { typeId: 4, faction: 1 })],
    [BOAR, unit(BOAR, { x: 5 })], [WOLF, unit(WOLF, { x: 12 })], [OGRE, unit(OGRE, { x: 20 })],
  ]);
  return {
    state: { selfGuid: SELF, objects }, targetGuid: undefined, forcedReactions: new Map(), selectionClears: 0,
    creatureTemplates: new Map(), group: undefined, targetHistory: new TargetHistory(), sent: [], aurasFor: () => [],
    selectTarget(guid) {
      if (guid === undefined) this.selectionClears++;
      if (guid === this.targetGuid) return;
      this.sent.push(guid);
      this.targetHistory.selected(this.targetGuid, guid, guid === undefined ? undefined : targetSelectionKind(objects.get(guid)));
      this.targetGuid = guid;
    },
  };
}

function withWorld(body) {
  const world = fixedWorld();
  const previous = { world: game.world, factions: game.factions };
  const clock = { now: 10_000 };
  performance.now = () => clock.now;
  try {
    game.world = world;
    game.factions = factions;
    body(world, clock);
  } finally {
    delete performance.now;
    game.world = previous.world;
    game.factions = previous.factions;
  }
}

/** Tab took the boar, the boar left sight (no clear: the selection just went), the ogre walked up to 2 yards. */
function boarLeft(world, clock) {
  clock.now += 50;
  cycleEnemyTarget();
  assert.equal(world.targetGuid, BOAR);
  assert.equal(world.targetHistory.lastTarget, undefined, "nothing was selected before the boar");
  world.state.objects.delete(BOAR);
  world.targetGuid = undefined;
  world.state.objects.get(OGRE).position = { x: 2, y: 0, z: 0, orientation: 0 };
}

function tab(world, clock) {
  clock.now += 50;
  cycleEnemyTarget();
  return world.targetGuid;
}

test("without the press Tab keeps its old list within 3 s (the control)", () => {
  withWorld((world, clock) => {
    boarLeft(world, clock);
    assert.equal(tab(world, clock), WOLF, "the kept list: the boar's place is the wolf's");
  });
});

test("TargetLastTarget with nothing selected and nothing remembered drops the Tab list (0x00525d70)", () => {
  withWorld((world, clock) => {
    boarLeft(world, clock);
    clock.now += 50;
    assert.equal(targetLastUnit("target"), false, "nothing to select, nothing cleared");
    assert.deepEqual(world.sent, [BOAR], "and nothing goes on the wire");
    assert.equal(tab(world, clock), OGRE, "a fresh list: the ogre now stands nearest");
  });
});

test("ClearTarget with nothing selected (Escape, /cleartarget) drops the Tab list and answers nil (0x00525fc0)", () => {
  withWorld((world, clock) => {
    boarLeft(world, clock);
    clock.now += 50;
    assert.equal(runFrameXmlNativeEscape("clearTarget"), false, "nothing cleared: Escape goes on to the menu");
    assert.deepEqual(world.sent, [BOAR], "nothing goes on the wire");
    assert.equal(tab(world, clock), OGRE, "a fresh list");
  });
});

test("with a selection both still clear it and remember it", () => {
  withWorld((world, clock) => {
    clock.now += 50;
    cycleEnemyTarget();
    assert.equal(runFrameXmlNativeEscape("clearTarget"), true);
    assert.equal(world.targetGuid, undefined);
    assert.equal(world.targetHistory.lastTarget, BOAR);
    clock.now += 50;
    assert.equal(targetLastUnit("target"), true, "the remembered boar comes back");
    assert.equal(world.targetGuid, BOAR);
    world.targetHistory.lastTarget = undefined;
    assert.equal(targetLastUnit("target"), true, "nothing remembered: the selection is let go");
    assert.equal(world.targetGuid, undefined);
    assert.equal(world.targetHistory.lastTarget, BOAR);
  });
});
