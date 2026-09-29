import assert from "node:assert/strict";
import test from "node:test";

// Q1: «Сделать N» — очередь повторов поверх существующего одиночного каста.
//
// The queue is only the count: every cast still travels the same `sendProfessionCast` path,
// the server still owns every verdict, and any refusal or interruption clears it.

// The queue helpers live beside the other DOM-free craft rules so they can be tested without
// a page; the window half below drives the real module over a stub document.
function makeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], hidden: false, disabled: false,
    value: "", textContent: "", type: "", min: "", max: "",
    dataset: {}, id: "", className: "", title: "",
    style: { setProperty() {}, removeProperty() {} },
    parentNode: undefined,
    listeners: new Map(),
    classList: {
      _set: new Set(),
      add(...names) { for (const name of names) node.classList._set.add(name); node.className = [...node.classList._set].join(" "); },
      remove(...names) { for (const name of names) node.classList._set.delete(name); node.className = [...node.classList._set].join(" "); },
      toggle(name, force) {
        const want = force === undefined ? !node.classList._set.has(name) : force;
        if (want) node.classList._set.add(name);
        else node.classList._set.delete(name);
        node.className = [...node.classList._set].join(" ");
        return want;
      },
      contains(name) { return node.classList._set.has(name); },
    },
    append(...kids) { for (const kid of kids) { kid.parentNode = node; node.children.push(kid); } },
    prepend(...kids) { for (const kid of [...kids].reverse()) { kid.parentNode = node; node.children.unshift(kid); } },
    replaceChildren(...kids) { node.children = [...kids]; for (const kid of kids) kid.parentNode = node; },
    remove() {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((kid) => kid !== node);
      node.parentNode = undefined;
    },
    addEventListener(type, run) {
      const list = node.listeners.get(type) ?? [];
      list.push(run);
      node.listeners.set(type, list);
    },
    removeEventListener() {},
    setAttribute(name, value) { node[name] = value; },
    getAttribute(name) { return node[name] ?? null; },
    removeAttribute(name) { delete node[name]; },
    focus() {}, blur() {},
    click() { for (const run of node.listeners.get("click") ?? []) run({ preventDefault() {}, stopPropagation() {} }); },
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
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900,
  setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args),
};
globalThis.location = { origin: "http://localhost:5173", protocol: "http:", hostname: "localhost" };
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
usePanelHost({ viewport: document.body, attach() {} });
const professions = await import("../dist/code/browser/ui/Professions.js");
const { CRAFT_QUEUE_MAX } = professions;
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const recipeMeta = {
  id: 2330, name: "Малое зелье маны", iconId: 0, rank: "", schoolMask: 0,
  castTime: 0, powerType: 0, powerCost: 0, powerCostPercent: 0,
  recoveryTime: 0, categoryRecoveryTime: 0, startRecoveryTime: 0, cooldownStartedOnEvent: false,
  duration: 0, effectRadius: [], procChance: 0, description: "",
  rangeMax: 0, rangeMin: 0,
  effects: [24, 0, 0], effectMiscValue: [], effectItemType: [], effectBasePoints: [],
  tradeSkill: true, hidden: false, passive: false,
  reagents: [], tools: [], requiredToolCategories: [], requiredToolNames: [],
};
const openerMeta = {
  ...recipeMeta, id: 2259, name: "Алхимия",
  effects: [47, 118, 0], effectMiscValue: [0, 171, 0], tradeSkill: false,
};
const talentData = {
  revision: 1,
  skillLine: (id) => ({ id, name: "Алхимия", categoryId: 11, iconId: 0 }),
  skillOfSpell: (id) => (id === 2330 || id === 2259 ? 171 : undefined),
  spellAbilitiesOf: () => undefined,
  skillCategory: () => undefined,
};

function fakeWorld() {
  const handlers = new Map();
  const world = {
    castsSent: [],
    state: { selfGuid: 1n, objects: new Map() },
    knownSpells: [{ id: 2259, slot: 0 }, { id: 2330, slot: 1 }],
    casts: new Map(),
    itemTemplates: new Map(),
    globalCooldownUntil: 0,
    cooldownRemaining: () => 0,
    castSpell(id) { world.castsSent.push(id); },
    castSpellOnItem() { world.castsSent.push("item"); },
    cancelSpellCast() {},
    itemTemplate: () => undefined,
    events: {
      on(name, fn) {
        const list = handlers.get(name) ?? [];
        list.push(fn);
        handlers.set(name, list);
        return () => {};
      },
    },
    emit(name, data) { for (const fn of handlers.get(name) ?? []) fn(data); },
  };
  const base = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;
  world.state.objects.set(1n, {
    guid: 1n, typeId: 4,
    fields: new Map([[base, 171], [base + 1, 75 | (150 << 16)]]),
  });
  return world;
}

function walk(entry, visit) {
  visit(entry);
  for (const child of entry.children ?? []) walk(child, visit);
}
const all = () => {
  const found = [];
  walk(document.body, (entry) => found.push(entry));
  return found;
};
const craftButton = () => all().find((entry) => entry.tagName === "BUTTON" && entry.className === "craft-create");
const countInput = () => all().find((entry) => entry.tagName === "INPUT" && entry.type === "number");
const statusText = () => all()
  .filter((entry) => entry.tagName === "P" && entry.className === "muted craft-status")
  .map((entry) => entry.textContent).join(" / ");

test("a count of three casts three times, one success at a time", () => {
  assert.equal(CRAFT_QUEUE_MAX, 20);
  const world = fakeWorld();
  game.world = world;
  game.spells = new Map([[2259, openerMeta], [2330, recipeMeta]]);
  game.talentData = talentData;
  game.globalCooldownUntil = 0;
  try {
    assert.equal(professions.openProfession(171), true);
    const input = countInput();
    assert.ok(input, "the recipe detail offers a count");
    input.value = "3";
    craftButton().click();
    assert.deepEqual(world.castsSent, [2330], "the first cast goes out on the click");
    assert.deepEqual(professions.craftQueueState(), { spellId: 2330, left: 2 });

    world.emit("SPELL_CAST_STOP", { casterGuid: 1n, spellId: 2330, reason: "success" });
    assert.deepEqual(world.castsSent, [2330, 2330], "a success chains the second cast");
    assert.deepEqual(professions.craftQueueState(), { spellId: 2330, left: 1 });
    assert.match(statusText(), /Осталось создать: 1/);

    world.emit("SPELL_CAST_STOP", { casterGuid: 1n, spellId: 2330, reason: "success" });
    assert.deepEqual(world.castsSent, [2330, 2330, 2330]);
    assert.equal(professions.craftQueueState(), undefined, "the last success finishes the queue");
  } finally {
    professions.closeProfessions();
    game.world = undefined;
    game.spells = new Map();
    game.talentData = undefined;
  }
});

test("an interruption or a realm refusal stops the queue instead of retrying it", () => {
  const world = fakeWorld();
  game.world = world;
  game.spells = new Map([[2259, openerMeta], [2330, recipeMeta]]);
  game.talentData = talentData;
  game.globalCooldownUntil = 0;
  try {
    assert.equal(professions.openProfession(171), true);
    countInput().value = "5";
    craftButton().click();
    assert.deepEqual(professions.craftQueueState(), { spellId: 2330, left: 4 });

    world.emit("SPELL_CAST_STOP", { casterGuid: 1n, spellId: 2330, reason: "interrupted" });
    assert.deepEqual(world.castsSent, [2330], "movement (or anything else) sends no second cast");
    assert.equal(professions.craftQueueState(), undefined);

    countInput().value = "2";
    craftButton().click();
    assert.deepEqual(professions.craftQueueState(), { spellId: 2330, left: 1 });
    professions.professionCastStatus("Недостаточно реагентов", true);
    assert.equal(professions.craftQueueState(), undefined, "a realm refusal clears the queue too");
    assert.deepEqual(world.castsSent, [2330, 2330], "and sends nothing further");
  } finally {
    professions.closeProfessions();
    game.world = undefined;
    game.spells = new Map();
    game.talentData = undefined;
  }
});

test("the count is clamped and one stays a single cast", () => {
  const world = fakeWorld();
  game.world = world;
  game.spells = new Map([[2259, openerMeta], [2330, recipeMeta]]);
  game.talentData = talentData;
  game.globalCooldownUntil = 0;
  try {
    assert.equal(professions.openProfession(171), true);
    countInput().value = "99";
    craftButton().click();
    assert.deepEqual(professions.craftQueueState(), { spellId: 2330, left: CRAFT_QUEUE_MAX - 1 },
      "no reagent math can justify more than the cap");
    professions.closeProfessions();
    assert.equal(professions.craftQueueState(), undefined, "closing the window drops the queue");

    assert.equal(professions.openProfession(171), true);
    countInput().value = "1";
    craftButton().click();
    assert.equal(professions.craftQueueState(), undefined, "one is the old single cast, not a queue of one");
    world.emit("SPELL_GO", { casterGuid: 1n, casterUnit: 1n, spellId: 2330 });
    assert.equal(world.castsSent.length, 2, "an instant finish sends nothing more");
  } finally {
    professions.closeProfessions();
    game.world = undefined;
    game.spells = new Map();
    game.talentData = undefined;
  }
});
