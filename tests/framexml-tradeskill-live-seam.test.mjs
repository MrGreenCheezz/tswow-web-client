import assert from "node:assert/strict";
import test from "node:test";

// LiveWorldSeam's trade skill model over a real skill and item projection: the learned line comes
// from PLAYER_SKILL_INFO, the recipes from the known spells and the host's /dbc/talents rows, the
// reagent counts from the carried slots, headings from item_template replies and the host's
// ItemSubClass words; bag and paper-doll clicks are an enchant's target while one waits.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { createFrameXmlSubclassNames } = await import("../dist/code/browser/framexml/FrameXmlTradeSkill.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

function place(fields, offset, guid) {
  fields.set(offset, Number(guid & 0xffffffffn));
  fields.set(offset + 1, Number(guid >> 32n));
}

function spell(id, name, fields) {
  return {
    id, name, rank: "", description: "", iconId: 0, iconPath: "Interface\\Icons\\Spell_Shadow_SealOfKings",
    passive: false, hidden: false, tradeSkill: true, effects: [24, 0, 0], effectItemType: [0, 0, 0],
    reagents: [], tools: [], requiredToolCategories: [], requiredToolNames: [],
    effectBasePoints: [0, 0, 0], effectDieSides: [1, 0, 0], effectMiscValue: [0, 0, 0], ...fields,
  };
}

const SPELLS = new Map([
  [2018, spell(2018, "Кузнечное дело", { tradeSkill: false, effects: [47, 118, 0], effectMiscValue: [0, 164, 0] })],
  [2663, spell(2663, "Медные наручи", { effectItemType: [2853, 0, 0], reagents: [{ itemId: 2840, count: 2 }] })],
  [2660, spell(2660, "Грубое точило", { effectItemType: [2862, 0, 0], reagents: [{ itemId: 2835, count: 1 }] })],
  // A custom blacksmith's enchant, to prove the targeting hooks over the live inventory.
  [9964, spell(9964, "Наручи - шипы", {
    effects: [53, 0, 0], reagents: [{ itemId: 2840, count: 1 }], description: "Шипы на $s1 ед.",
    effectBasePoints: [4, 0, 0], equippedItemClass: 4, equippedItemSubclass: 8, equippedItemInvTypes: 512,
  })],
]);
const ABILITIES = new Map([
  [2663, { skillLine: 164, trivialSkillLineRankLow: 20, trivialSkillLineRankHigh: 60 }],
  [2660, { skillLine: 164, trivialSkillLineRankLow: 15, trivialSkillLineRankHigh: 55 }],
  [9964, { skillLine: 164, trivialSkillLineRankLow: 100, trivialSkillLineRankHigh: 140 }],
]);
const TEMPLATES = new Map([
  [2853, { found: true, entry: 2853, name: "Медные наручи", itemClass: 4, subClass: 3, inventoryType: 9, requiredLevel: 2, quality: 1 }],
  [2862, { found: true, entry: 2862, name: "Грубое точило", itemClass: 0, subClass: 8, inventoryType: 0, requiredLevel: 1, quality: 1 }],
  [2840, { found: true, entry: 2840, name: "Медный слиток", itemClass: 7, subClass: 7, inventoryType: 0, quality: 1 }],
]);

function fixture({ host = true } = {}) {
  const player = { guid: 1n, fields: new Map() };
  const skills = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;
  player.fields.set(skills, 164);
  player.fields.set(skills + 1, 110 | (150 << 16));
  player.fields.set(skills + 2, 5);
  const bars = { guid: 2n, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 2840],
    [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 9]]) };
  const worn = { guid: 3n, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 2853]]) };
  const spare = { guid: 4n, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 2853]]) };
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, bars.guid);
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 2, spare.guid);
  // Stock inventory slot 9 (INVSLOT_WRIST) is the ninth equipment field.
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 8 * 2, worn.guid);
  const sent = [];
  const world = {
    events: new EventBus(),
    state: { selfGuid: 1n, objects: new Map([[1n, player], [bars.guid, bars], [worn.guid, worn], [spare.guid, spare]]) },
    knownSpells: [{ id: 2018 }, { id: 2663 }, { id: 2660 }, { id: 9964 }],
    names: new Map(), itemTemplates: TEMPLATES,
    casts: new Map(), channels: new Map(), actionButtons: [], creatureTemplates: new Map(), questTemplates: new Map(),
    cooldownRemaining: (id) => id === 2660 ? 90_500 : 0,
    itemTemplate: (entry) => TEMPLATES.get(entry),
    useItem: (...args) => sent.push(["use", ...args]),
    ownTradeOffer: () => ({ money: 0, spellId: 0, items: [] }),
  };
  const crafted = [];
  const tradeSkill = {
    professionData: () => ({
      skillLine: (id) => id === 164 ? { id, name: "Кузнечное дело", categoryId: 11, iconId: 0 } : undefined,
      skillOfSpell: (id) => ABILITIES.get(id)?.skillLine ?? (id === 2018 ? 164 : undefined),
      spellAbilitiesOf: (id) => ABILITIES.has(id) ? [ABILITIES.get(id)] : undefined,
    }),
    subclassName: (itemClass, subClass) => ({ "4:3": "Кольчуга", "0:8": "Другое" })[`${itemClass}:${subClass}`],
    craft: {
      craft: (spellId, count) => { crafted.push(["craft", spellId, count]); return true; },
      castOnItem: (spellId, guid) => { crafted.push(["item", spellId, guid]); return true; },
      stop: () => crafted.push(["stop"]),
      remaining: () => 0,
    },
    spells: () => SPELLS,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => SPELLS.get(id),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    itemInfo: (entry) => {
      const template = TEMPLATES.get(entry);
      return template ? { name: template.name, texture: `icon-${entry}`, quality: template.quality } : undefined;
    },
    ...(host ? { tradeSkill } : {}),
  });
  const fired = [];
  let now = 0;
  seam.tradeSkill.attach({ fire: (event) => { fired.push(event); return 1; }, now: () => now });
  const tick = () => { now += 1; seam.tradeSkill.tick(); };
  return { world, seam, sent, crafted, fired, tick, player, bars };
}

test("the live line, recipes, headings and reagent counts come from the world and the host", () => {
  const { seam, crafted } = fixture();
  assert.equal(seam.tradeSkill.canOpen(164), true);
  assert.equal(seam.tradeSkill.open(164), true);
  assert.equal(seam.tradeSkill.show(), true);
  assert.deepEqual(call("GetTradeSkillLine", seam), ["Кузнечное дело", 110, 150, 5],
    "value, max and the skill bonus word of PLAYER_SKILL_INFO");
  const [count] = call("GetNumTradeSkills", seam);
  assert.deepEqual(Array.from({ length: count }, (_, index) => call("GetTradeSkillInfo", seam, index + 1)), [
    ["Наручи - шипы", "medium", 9, false, "__fxEnscribe"],
    ["Другое", "header", 0, true],
    ["Грубое точило", "trivial", 0, false, undefined],
    ["Кольчуга", "header", 0, true],
    ["Медные наручи", "trivial", 4, false, undefined],
  ]);
  assert.deepEqual(call("GetTradeSkillReagentInfo", seam, 5, 1), ["Медный слиток", "icon-2840", 2, 9]);
  assert.deepEqual(call("GetTradeSkillCooldown", seam, 3), [91], "whole seconds, rounded up");
  assert.deepEqual(call("GetTradeSkillDescription", seam, 1), ["Шипы на 5 ед."], "the description's markers are filled in");
  call("DoTradeSkill", seam, 5, 4);
  assert.deepEqual(crafted, [["craft", 2663, 4]]);
});

test("an enchant takes the next bag or paper-doll click as its target; without one the click is a use", () => {
  const { seam, sent, crafted } = fixture();
  seam.tradeSkill.open(164);
  seam.tradeSkill.show();
  call("UseContainerItem", seam, 0, 1);
  assert.deepEqual(sent.map(([kind]) => kind), ["use"], "no enchant waiting: an ordinary use");
  call("DoTradeSkill", seam, 1, 1);
  assert.deepEqual(call("SpellCanTargetItem", seam), [true]);
  call("UseContainerItem", seam, 0, 1);
  assert.equal(sent.length, 1, "the copper bars are the cursor's click, not a use");
  assert.deepEqual(crafted, [], "and not bracers: nothing is cast");
  call("PickupInventoryItem", seam, 9);
  assert.deepEqual(crafted, [["item", 9964, 3n]], "the worn bracers take the enchant");
  assert.deepEqual(call("SpellCanTargetItem", seam), [false]);
  call("DoTradeSkill", seam, 1, 1);
  call("UseContainerItem", seam, 0, 2);
  assert.deepEqual(crafted.at(-1), ["item", 9964, 4n], "the spare pair in the bag, through the stock bag click");
});

test("carried reagents and a new world reach the stock window; without the host every line stays closed", () => {
  const { seam, world, fired, tick, bars } = fixture();
  seam.tradeSkill.open(164);
  seam.tradeSkill.show();
  bars.fields.set(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 3);
  tick();
  assert.deepEqual(fired, ["TRADE_SKILL_SHOW", "TRADE_SKILL_UPDATE"]);
  assert.deepEqual(call("GetTradeSkillInfo", seam, 5), ["Медные наручи", "trivial", 1, false, undefined]);
  world.knownSpells = world.knownSpells.filter(({ id }) => id !== 2663);
  tick();
  assert.equal(fired.at(-1), "TRADE_SKILL_UPDATE", "a forgotten recipe leaves the list");
  assert.deepEqual(call("GetNumTradeSkills", seam), [3]);

  const bare = fixture({ host: false });
  assert.equal(bare.seam.tradeSkill.canOpen(164), false, "no /dbc/talents host: no profession to open");
  assert.deepEqual(call("GetTradeSkillLine", bare.seam), ["UNKNOWN", 0, 0, 0]);
});

test("the opener is the checked spell and the current action while its stock window shows", () => {
  const { seam, world, fired } = fixture();
  // Stock SpellButton_OnEvent and ActionButton_OnEvent repaint on TRADE_SKILL_SHOW/CLOSE through
  // IsSelectedSpell and IsCurrentAction (SpellBookFrame.lua:301-302, ActionButton.lua:398).
  world.actionButtons = [{ slot: 0, action: 2018, type: 0 }, { slot: 1, action: 2663, type: 0 }];
  world.isActiveMountSpell = () => false;
  const count = 8;
  const book = Array.from({ length: count }, (_, index) => call("GetSpellName", seam, index + 1, "spell")[0]);
  const opener = book.indexOf("Кузнечное дело") + 1;
  assert.ok(opener > 0, `the opener is in the book: ${JSON.stringify(book)}`);
  const selected = () => book.flatMap((name, index) => name && call("IsSelectedSpell", seam, index + 1, "spell")[0] ? [name] : []);
  assert.deepEqual(selected(), []);
  assert.deepEqual(call("IsCurrentAction", seam, 1), [undefined]);
  seam.tradeSkill.open(164);
  seam.tradeSkill.show();
  assert.equal(fired.at(-1), "TRADE_SKILL_SHOW");
  assert.deepEqual(selected(), ["Кузнечное дело"]);
  assert.deepEqual(call("IsCurrentAction", seam, 1), [1]);
  assert.deepEqual(call("IsCurrentAction", seam, 2), [undefined], "a recipe on the bar is not the opener");
  call("CloseTradeSkill", seam);
  assert.equal(fired.at(-1), "TRADE_SKILL_CLOSE");
  assert.deepEqual(selected(), []);
  assert.deepEqual(call("IsCurrentAction", seam, 1), [undefined]);
});

test("the ItemSubClass words are read once, on demand, and a failed read is retried after a wait", async () => {
  let now = 0;
  const requests = [];
  let answer = { ok: false, status: 404, json: async () => [] };
  const names = createFrameXmlSubclassNames(() => "http://gateway", async (url) => { requests.push(url); return answer; }, () => now);
  assert.equal(names(0, 8), undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests, ["http://gateway/dbc/item-subclasses?v=1"]);
  assert.equal(names(0, 8), undefined, "within the wait no second request");
  assert.equal(requests.length, 1);
  now = 2_000;
  answer = { ok: true, status: 200, json: async () => [
    { itemClass: 0, subClass: 8, name: "Другое", verboseName: "", displayFlags: 1 },
    { itemClass: 4, subClass: 3, name: "Кольчуга", verboseName: "Кольчужные", displayFlags: 0 },
    { itemClass: "bad" },
  ] };
  assert.equal(names(0, 8), undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.length, 2);
  assert.equal(names(0, 8), "Другое", "the word the tooltip leaves off (DisplayFlags bit 0) is a heading here");
  assert.equal(names(4, 3), "Кольчуга");
  assert.equal(names(9, 9), undefined);
  assert.equal(requests.length, 2, "read once");
  const offline = createFrameXmlSubclassNames(() => undefined, async () => { throw new Error("no"); });
  assert.equal(offline(0, 8), undefined, "no gateway origin: nothing is asked");
});
