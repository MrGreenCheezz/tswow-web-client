import assert from "node:assert/strict";
import test, { after } from "node:test";

// 4.03: the native spellbook's pet tab. Its rows are the stock pet book's (FrameXmlPetActionBarLive:
// SMSG_PET_SPELLS' list in the realm's order); a click casts through CMSG_PET_ACTION with the spell's
// book state, a right click toggles autocast, a passive spell sends nothing, and a book spell dropped
// on the native pet bar is CMSG_PET_SET_ACTION with its state — the stock PickupSpell(i, "pet") drop.

function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "", draggable: false, checked: false,
      listeners: {}, attributes: {},
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener(name, listener) { (node.listeners[name] ??= []).push(listener); },
      removeEventListener() {},
      dispatch(name, event = {}) { for (const listener of node.listeners[name] ?? []) listener({ preventDefault() {}, ...event }); },
      setAttribute(name, value) { node.attributes[name] = String(value); },
      getAttribute(name) { return node.attributes[name] ?? null; },
      removeAttribute(name) { delete node.attributes[name]; },
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
      if (!node) { node = make("div"); node.id = id; byId.set(id, node); }
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

const { game } = await import("../dist/code/browser/game/Context.js");
const { selectSpellbookTab, showSpells } = await import("../dist/code/browser/ui/Spellbook.js");
const { SPELLBOOK_PET_TAB, PET_SPELL_DRAG_FORMAT, nativePetBook } = await import("../dist/code/browser/ui/PetSpellbook.js");
const { spellbookList, spellbookTabs, spellStatus } = await import("../dist/code/browser/ui/Dom.js");
const { ACT_COMMAND, ACT_DISABLED, ACT_ENABLED, ACT_PASSIVE, ACT_REACTION, packPetAction } =
  await import("../dist/code/world/PetProtocol.js");
const { setStringSource } = await import("../dist/code/browser/ui/Strings.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

setStringSource(() => undefined);
after(() => { game.world = undefined; game.talentData = undefined; game.spells.clear(); });

const SELF = 1n;
const PET = 0xf140_0000_0000_0042n;
const BITE = 17253;
const GROWL = 2649;
const AVOIDANCE = 35694;

function spellRow(id, name, extra = {}) {
  return { id, name, rank: "Уровень 1", iconId: 0, passive: false, hidden: false, tradeSkill: false, description: "",
    spellLevel: 1, spellClassSet: 0, spellClassMask: [0, 0, 0],
    recoveryTime: 0, categoryRecoveryTime: 0, startRecoveryTime: 0, castTime: 0, effectAura: [], ...extra };
}

function petWorld(spells, creatureType = 1) {
  const sent = [];
  const self = { guid: SELF, typeId: 4, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 | (3 << 8)]]) };
  const pet = { guid: PET, typeId: 3, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 4000]]) };
  const bar = [
    { slot: 0, packed: packPetAction(2, ACT_COMMAND), action: 2, type: ACT_COMMAND },
    { slot: 1, packed: packPetAction(1, ACT_COMMAND), action: 1, type: ACT_COMMAND },
    { slot: 2, packed: packPetAction(0, ACT_COMMAND), action: 0, type: ACT_COMMAND },
    { slot: 3, packed: packPetAction(BITE, ACT_ENABLED), action: BITE, type: ACT_ENABLED },
    ...[4, 5, 6].map((slot) => ({ slot, packed: 0, action: 0, type: 0 })),
    { slot: 7, packed: packPetAction(2, ACT_REACTION), action: 2, type: ACT_REACTION },
    { slot: 8, packed: packPetAction(1, ACT_REACTION), action: 1, type: ACT_REACTION },
    { slot: 9, packed: packPetAction(0, ACT_REACTION), action: 0, type: ACT_REACTION },
  ];
  const world = {
    initialSpellsReceived: true, knownSpells: [{ id: 6603 }], spellModifiers: new Map(),
    state: { selfGuid: SELF, objects: new Map([[SELF, self], [PET, pet]]) },
    petSpells: { guid: PET, closed: false, creatureFamily: 1, duration: 0, reactState: 1, commandState: 1, flags: 0,
      bar, spells, cooldowns: [] },
    petCooldowns: new Map(), controlledGuid: undefined,
    creatureTemplates: new Map([[4000, { creatureType }]]),
    events: { on: () => () => {} },
    castPetSpell: (spellId, state) => sent.push(["cast", spellId, state]),
    togglePetAutocast: (spellId, enabled) => sent.push(["autocast", spellId, enabled]),
    setPetActionSlot: (slot, packed) => sent.push(["slot", slot, packed]),
    isActiveMountSpell: () => false, isSpellOnHold: () => false, cooldownRemaining: () => 0,
  };
  return { world, sent };
}

function useWorld(world) {
  game.world = world;
  game.talentData = { ready: true, skillOfSpell: () => 183, skillLine: () => ({ categoryId: 12 }) };
  game.spells.set(6603, spellRow(6603, "Автоматическая атака"));
  game.spells.set(BITE, spellRow(BITE, "Укус"));
  game.spells.set(GROWL, spellRow(GROWL, "Рык"));
  game.spells.set(AVOIDANCE, spellRow(AVOIDANCE, "Избегание", { passive: true }));
}

const tabLabels = () => spellbookTabs.children[0].children.map((tab) => tab.children.at(-1).textContent);

test("a hunter's pet book is the last tab, «Питомец (3)», its rows in the realm's order", () => {
  const { world } = petWorld([
    { spellId: GROWL, active: ACT_DISABLED }, { spellId: BITE, active: ACT_ENABLED }, { spellId: AVOIDANCE, active: ACT_PASSIVE },
  ]);
  useWorld(world);
  selectSpellbookTab(undefined);
  assert.deepEqual(tabLabels(), ["Общие (1)", "Питомец (3)"]);
  selectSpellbookTab(SPELLBOOK_PET_TAB);
  const rows = spellbookList.children;
  assert.deepEqual(rows.map((row) => row.children[1].textContent), ["Рык", "Укус · автоприменение", "Избегание · пассивное"]);
  assert.deepEqual(rows.map((row) => row.disabled), [false, false, true], "a passive spell is not a button to press");
  assert.equal(spellStatus.textContent, "3 заклинаний");
});

test("click casts with the book state, right click toggles autocast, a passive spell sends nothing", () => {
  const { world, sent } = petWorld([
    { spellId: GROWL, active: ACT_DISABLED }, { spellId: BITE, active: ACT_ENABLED }, { spellId: AVOIDANCE, active: ACT_PASSIVE },
  ]);
  useWorld(world);
  selectSpellbookTab(SPELLBOOK_PET_TAB);
  const [growl, bite, avoidance] = spellbookList.children;
  growl.dispatch("click");
  bite.dispatch("contextmenu");
  growl.dispatch("contextmenu");
  avoidance.dispatch("click");
  avoidance.dispatch("contextmenu");
  assert.deepEqual(sent, [["cast", GROWL, ACT_DISABLED], ["autocast", BITE, false], ["autocast", GROWL, true]]);
});

test("a book spell dragged onto the pet bar takes an empty slot with its state; never a command slot", async () => {
  const { world, sent } = petWorld([{ spellId: GROWL, active: ACT_DISABLED }, { spellId: BITE, active: ACT_ENABLED }]);
  useWorld(world);
  selectSpellbookTab(SPELLBOOK_PET_TAB);
  const carried = new Map();
  spellbookList.children[0].dispatch("dragstart", { dataTransfer: { setData: (format, value) => carried.set(format, value) } });
  assert.equal(carried.get(PET_SPELL_DRAG_FORMAT), String(GROWL));
  nativePetBook().placeSpell(5, GROWL);
  nativePetBook().placeSpell(1, GROWL);
  assert.deepEqual(sent, [["slot", 4, packPetAction(GROWL, ACT_DISABLED)]]);
  // The native bar's drop handler reads the same format (PetBar.ts) and hands it to the same model.
  const { readFile } = await import("node:fs/promises");
  const petBar = await readFile(new URL("../src/browser/ui/PetBar.ts", import.meta.url), "utf8");
  assert.match(petBar, /getData\(PET_SPELL_DRAG_FORMAT\)[\s\S]{0,200}nativePetBook\(\)\.placeSpell\(index \+ 1, spellId\)/);
});

test("a demon's book is «Демон»; a temporary pet (no list) has no tab and a selected pet tab falls back", () => {
  const { world } = petWorld([{ spellId: BITE, active: ACT_ENABLED }], 3);
  useWorld(world);
  selectSpellbookTab(SPELLBOOK_PET_TAB);
  assert.deepEqual(tabLabels(), ["Общие (1)", "Демон (1)"]);
  world.petSpells.spells = [];
  showSpells();
  assert.deepEqual(tabLabels(), ["Общие (1)"]);
  assert.equal(spellbookList.children.length, 1, "back on General: its one spell");
});

test("a vehicle's bar is not a pet book: its words are slot indices, and no tab is drawn", () => {
  const { world } = petWorld([{ spellId: BITE, active: ACT_ENABLED }]);
  world.petSpells.bar = world.petSpells.bar.map((button, slot) => ({ ...button, packed: packPetAction(BITE, 8 + slot), type: 8 + slot }));
  useWorld(world);
  selectSpellbookTab(SPELLBOOK_PET_TAB);
  assert.deepEqual(tabLabels(), ["Общие (1)"]);
});

test("L7 4.03: the pet tab's rows sweep their cooldowns from the pet's timers, as the character's rows do", async () => {
  const { updateSpellCooldowns } = await import("../dist/code/browser/ui/Spellbook.js");
  const { world } = petWorld([{ spellId: GROWL, active: ACT_DISABLED }, { spellId: BITE, active: ACT_ENABLED }]);
  world.cooldownState = () => undefined;
  useWorld(world);
  game.spells.set(BITE, spellRow(BITE, "Укус", { recoveryTime: 10_000 }));
  const now = 50_000;
  // SMSG_SPELL_COOLDOWN of the pet: Bite cast 2.5 s ago, 7.5 s left of its 10 s; Growl ready.
  world.petCooldowns.set(BITE, now + 7_500);
  selectSpellbookTab(SPELLBOOK_PET_TAB);
  updateSpellCooldowns(now);
  const [growl, bite] = spellbookList.children;
  const sweepOf = (row) => row.children.find((child) => child.className === "spell-cooldown");
  assert.equal(sweepOf(growl).hidden, true, "a ready spell shows no sweep");
  assert.equal(sweepOf(bite).hidden, false);
  assert.equal(sweepOf(bite).textContent, "7.5");
  assert.equal(sweepOf(bite).style["--sweep"], "270deg", "7.5 of the spell's 10 s still to run");
  updateSpellCooldowns(now + 8_000);
  assert.equal(sweepOf(bite).hidden, true, "over: the sweep goes");
  assert.equal(sweepOf(bite).textContent, "");
});
