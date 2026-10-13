// Plan item 1.10 (12.10): this client's own macro runner (ui/Macros.ts `runNativeMacroLine`) sent /targetenemy and
// the rest of the stock secure targeting commands to its chat, which knew none of them. They now run their
// ChatFrame.lua:1163-1263 bodies (ui/NativeTargetCommands.ts): SecureCmdOptionParse, then TargetNearest*(action) /
// ClearTarget / TargetLast* / AssistUnit / FocusUnit / ClearFocus over the same Tab list, history and focus the
// native keys and the stock UI use. The words are the ruRU GlobalStrings' SLASH_* ones, `strupper`ed (ASCII only).
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
const { targetSelectionKind } = await import("../dist/code/browser/game/Targeting.js");
const { wireControls } = await import("../dist/code/browser/input/Controls.js");
const { runNativeTargetCommand } = await import("../dist/code/browser/ui/NativeTargetCommands.js");

wireControls();

const HEALTH = UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset;
const FACTION = UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset;
const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const TARGET = UPDATE_FIELDS.UNIT_FIELD_TARGET.offset;

const factions = { ready: true, reaction: (_mine, theirs) => (theirs === 2 ? -1 : 1), factionOf: () => undefined };

function unit(guid, { typeId = 3, x = 0, faction = 2 } = {}) {
  const fields = new Map([[HEALTH, 100], [FACTION, faction], [FLAGS, typeId === 4 ? 0x8 : 0]]);
  return { guid, typeId, position: { x, y: 0, z: 0, orientation: 0 }, fields };
}

const SELF = 1n;
const BOAR = 10n; // 5 yd ahead
const WOLF = 11n; // 12 yd ahead
const FRIEND = 12n; // a friendly player, 8 yd ahead
const OGRE = 13n; // 20 yd ahead

function fixedWorld() {
  const objects = new Map([
    [SELF, unit(SELF, { typeId: 4, faction: 1 })],
    [BOAR, unit(BOAR, { x: 5 })], [WOLF, unit(WOLF, { x: 12 })], [FRIEND, unit(FRIEND, { typeId: 4, x: 8, faction: 1 })],
    [OGRE, unit(OGRE, { x: 20 })],
  ]);
  return {
    state: { selfGuid: SELF, objects }, targetGuid: undefined, forcedReactions: new Map(), selectionClears: 0,
    creatureTemplates: new Map(), group: undefined, targetHistory: new TargetHistory(), aurasFor: () => [],
    names: new Map([[FRIEND, "Друг"]]), selfName: "Сам", partyStats: new Map(), casts: new Map(),
    selectTarget(guid) {
      if (guid === undefined) this.selectionClears++;
      if (guid === this.targetGuid) return;
      this.targetHistory.selected(this.targetGuid, guid, guid === undefined ? undefined : targetSelectionKind(objects.get(guid)));
      this.targetGuid = guid;
    },
  };
}

function withWorld(body) {
  const world = fixedWorld();
  const previous = { world: game.world, factions: game.factions, focus: game.focusGuid };
  const clock = { now: 10_000 };
  performance.now = () => clock.now;
  try {
    game.world = world;
    game.factions = factions;
    game.focusGuid = undefined;
    body(world, (line) => { clock.now += 50; return runNativeTargetCommand(line); });
  } finally {
    delete performance.now;
    game.world = previous.world;
    game.factions = previous.factions;
    game.focusGuid = previous.focus;
  }
}

test("/targetenemy steps the Tab list; a true action steps it back; the ruRU word and ASCII case count", () => {
  withWorld((world, run) => {
    assert.equal(run("/targetenemy"), true);
    assert.equal(world.targetGuid, BOAR);
    run("/цельвраг");
    assert.equal(world.targetGuid, WOLF, "SLASH_TARGET_NEAREST_ENEMY2");
    run("/TargetEnemy 1");
    assert.equal(world.targetGuid, BOAR, "an action of 1 is TargetNearestEnemy(reverse)");
    run("/targetenemy 0");
    assert.equal(world.targetGuid, WOLF, "an action of 0 steps forward");
    run("/targetenemy");
    assert.equal(world.targetGuid, OGRE);
    assert.equal(run("/ЦЕЛЬВРАГ"), false, "strupper leaves Cyrillic alone: not the command");
    assert.equal(run("/dance"), false, "any other line is the chat's");
    assert.equal(run("/targetenemyx"), false);
  });
});

test("options decide: no clause holds — nothing; /targetfriend takes a friend", () => {
  withWorld((world, run) => {
    run("/targetenemy [@focus,exists]");
    assert.equal(world.targetGuid, undefined, "no focus: SecureCmdOptionParse answers nil");
    run("/targetfriend");
    assert.equal(world.targetGuid, FRIEND, "TargetNearestFriend");
  });
});

test("/cleartarget, /targetlasttarget, /targetlastenemy", () => {
  withWorld((world, run) => {
    run("/targetenemy");
    run("/cleartarget");
    assert.equal(world.targetGuid, undefined, "ClearTarget");
    run("/targetlasttarget");
    assert.equal(world.targetGuid, BOAR, "the cleared boar comes back");
    run("/targetfriend");
    run("/сбросцели");
    assert.equal(world.targetHistory.lastTarget, FRIEND);
    run("/targetlastenemy");
    assert.equal(world.targetGuid, BOAR, "TargetLastEnemy: the boar, not the last target");
    run("/targetfriend");
    run("/targetlastfriend [@target,exists]");
    assert.equal(world.targetGuid, FRIEND);
  });
});

test("/focus, /focus [@player], /focus Name, /clearfocus and /assist", () => {
  withWorld((world, run) => {
    run("/targetenemy");
    run("/focus");
    assert.equal(game.focusGuid, BOAR, "bare /focus: FocusUnit() — the target");
    run("/focus [@player]");
    assert.equal(game.focusGuid, SELF, "the options' unit");
    run("/фокус Друг");
    assert.equal(game.focusGuid, FRIEND, "a name: the action is the unit");
    run("/clearfocus");
    assert.equal(game.focusGuid, undefined, "ClearFocus");
    // The boar has the wolf selected: /assist selects the target's target.
    world.state.objects.get(BOAR).fields.set(TARGET, Number(WOLF));
    run("/assist");
    assert.equal(world.targetGuid, WOLF, "AssistUnit()");
    world.state.objects.get(SELF).fields.set(TARGET, Number(OGRE));
    run("/assist [@player]");
    assert.equal(world.targetGuid, OGRE, "AssistUnit(the options' unit)");
    world.state.objects.get(FRIEND).fields.set(TARGET, Number(BOAR));
    run("/a [@focus,exists] focus; Друг");
    assert.equal(world.targetGuid, BOAR, "AssistUnit(action) when no unit holds the options");
  });
});
