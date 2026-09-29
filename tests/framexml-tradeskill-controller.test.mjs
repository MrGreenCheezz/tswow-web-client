import assert from "node:assert/strict";
import test from "node:test";

// The stock TradeSkillFrame's publication (FrameXmlTradeSkillController.ts) and the native side it
// stands in front of (ui/Professions.ts): every profession open asks the stock owner first, the
// native craft window is the fallback, and the stock window drives the native craft queue.

function makeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], hidden: false, disabled: false,
    value: "", textContent: "", type: "", min: "", max: "", dataset: {}, id: "", className: "", title: "",
    style: { setProperty() {}, removeProperty() {} }, parentNode: undefined, listeners: new Map(),
    classList: {
      _set: new Set(),
      add(...names) { for (const name of names) node.classList._set.add(name); },
      remove(...names) { for (const name of names) node.classList._set.delete(name); },
      toggle(name, force) {
        const want = force === undefined ? !node.classList._set.has(name) : force;
        if (want) node.classList._set.add(name); else node.classList._set.delete(name);
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
    addEventListener(type, run) { node.listeners.set(type, [...(node.listeners.get(type) ?? []), run]); },
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
  createElement: (tag) => makeNode(tag), createElementNS: (_ns, tag) => makeNode(tag),
  body: makeNode("body"), documentElement: makeNode("html"), createTextNode: (text) => ({ textContent: text }),
  getElementById: (id) => {
    if (!byId.has(id)) { const node = makeNode("div"); node.id = id; byId.set(id, node); }
    return byId.get(id);
  },
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
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
const controller = await import("../dist/code/browser/framexml/FrameXmlTradeSkillController.js");
const { FRAMEXML_LIVE_TRADESKILL_CRAFT } = await import("../dist/code/browser/framexml/FrameXmlTradeSkillLive.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const recipe = {
  id: 2330, name: "Малое зелье маны", iconId: 0, iconPath: "", rank: "", schoolMask: 0,
  castTime: 0, powerType: 0, powerCost: 0, powerCostPercent: 0,
  recoveryTime: 0, categoryRecoveryTime: 0, startRecoveryTime: 0, cooldownStartedOnEvent: false,
  duration: 0, effectRadius: [], procChance: 0, description: "", rangeMax: 0, rangeMin: 0,
  effects: [24, 0, 0], effectMiscValue: [], effectItemType: [3385, 0, 0], effectBasePoints: [],
  tradeSkill: true, hidden: false, passive: false,
  reagents: [{ itemId: 785, count: 2 }], tools: [], requiredToolCategories: [], requiredToolNames: [],
};
const free = { ...recipe, id: 2331, name: "Бесплатный рецепт", reagents: [] };
const enchant = {
  ...recipe, id: 7418, name: "Чары для наручей - здоровье I", effects: [53, 0, 0], reagents: [],
  equippedItemClass: 4, equippedItemSubclass: 31, equippedItemInvTypes: 512,
};
const opener = { ...recipe, id: 2259, name: "Алхимия", effects: [47, 118, 0], effectMiscValue: [0, 171, 0], tradeSkill: false };
const talentData = {
  revision: 1,
  skillLine: (id) => ({ id, name: "Алхимия", categoryId: 11, iconId: 0 }),
  skillOfSpell: (id) => ([2330, 2331, 2259, 7418].includes(id) ? 171 : undefined),
  spellAbilitiesOf: () => undefined,
  skillCategory: () => undefined,
};

function place(fields, offset, guid) {
  fields.set(offset, Number(guid & 0xffffffffn));
  fields.set(offset + 1, Number(guid >> 32n));
}

function fakeWorld({ herbs = 7 } = {}) {
  const handlers = new Map();
  const player = { guid: 1n, typeId: 4, fields: new Map() };
  const base = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;
  player.fields.set(base, 171);
  player.fields.set(base + 1, 75 | (150 << 16));
  const herb = { guid: 20n, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 785],
    [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, herbs]]) };
  const bracers = { guid: 21n, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 2853]]) };
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, herb.guid);
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 2, bracers.guid);
  const world = {
    castsSent: [],
    state: { selfGuid: 1n, objects: new Map([[1n, player], [herb.guid, herb], [bracers.guid, bracers]]) },
    knownSpells: [{ id: 2259 }, { id: 2330 }, { id: 2331 }, { id: 7418 }],
    casts: new Map(), itemTemplates: new Map(), globalCooldownUntil: 0,
    cooldownRemaining: () => 0,
    castSpell(id) { world.castsSent.push(id); },
    castSpellOnItem(id, guid) { world.castsSent.push(["item", id, guid]); },
    cancelSpellCast() {},
    itemTemplate: (entry) => entry === 2853
      ? { found: true, entry, name: "Медные наручи", itemClass: 4, subClass: 3, inventoryType: 9 } : undefined,
    events: {
      on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
    },
    emit(name, data) { for (const fn of handlers.get(name) ?? []) fn(data); },
  };
  return world;
}

function withWorld(world, run) {
  game.world = world;
  game.spells = new Map([[2259, opener], [2330, recipe], [2331, free], [7418, enchant]]);
  game.talentData = talentData;
  game.globalCooldownUntil = 0;
  try { return run(); } finally {
    professions.closeProfessions();
    game.world = undefined;
    game.spells = new Map();
    game.talentData = undefined;
  }
}

const nativeCraftOpen = () => professions.professionsOpen();

test("openProfession asks the published stock owner first and opens natively only when it declines", () => {
  withWorld(fakeWorld(), () => {
    const asked = [];
    let answer = true;
    const cleanup = controller.publishFrameXmlTradeSkill({
      isOpen: () => false, close: () => false,
      open: (skillId) => { asked.push(skillId); return answer; },
    });
    try {
      assert.equal(controller.frameXmlTradeSkillPublished(), true);
      assert.equal(professions.openProfession(171), true);
      assert.deepEqual(asked, [171]);
      assert.equal(nativeCraftOpen(), false, "the stock window took it; no native craft window");
      answer = false;
      assert.equal(professions.openProfession(171), true);
      assert.deepEqual(asked, [171, 171]);
      assert.equal(nativeCraftOpen(), true, "a declined line opens natively");
      professions.closeProfessions();
    } finally {
      cleanup();
    }
    assert.equal(controller.frameXmlTradeSkillPublished(), false);
    assert.equal(professions.openProfession(171), true);
    assert.deepEqual(asked, [171, 171], "unpublished: the native window without asking");
    assert.equal(nativeCraftOpen(), true);
  });
});

test("an owner that throws is demoted and the native window opens; publication is identity-safe", () => {
  withWorld(fakeWorld(), () => {
    let demoted = 0;
    const first = {
      isOpen: () => true, targeting: () => false, closes: 0, disposed: 0,
      close() { this.closes += 1; return true; },
      dispose() { this.disposed += 1; },
      open: () => { throw new Error("broken VM"); },
      demote: () => { demoted += 1; },
    };
    const releaseFirst = controller.publishFrameXmlTradeSkill(first);
    assert.equal(controller.openFrameXmlTradeSkill(171), false);
    assert.equal(demoted, 1);
    assert.equal(professions.openProfession(171), true);
    assert.equal(nativeCraftOpen(), true, "the throw fell through to the native window");
    professions.closeProfessions();

    const second = { isOpen: () => false, close: () => false, open: () => true };
    const releaseSecond = controller.publishFrameXmlTradeSkill(second);
    assert.equal(first.closes, 1, "the replaced owner is closed");
    assert.equal(first.disposed, 1, "and disposed");
    releaseFirst();
    assert.equal(controller.frameXmlTradeSkillPublished(), true, "a stale cleanup leaves the new owner");
    releaseSecond();
    releaseSecond();
    assert.equal(controller.frameXmlTradeSkillPublished(), false);
  });
});

test("Escape drops a waiting enchant on one press and closes the window on the next", () => {
  let targeting = true;
  let open = true;
  const cleanup = controller.publishFrameXmlTradeSkill({
    isOpen: () => open, targeting: () => targeting,
    cancelTargeting: () => { const had = targeting; targeting = false; return had; },
    close: () => { const was = open; open = false; return was; },
    open: () => true,
  });
  try {
    // Both up, as after «Зачаровать»: stock ToggleGameMenu ends the press at SpellStopTargeting.
    assert.equal(controller.frameXmlTradeSkillOpen(), true);
    assert.equal(controller.closeFrameXmlTradeSkill(), true);
    assert.equal(targeting, false, "the first press drops the enchant");
    assert.equal(open, true, "and leaves the window");
    assert.equal(controller.frameXmlTradeSkillOpen(), true, "which still holds Escape's attention");
    assert.equal(controller.closeFrameXmlTradeSkill(), true);
    assert.equal(open, false, "the second press closes it");
    assert.equal(controller.frameXmlTradeSkillOpen(), false);
    targeting = true;
    assert.equal(controller.frameXmlTradeSkillOpen(), true, "a waiting enchant alone keeps Escape's attention");
    assert.equal(controller.closeFrameXmlTradeSkill(), true);
    assert.equal(targeting, false);
  } finally {
    cleanup();
  }
  assert.equal(controller.frameXmlTradeSkillOpen(), false);
  assert.equal(controller.closeFrameXmlTradeSkill(), false);
});

test("the mount shows the client's cast cursor while an enchant waits, and asks for its picture once", async () => {
  const { mountFrameXmlTradeSkill, FRAMEXML_CAST_CURSOR_CLASS, FRAMEXML_CAST_CURSOR_PROPERTY } = await import(
    "../dist/code/browser/framexml/FrameXmlTradeSkillLive.js");
  const { createCannedFrameXmlTradeSkill, FRAMEXML_CANNED_ENCHANTING } = await import(
    "../dist/code/browser/framexml/FrameXmlTradeSkillCanned.js");
  const { model } = createCannedFrameXmlTradeSkill();
  model.attach({ fire: () => 1, now: () => 0 });
  const properties = new Map();
  const style = document.documentElement.style;
  document.documentElement.style = {
    setProperty: (name, value) => properties.set(name, value), removeProperty: (name) => properties.delete(name),
  };
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }) };
  };
  const armed = () => document.body.classList.contains(FRAMEXML_CAST_CURSOR_CLASS);
  const mount = mountFrameXmlTradeSkill({ tradeSkill: model }, {}, {}, (path) => `http://gateway/texture?path=${path}`);
  const cleanup = mount.publish();
  try {
    model.open(FRAMEXML_CANNED_ENCHANTING);
    model.show();
    assert.equal(armed(), false);
    model.doTradeSkill(3, 1);
    assert.equal(armed(), true, "«Зачаровать»: the cast cursor is up");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(fetched, ["http://gateway/texture?path=Interface\\Cursor\\Cast.blp"]);
    assert.match(properties.get(FRAMEXML_CAST_CURSOR_PROPERTY), /^url\("blob:[^"]+"\) 0 0, crosshair$/);
    model.cancelTargeting();
    assert.equal(armed(), false, "dropped, the cursor goes back");
    model.doTradeSkill(3, 1);
    assert.equal(armed(), true);
    assert.equal(fetched.length, 1, "the picture is asked for once");
    model.close();
    assert.equal(armed(), false, "closing the window drops it too");
    model.open(FRAMEXML_CANNED_ENCHANTING);
    model.show();
    model.doTradeSkill(3, 1);
  } finally {
    cleanup();
    globalThis.fetch = realFetch;
    document.documentElement.style = style;
  }
  assert.equal(armed(), false, "the unmount takes the cursor down");
  assert.equal(properties.has(FRAMEXML_CAST_CURSOR_PROPERTY), false);
  assert.equal(controller.frameXmlTradeSkillPublished(), false);
});

test("DoTradeSkill's craft hook uses the native queue, clamped to the bags and past the native box's 20", () => {
  withWorld(fakeWorld({ herbs: 7 }), () => {
    const world = game.world;
    const craft = FRAMEXML_LIVE_TRADESKILL_CRAFT;
    assert.equal(craft.remaining(), 0);
    assert.equal(craft.craft(2330, 5), true);
    assert.deepEqual(world.castsSent, [2330], "one cast goes out at once");
    assert.deepEqual(professions.craftQueueState(), { spellId: 2330, left: 2 }, "7 herbs make 3, not 5");
    assert.equal(craft.remaining(), 3);
    world.emit("SPELL_CAST_STOP", { casterGuid: 1n, spellId: 2330, reason: "success" });
    assert.deepEqual(world.castsSent, [2330, 2330]);
    assert.equal(craft.remaining(), 2);
    craft.stop();
    assert.equal(professions.craftQueueState(), undefined, "StopTradeSkillRepeat ends the queue");
    assert.equal(craft.remaining(), 1, "the cast in flight is the server's to finish");
    world.emit("SPELL_CAST_STOP", { casterGuid: 1n, spellId: 2330, reason: "success" });
    assert.deepEqual(world.castsSent, [2330, 2330], "nothing after the stop");
    assert.equal(craft.remaining(), 0);

    assert.equal(craft.craft(2331, 150), true, "a recipe without reagents");
    assert.deepEqual(professions.craftQueueState(), { spellId: 2331, left: 149 },
      "«Создать все» of the stock window is not the native box's CRAFT_QUEUE_MAX");
    world.emit("SPELL_GO", { casterGuid: 1n, casterUnit: 1n, spellId: 2331 });
    assert.deepEqual(professions.craftQueueState(), { spellId: 2331, left: 148 });
    craft.stop();
    world.emit("SPELL_GO", { casterGuid: 1n, casterUnit: 1n, spellId: 2331 });

    assert.equal(craft.craft(7418, 1), false, "an enchant is not crafted blind");
    assert.equal(craft.craft(9999, 1), false, "an unknown spell is not cast");
    assert.equal(craft.castOnItem(7418, 20n), false, "the herb is no bracer");
    assert.equal(craft.castOnItem(7418, 21n), true);
    assert.deepEqual(world.castsSent.at(-1), ["item", 7418, 21n]);
  });
});

test("the native craft window steps aside for the stock one without dropping its queue", () => {
  withWorld(fakeWorld({ herbs: 20 }), () => {
    assert.equal(professions.nativeProfessionOpen(171), false);
    assert.equal(professions.openNativeProfession(171), true);
    assert.equal(nativeCraftOpen(), true);
    assert.equal(professions.nativeProfessionOpen(171), true, "the lazy owner's view of its fallback");
    assert.equal(professions.nativeProfessionOpen(186), false);
    assert.equal(FRAMEXML_LIVE_TRADESKILL_CRAFT.craft(2330, 4), true);
    professions.hideProfessionWindows();
    assert.equal(nativeCraftOpen(), false);
    assert.equal(professions.nativeProfessionOpen(171), false);
    assert.deepEqual(professions.craftQueueState(), { spellId: 2330, left: 3 }, "the queue runs on");
    assert.equal(professions.openNativeProfession(186), false, "a line the character lacks stays refused");
  });
});
