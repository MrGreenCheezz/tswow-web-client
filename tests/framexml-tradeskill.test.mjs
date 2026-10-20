import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 2 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-tradeskill-live-seam.test.mjs
{
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
}

// ── framexml-tradeskill-seam.test.mjs
{
// The stock trade skill C API (FrameXmlTradeSkill.ts) over the canned Blacksmithing and Enchanting
// (FrameXmlTradeSkillCanned.ts): the rows Blizzard_TradeSkillUI draws, its filters and headings, its
// commands into the native craft queue, and the TRADE_SKILL_* edges it is told about.

const { createCannedFrameXmlTradeSkill, FRAMEXML_CANNED_BLACKSMITHING, FRAMEXML_CANNED_ENCHANTING,
  FRAMEXML_CANNED_BRACERS_GUID, FRAMEXML_CANNED_BOOTS_GUID } = await import(
  "../dist/code/browser/framexml/FrameXmlTradeSkillCanned.js",
);
const { FRAMEXML_TRADESKILL_BINDINGS, FRAMEXML_TRADESKILL_ENSCRIBE, FRAMEXML_TRADESKILL_PRELUDE } = await import(
  "../dist/code/browser/framexml/FrameXmlTradeSkill.js",
);
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_PRELUDE } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js",
);
const { globalString } = await import("../dist/code/generated/globalStrings.js");

function fixture({ open = FRAMEXML_CANNED_BLACKSMITHING, show = true } = {}) {
  const { model, world } = createCannedFrameXmlTradeSkill();
  const events = [];
  let now = 100;
  const pump = {
    fire: (event, ...args) => { events.push([event, ...args]); return 1; },
    now: () => now,
    advance(seconds) { now += seconds; },
  };
  model.attach(pump);
  const host = { tradeSkill: model };
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](host, args);
  if (open !== null) {
    assert.equal(model.open(open), true);
    if (show) assert.equal(model.show(), true);
  }
  const names = () => events.map(([event]) => event);
  const tick = (seconds = 0.25) => { pump.advance(seconds); model.tick(); };
  return { model, world, events, names, pump, call, tick };
}

function rows(call) {
  const [count] = call("GetNumTradeSkills");
  return Array.from({ length: count }, (_, index) => call("GetTradeSkillInfo", index + 1));
}

test("while no trade skill is open the API answers the client's closed state", () => {
  const { call, model } = fixture({ open: null });
  assert.deepEqual(call("GetTradeSkillLine"), ["UNKNOWN", 0, 0, 0]);
  assert.deepEqual(call("GetNumTradeSkills"), [0]);
  assert.deepEqual(call("GetFirstTradeSkill"), [0]);
  assert.deepEqual(call("GetTradeSkillSelectionIndex"), [0]);
  assert.deepEqual(call("GetTradeskillRepeatCount"), [1]);
  assert.deepEqual(call("GetTradeSkillNumMade", 1), [0, 0], "SetSelection compares maxMade > 1");
  assert.deepEqual(call("GetTradeSkillNumReagents", 1), [0]);
  assert.deepEqual(call("GetTradeSkillInfo", 1), []);
  assert.deepEqual(call("IsTradeSkillLinked"), [false]);
  assert.deepEqual(call("GetTradeSkillListLink"), []);
  assert.deepEqual(call("SpellCanTargetItem"), [false]);
  assert.equal(model.canOpen(186), false, "Mining is not one of the canned character's lines");
  assert.equal(model.open(186), false);
  // A seam without the model answers the same numbers (a host that never built one).
  const bare = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name]({}, args);
  assert.deepEqual(bare("GetTradeSkillLine"), ["UNKNOWN", 0, 0, 0]);
  assert.deepEqual(bare("GetNumTradeSkills"), [0]);
  assert.deepEqual(bare("GetTradeskillRepeatCount"), [1]);
});

test("Blacksmithing lists its made items' subclasses as headings, hardest recipes first", () => {
  const { call, names } = fixture();
  assert.deepEqual(names(), ["TRADE_SKILL_SHOW"]);
  assert.deepEqual(call("GetTradeSkillLine"), ["Кузнечное дело", 110, 150, 0]);
  assert.deepEqual(rows(call), [
    ["Дробящее", "header", 0, true],
    ["Тяжелая медная кувалда", "medium", 1, false, undefined],
    ["Медная палица", "trivial", 2, false, undefined],
    ["Другое", "header", 0, true],
    ["Зернистое грузило", "trivial", 0, false, undefined],
    ["Зернистое точило", "trivial", 1, false, undefined],
    ["Грубое грузило", "trivial", 6, false, undefined],
    ["Грубое точило", "trivial", 9, false, undefined],
    ["Кольчуга", "header", 0, true],
    ["Рунические медные наручи", "optimal", 0, false, undefined],
    ["Медные плетеные штаны", "trivial", 3, false, undefined],
    ["Медные наручи", "trivial", 7, false, undefined],
    ["Металл и камень", "header", 0, true],
    ["Зернистый шлифовальный камень", "trivial", 0, false, undefined],
    ["Грубый шлифовальный камень", "trivial", 4, false, undefined],
    ["Меч", "header", 0, true],
    ["Медный клеймор", "trivial", 0, false, undefined],
    ["Медный короткий меч", "trivial", 2, false, undefined],
    ["Топор", "header", 0, true],
    ["Медный боевой топор", "easy", 0, false, undefined],
    ["Медный топор", "trivial", 2, false, undefined],
  ]);
  assert.deepEqual(call("GetFirstTradeSkill"), [2]);
  assert.deepEqual(call("GetTradeSkillSubClasses"), ["Дробящее", "Другое", "Кольчуга", "Металл и камень", "Меч", "Топор"]);
  assert.deepEqual(call("GetTradeSkillInvSlots"),
    ["INVTYPE_LEGS", "INVTYPE_WRIST", "INVTYPE_2HWEAPON", "INVTYPE_WEAPONMAINHAND"]);
});

test("the selection follows its recipe through collapsed headings, and GetTradeSkill* describe it", () => {
  const { call, tick, names, events } = fixture();
  call("SelectTradeSkill", 11);
  assert.deepEqual(call("GetTradeSkillSelectionIndex"), [11]);
  call("SelectTradeSkill", 9);
  assert.deepEqual(call("GetTradeSkillSelectionIndex"), [11], "a heading is not a selection");
  events.length = 0;
  call("CollapseTradeSkillSubClass", 1);
  assert.deepEqual(call("GetTradeSkillInfo", 1), ["Дробящее", "header", 0, false]);
  assert.deepEqual(call("GetNumTradeSkills"), [19]);
  assert.deepEqual(call("GetTradeSkillSelectionIndex"), [9], "the trousers moved up two rows");
  assert.deepEqual(names(), [], "the update is deferred off the Lua call's stack");
  tick(0);
  assert.deepEqual(names(), ["TRADE_SKILL_UPDATE"]);
  call("ExpandTradeSkillSubClass", 1);
  assert.deepEqual(call("GetTradeSkillSelectionIndex"), [11]);
  call("CollapseTradeSkillSubClass", 0);
  assert.deepEqual(rows(call).map(([name]) => name),
    ["Дробящее", "Другое", "Кольчуга", "Металл и камень", "Меч", "Топор"]);
  assert.deepEqual(call("GetTradeSkillSelectionIndex"), [0], "a hidden selection reads as none");
  assert.deepEqual(call("GetFirstTradeSkill"), [0]);
  call("ExpandTradeSkillSubClass", 0);
  assert.deepEqual(call("GetNumTradeSkills"), [21]);

  // Row 2, «Тяжелая медная кувалда» (7408): three reagents, one item made, the item's own icon.
  assert.deepEqual(call("GetTradeSkillIcon", 2), ["Interface\\Icons\\INV_Hammer_18"]);
  assert.deepEqual(call("GetTradeSkillNumMade", 2), [1, 1]);
  assert.deepEqual(call("GetTradeSkillNumReagents", 2), [3]);
  assert.deepEqual(call("GetTradeSkillReagentInfo", 2, 1), ["Медный слиток", "Interface\\Icons\\INV_Ingot_02", 12, 14]);
  assert.deepEqual(call("GetTradeSkillReagentInfo", 2, 3), ["Тонкая кожа", "Interface\\Icons\\INV_Misc_LeatherScrap_03", 2, 2]);
  assert.deepEqual(call("GetTradeSkillReagentInfo", 2, 4), []);
  assert.deepEqual(call("GetTradeSkillReagentItemLink", 2, 1), ["|cffffffff|Hitem:2840:0:0:0:0:0:0:0:0|h[Медный слиток]|h|r"]);
  assert.deepEqual(call("GetTradeSkillItemLink", 2), ["|cff1eff00|Hitem:6214:0:0:0:0:0:0:0:0|h[Тяжелая медная кувалда]|h|r"]);
  assert.deepEqual(call("GetTradeSkillRecipeLink", 2), ["|cffffd000|Henchant:7408|h[Кузнечное дело: Тяжелая медная кувалда]|h|r"]);
  assert.deepEqual(call("GetTradeSkillTools", 2), [], "this dataset's Spell.dbc names no Totem/TotemCategory here");
  assert.deepEqual(call("GetTradeSkillCooldown", 2), []);
  assert.deepEqual(call("GetTradeSkillDescription", 2), []);
  assert.deepEqual(call("GetTradeSkillIcon", 1), [], "a heading has no icon");
  assert.deepEqual(call("GetTradeSkillItemLink", 1), []);
});

test("the four filters narrow the rows and each raises TRADE_SKILL_FILTER_UPDATE only when it changes", () => {
  const { call, tick, names, events } = fixture();
  events.length = 0;
  call("SetTradeSkillSubClassFilter", 0, 1, 1);
  call("SetTradeSkillInvSlotFilter", 0, 1, 1);
  call("SetTradeSkillItemNameFilter", "");
  call("TradeSkillOnlyShowMakeable", undefined);
  tick(0);
  assert.deepEqual(names(), [], "the stock OnLoad/OnShow calls that change nothing raise nothing");
  assert.deepEqual(call("GetTradeSkillSubClassFilter", 0), [true]);

  // TradeSkillSubClassDropDownButton_OnClick: SetTradeSkillSubClassFilter(id - 1, 1, 1).
  call("SetTradeSkillSubClassFilter", 6, 1, 1);
  assert.deepEqual(call("GetTradeSkillSubClassFilter", 0), [false]);
  assert.deepEqual(call("GetTradeSkillSubClassFilter", 6), [true]);
  assert.deepEqual(rows(call).map(([name]) => name), ["Топор", "Медный боевой топор", "Медный топор"]);
  assert.deepEqual(call("GetTradeSkillSubClasses").length, 6, "the dropdown still lists every subclass");
  tick(0);
  assert.deepEqual(names(), ["TRADE_SKILL_FILTER_UPDATE"]);
  call("SetTradeSkillSubClassFilter", 0, 1, 1);

  call("SetTradeSkillInvSlotFilter", 2, 1, 1);
  assert.deepEqual(rows(call).map(([name]) => name), ["Кольчуга", "Рунические медные наручи", "Медные наручи"],
    "INVTYPE_WRIST keeps the two bracers");
  call("SetTradeSkillInvSlotFilter", 0, 1, 1);

  call("SetTradeSkillItemNameFilter", "ТОЧИЛО");
  assert.deepEqual(rows(call).map(([name]) => name), ["Другое", "Зернистое точило", "Грубое точило"]);
  // TradeSkillFilter_OnTextChanged's level search: nil name, then the level range.
  call("SetTradeSkillItemNameFilter", undefined);
  call("SetTradeSkillItemLevelFilter", 4, 5);
  assert.deepEqual(rows(call).map(([name]) => name), [
    "Дробящее", "Медная палица", "Другое", "Зернистое грузило", "Зернистое точило",
    "Кольчуга", "Медные плетеные штаны", "Меч", "Медный короткий меч", "Топор", "Медный топор",
  ]);
  call("SetTradeSkillItemLevelFilter", 0, 0);

  call("TradeSkillOnlyShowMakeable", 1);
  assert.deepEqual(rows(call).filter(([, type]) => type !== "header").map(([name, , available]) => [name, available]), [
    ["Тяжелая медная кувалда", 1], ["Медная палица", 2], ["Зернистое точило", 1], ["Грубое грузило", 6],
    ["Грубое точило", 9], ["Медные плетеные штаны", 3], ["Медные наручи", 7], ["Грубый шлифовальный камень", 4],
    ["Медный короткий меч", 2], ["Медный топор", 2],
  ]);
  call("TradeSkillOnlyShowMakeable", 1);
  events.length = 0;
  tick(0);
  assert.deepEqual(names(), ["TRADE_SKILL_FILTER_UPDATE"], "repeated changes in one frame raise one edge");
});

test("DoTradeSkill queues through the native craft path; the queue drives the repeat count and RECAST", () => {
  const { call, world, tick, names, events } = fixture();
  call("DoTradeSkill", 7, 5);
  assert.deepEqual(world.calls, [{ kind: "craft", spellId: 3115, count: 5 }]);
  assert.deepEqual(call("GetTradeskillRepeatCount"), [5]);
  events.length = 0;
  tick(0);
  assert.deepEqual(names(), ["UPDATE_TRADESKILL_RECAST"]);
  world.finishCast();
  world.bags.set(2835, 8);
  world.bags.set(2589, 5);
  events.length = 0;
  tick();
  assert.deepEqual(names(), ["UPDATE_TRADESKILL_RECAST", "TRADE_SKILL_UPDATE"],
    "the count went down and the bags changed");
  assert.deepEqual(call("GetTradeskillRepeatCount"), [4]);
  assert.deepEqual(call("GetTradeSkillInfo", 7), ["Грубое грузило", "trivial", 5, false, undefined]);

  // «Создать все» passes numAvailable; a count past the three-digit box is clamped, a bad one is one.
  call("DoTradeSkill", 8, 5000);
  call("DoTradeSkill", 8, "x");
  call("DoTradeSkill", 1, 3);
  assert.deepEqual(world.calls.slice(1), [
    { kind: "craft", spellId: 2660, count: 999 }, { kind: "craft", spellId: 2660, count: 1 },
  ], "a heading crafts nothing");

  call("StopTradeSkillRepeat");
  assert.deepEqual(world.calls.at(-1), { kind: "stop" });
  assert.deepEqual(call("GetTradeskillRepeatCount"), [1]);

  events.length = 0;
  const before = world.calls.length;
  call("CloseTradeSkill");
  assert.deepEqual(names(), ["TRADE_SKILL_CLOSE"], "synchronous: UIParent hides the window at once");
  assert.deepEqual(world.calls.slice(before), [{ kind: "stop" }], "closing the window ends the queue");
  assert.deepEqual(call("GetTradeSkillLine"), ["UNKNOWN", 0, 0, 0]);
  call("CloseTradeSkill");
  assert.deepEqual(names(), ["TRADE_SKILL_CLOSE"], "a second close is inert");
});

test("an enchant waits for the item it goes on: the wrong one is refused, the right one is cast on", () => {
  const { call, world, model, events } = fixture({ open: FRAMEXML_CANNED_ENCHANTING });
  assert.deepEqual(call("GetTradeSkillLine"), ["Наложение чар", 95, 150, 0]);
  assert.deepEqual(rows(call), [
    ["Чары для наручей - отражение I", "medium", 1, false, FRAMEXML_TRADESKILL_ENSCRIBE],
    ["Чары для нагрудника - здоровье I", "easy", 4, false, FRAMEXML_TRADESKILL_ENSCRIBE],
    ["Чары для наручей - здоровье I", "easy", 4, false, FRAMEXML_TRADESKILL_ENSCRIBE],
    ["Жезл", "header", 0, true],
    ["Малый магический жезл", "easy", 1, false, undefined],
    ["Наложение чар", "header", 0, true],
    ["Рунический медный жезл", "trivial", 0, false, undefined],
  ]);
  assert.deepEqual(call("GetTradeSkillInvSlots"), ["INVTYPE_CHEST", "INVTYPE_WRIST", "INVTYPE_RANGEDRIGHT"],
    "a robe is a chest piece; the made wand's slot joins the enchants'");
  assert.deepEqual(call("GetTradeSkillItemLink", 3), ["|cffffd000|Henchant:7418|h[Чары для наручей - здоровье I]|h|r"]);
  assert.deepEqual(call("GetTradeSkillNumMade", 3), [1, 1]);
  assert.deepEqual(call("GetTradeSkillIcon", 3), ["Interface\\Icons\\Spell_Holy_GreaterHeal"]);
  assert.deepEqual(call("GetTradeSkillDescription", 3),
    ["Обучение наложению на наручи чар, повышающих максимальный запас здоровья на 5 ед."]);

  call("DoTradeSkill", 3, 1);
  assert.deepEqual(world.calls, [], "nothing is sent before the item is chosen");
  assert.deepEqual(call("SpellCanTargetItem"), [true]);
  events.length = 0;
  assert.equal(model.targetItem(FRAMEXML_CANNED_BOOTS_GUID), true, "the click is the cursor's");
  assert.deepEqual(world.calls, [], "boots are not bracers: refused without a packet");
  // The build's own SPELL_FAILED_BAD_TARGETS («Нельзя применить к этой цели.» on this ruRU client).
  const refusal = globalString("SPELL_FAILED_BAD_TARGETS");
  assert.deepEqual(events, refusal ? [["UI_ERROR_MESSAGE", refusal]] : [], "and says so in the error frame");
  assert.deepEqual(call("SpellCanTargetItem"), [true], "the cursor stays");
  assert.equal(model.targetItem(FRAMEXML_CANNED_BRACERS_GUID), true);
  assert.deepEqual(world.calls, [{ kind: "item", spellId: 7418, guid: FRAMEXML_CANNED_BRACERS_GUID }]);
  assert.deepEqual(call("SpellCanTargetItem"), [false]);
  assert.equal(model.targetItem(FRAMEXML_CANNED_BRACERS_GUID), false, "without a waiting enchant a click is a click");

  call("DoTradeSkill", 3, 1);
  assert.equal(model.cancelTargeting(), true);
  assert.equal(model.cancelTargeting(), false);
  call("DoTradeSkill", 5, 2);
  assert.deepEqual(world.calls.at(-1), { kind: "craft", spellId: 14293, count: 2 }, "the wand is made, not targeted");
});

test("item replies reshape the rows at the next update, and a new world closes the window", async () => {
  const { model, world } = createCannedFrameXmlTradeSkill();
  world.unanswered.add(2853);
  world.unanswered.add(2840);
  const events = [];
  let now = 10;
  model.attach({ fire: (event) => { events.push(event); return 1; }, now: () => now });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name]({ tradeSkill: model }, args);
  model.open(FRAMEXML_CANNED_BLACKSMITHING);
  model.show();
  const bracers = () => rows(call).findIndex(([name]) => name === "Медные наручи") + 1;
  assert.deepEqual(rows(call).slice(0, 1), [["Медные наручи", "trivial", 7, false, undefined]],
    "a recipe whose item has no reply yet has no heading and runs first");
  assert.deepEqual(call("GetTradeSkillReagentInfo", bracers(), 1), [undefined, undefined, 2, 14],
    "the reagent's name waits for its reply; the count does not");
  await Promise.resolve();
  assert.equal(world.unanswered.size, 0, "the model asked for both entries");
  assert.equal(rows(call)[0][0], "Медные наручи", "the rows hold still until the update");
  now += 0.3;
  model.tick();
  assert.deepEqual(events, ["TRADE_SKILL_SHOW", "TRADE_SKILL_UPDATE"]);
  assert.equal(bracers(), 12);
  assert.deepEqual(call("GetTradeSkillReagentInfo", 12, 1), ["Медный слиток", "Interface\\Icons\\INV_Ingot_02", 2, 14]);
  world.replaceWorld();
  model.tick();
  assert.deepEqual(events.at(-1), "TRADE_SKILL_CLOSE");
  assert.deepEqual(call("GetTradeSkillLine"), ["UNKNOWN", 0, 0, 0]);
});

test("a muted probe sends nothing and raises nothing; unlearning the line closes it", () => {
  const { model, call, world, names, events, tick } = fixture();
  events.length = 0;
  model.muted(() => {
    call("DoTradeSkill", 8, 2);
    call("StopTradeSkillRepeat");
    call("SetTradeSkillSubClassFilter", 2, 1, 1);
    call("CloseTradeSkill");
  });
  tick(0);
  assert.deepEqual(world.calls, []);
  assert.deepEqual(names(), []);
  assert.deepEqual(call("GetTradeSkillLine")[0], "Кузнечное дело", "the probe's CloseTradeSkill is inert");
  world.lines.delete(FRAMEXML_CANNED_BLACKSMITHING);
  tick();
  assert.deepEqual(names(), ["TRADE_SKILL_CLOSE"]);
});

test("the bindings are the seam's, and the prelude resolves ENSCRIBE and the slot names in Lua", () => {
  // The spell cursor is shared with the glyph tab (FrameXmlGlyph.ts): its two names answer the glyph
  // cursor first and otherwise are exactly these; SpellCanTargetItem answers the item-target cursor
  // (2.05, FrameXmlItemTargeting.ts) first the same way.
  const composed = new Set(["SpellIsTargeting", "SpellStopTargeting", "SpellCanTargetItem"]);
  for (const name of Object.keys(FRAMEXML_TRADESKILL_BINDINGS)) {
    if (composed.has(name)) {
      assert.deepEqual([...FRAMEXML_SEAM_BINDINGS[name]({}, [])], [...FRAMEXML_TRADESKILL_BINDINGS[name]({}, [])],
        `${name} delegates to the trade skill's without a glyph cursor`);
      continue;
    }
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_TRADESKILL_BINDINGS[name], `${name} is not shadowed`);
  }
  // 34 trade skill names, plus SpellIsTargeting/SpellStopTargeting for the enchant cursor.
  assert.equal(Object.keys(FRAMEXML_TRADESKILL_BINDINGS).length, 36);
  assert.ok(FRAMEXML_SEAM_PRELUDE.includes(FRAMEXML_TRADESKILL_PRELUDE));
  assert.match(FRAMEXML_TRADESKILL_PRELUDE, new RegExp(`verb == "${FRAMEXML_TRADESKILL_ENSCRIBE}" then verb = rawget\\(_G, "ENSCRIBE"\\)`));
  assert.match(FRAMEXML_TRADESKILL_PRELUDE, /names\[index\] = rawget\(_G, names\[index\]\) or names\[index\]/);
});

test("tools read as name/has pairs, and a cooldown shows in seconds and repaints when it starts", () => {
  const { call, world, tick, names, events } = fixture();
  // «Грубое точило» (row 8) given the pre-WotLK Blacksmith Hammer and the hammer TotemCategory (162):
  // this dataset's Spell.dbc carries neither (measured), so the fixture writes them in.
  const spell = world.recipes(FRAMEXML_CANNED_BLACKSMITHING).find(({ spell: row }) => row.id === 2660).spell;
  spell.tools = [5956];
  spell.requiredToolCategories = [162];
  spell.requiredToolNames = ["Кузнечный молот"];
  assert.deepEqual(call("GetTradeSkillTools", 8), ["Кузнечный молот", false, "Кузнечный молот", false]);
  world.bags.set(5956, 1);
  world.toolCategorySet.add(162);
  assert.deepEqual(call("GetTradeSkillTools", 8), ["Кузнечный молот", true, "Кузнечный молот", true]);
  events.length = 0;
  tick();
  assert.deepEqual(names(), ["TRADE_SKILL_UPDATE"], "carrying the tool repaints the requirement line");
  world.cooldowns.set(2660, 72000);
  assert.deepEqual(call("GetTradeSkillCooldown", 8), [72000]);
  events.length = 0;
  tick();
  assert.deepEqual(names(), ["TRADE_SKILL_UPDATE"], "a recipe going on cooldown repaints once");
  world.cooldowns.set(2660, 71999);
  events.length = 0;
  tick();
  assert.deepEqual(names(), [], "the seconds ticking down do not repaint every check");
});

test("each opening asks again for the item replies that have not come, and never inside a C-API read", () => {
  const { model, world } = createCannedFrameXmlTradeSkill();
  const asked = [];
  world.unanswered.add(2853);
  // A reply that never lands (a failed request): the canned prefetch is replaced by a recorder.
  world.prefetch = (entries) => { asked.push([...entries]); };
  model.attach({ fire: () => 1, now: () => 0 });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name]({ tradeSkill: model }, args);
  model.open(FRAMEXML_CANNED_BLACKSMITHING);
  assert.deepEqual(asked, [[2853]]);
  for (let index = 1; index <= 21; index += 1) call("GetTradeSkillInfo", index);
  call("GetTradeSkillReagentInfo", 1, 1);
  assert.equal(asked.length, 1, "reads never fetch");
  model.open(FRAMEXML_CANNED_BLACKSMITHING);
  assert.deepEqual(asked, [[2853], [2853]], "the next opening asks again");
});

test("StopTradeSkillRepeat with no line open leaves a queue the native window started alone", () => {
  const { call, world } = fixture({ open: null });
  // TradeSkillRankFrame's SKILL_LINES_CHANGED runs TradeSkillFrame_Update while the window is hidden,
  // which calls StopTradeSkillRepeat because the closed GetTradeSkillLine ("UNKNOWN") differs from
  // CURRENT_TRADESKILL: a skill-up from native crafting must not cut that queue.
  world.queued = 5;
  call("StopTradeSkillRepeat");
  assert.deepEqual(world.calls, []);
  assert.equal(world.remaining(), 5);
  const open = fixture();
  open.world.queued = 5;
  open.call("StopTradeSkillRepeat");
  assert.deepEqual(open.world.calls, [{ kind: "stop" }], "with the line open it stops, as before");
  assert.equal(open.world.remaining(), 1);
});

test("an enchant cursor survives a filter that hides its recipe, and an unlearned recipe drops it", () => {
  const { call, world, model } = fixture({ open: FRAMEXML_CANNED_ENCHANTING });
  const observed = [];
  const stop = model.observeTargeting((armed) => observed.push(armed));
  call("DoTradeSkill", 3, 1);
  assert.deepEqual(observed, [true], "the host is told the cast cursor is up");
  call("SetTradeSkillItemNameFilter", "жезл");
  assert.equal(rows(call).some(([name]) => name === "Чары для наручей - здоровье I"), false, "the filter hides the enchant");
  assert.deepEqual(call("SpellCanTargetItem"), [true], "a filter does not drop the client's spell cursor");
  assert.equal(model.targetItem(FRAMEXML_CANNED_BOOTS_GUID), true);
  assert.deepEqual(world.calls, [], "the boots are still refused");
  assert.equal(model.targetItem(FRAMEXML_CANNED_BRACERS_GUID), true);
  assert.deepEqual(world.calls, [{ kind: "item", spellId: 7418, guid: FRAMEXML_CANNED_BRACERS_GUID }],
    "and the bracers still take the hidden enchant");
  assert.deepEqual(observed, [true, false]);

  call("SetTradeSkillItemNameFilter", "");
  call("DoTradeSkill", 3, 1);
  const recipes = world.recipesBySkill.get(FRAMEXML_CANNED_ENCHANTING);
  const index = recipes.findIndex(({ spell }) => spell.id === 7418);
  const [forgotten] = recipes.splice(index, 1);
  try {
    assert.equal(model.targetItem(FRAMEXML_CANNED_BRACERS_GUID), false, "nothing left to cast: the click is a click");
    assert.deepEqual(call("SpellCanTargetItem"), [false]);
    assert.equal(world.calls.length, 1);
    assert.deepEqual(observed, [true, false, true, false]);
  } finally {
    recipes.splice(index, 0, forgotten);
    stop();
  }
  call("DoTradeSkill", 3, 1);
  assert.deepEqual(observed, [true, false, true, false], "a stopped observer hears nothing more");
});

test("SpellIsTargeting and SpellStopTargeting answer for the enchant cursor before the native reticle", async () => {
  const { registerFrameXmlNativeEscape } = await import("../dist/code/browser/framexml/FrameXmlGameMenuController.js");
  const { call, model } = fixture({ open: FRAMEXML_CANNED_ENCHANTING });
  let reticle = false;
  const steps = [];
  const release = registerFrameXmlNativeEscape({
    popups: () => false, stopCasting: () => false, windows: () => false, clearTarget: () => false,
    stopTargeting: () => { steps.push("reticle"); const had = reticle; reticle = false; return had; },
    isTargeting: () => reticle,
  });
  try {
    assert.deepEqual(call("SpellIsTargeting"), []);
    call("DoTradeSkill", 3, 1);
    reticle = true;
    assert.deepEqual(call("SpellIsTargeting"), [1]);
    // Stock ToggleGameMenu: `elseif ( SpellStopTargeting() ) then` — one press, one thing dismissed.
    assert.deepEqual(call("SpellStopTargeting"), [1]);
    assert.equal(model.targeting, undefined, "the enchant went first");
    assert.deepEqual(steps, [], "and the press ended there");
    assert.equal(model.showing, true, "the window stays for the next press");
    assert.deepEqual(call("SpellIsTargeting"), [1], "the reticle still is");
    assert.deepEqual(call("SpellStopTargeting"), [1]);
    assert.deepEqual(steps, ["reticle"]);
    assert.deepEqual(call("SpellStopTargeting"), [], "nothing left to stop");
    assert.deepEqual(call("SpellIsTargeting"), []);
  } finally {
    release();
  }
  // A seam without the model still reaches the native step (the game menu's own binding, before).
  const bare = (name) => FRAMEXML_SEAM_BINDINGS[name]({}, []);
  assert.deepEqual(bare("SpellStopTargeting"), []);
  assert.deepEqual(bare("SpellIsTargeting"), []);
});

test("a profession's opener reads as selected exactly while its line's window shows", () => {
  const { model, call } = fixture({ open: null });
  // Spell.dbc on this dataset: 2018 «Кузнечное дело» and 7411 «Наложение чар» are
  // SPELL_EFFECT_TRADE_SKILL (47) with SPELL_EFFECT_SKILL (118) naming 164 and 333.
  const [row] = createCannedFrameXmlTradeSkill().world.recipes(FRAMEXML_CANNED_BLACKSMITHING);
  const opener = (id, name, skill) => ({
    ...row.spell, id, name, tradeSkill: false, effects: [47, 118, 0], effectItemType: [0, 0, 0], effectMiscValue: [0, skill, 0],
  });
  const blacksmithing = opener(2018, "Кузнечное дело", FRAMEXML_CANNED_BLACKSMITHING);
  const enchanting = opener(7411, "Наложение чар", FRAMEXML_CANNED_ENCHANTING);
  assert.equal(model.openerShowing(blacksmithing), false, "nothing open");
  model.open(FRAMEXML_CANNED_BLACKSMITHING);
  assert.equal(model.openerShowing(blacksmithing), false, "open but not yet shown (the add-on is loading)");
  model.show();
  assert.equal(model.openerShowing(blacksmithing), true);
  assert.equal(model.openerShowing(enchanting), false, "another line's opener");
  assert.equal(model.openerShowing(row.spell), false, "a recipe is not an opener");
  call("CloseTradeSkill");
  assert.equal(model.openerShowing(blacksmithing), false, "TRADE_SKILL_CLOSE clears it");
});

test("GetTradeSkillNumMade answers a stack's range, and a recipe without reagents is always makeable", () => {
  const { model, world, call } = fixture({ open: null });
  const [base] = world.recipes(FRAMEXML_CANNED_BLACKSMITHING);
  // Spell.dbc 3931 «Низкосортный динамит» (Engineering 202, band 90-105): SPELL_EFFECT_CREATE_ITEM of
  // 4365 with EffectBasePoints 0 and EffectDieSides 3 — one to three sticks; three 4364 and one linen.
  const dynamite = {
    ...base.spell, id: 3931, name: "Низкосортный динамит", effects: [24, 0, 0], effectItemType: [4365, 0, 0],
    effectBasePoints: [0, 0, 0], effectDieSides: [3, 0, 0], reagents: [{ itemId: 4364, count: 3 }, { itemId: 2589, count: 1 }],
  };
  // No profession recipe on this dataset lacks reagents (measured over Spell.dbc's SkillLineAbility
  // rows of the eleven profession lines: 0 of 20,948 that make or enchant an item); a custom module's
  // can, and craftableCount answers Infinity for it. This one is synthetic.
  const free = { ...dynamite, id: 3931_000, name: "Рецепт без реагентов", effectDieSides: [1, 0, 0], reagents: [] };
  world.lines.set(202, { skillId: 202, name: "Инженерное дело", value: 95, max: 150, modifier: 0 });
  const band = (low, high) => ({ ...base.ability, skillLine: 202, trivialSkillLineRankLow: low, trivialSkillLineRankHigh: high });
  world.recipesBySkill.set(202, [{ spell: dynamite, ability: band(90, 105) }, { spell: free, ability: band(1, 1) }]);
  assert.equal(model.open(202), true);
  model.show();
  assert.deepEqual(rows(call).map(([name]) => name), ["Низкосортный динамит", "Рецепт без реагентов"]);
  assert.deepEqual(call("GetTradeSkillNumMade", 1), [1, 3], "TradeSkillSkillIconCount reads «1-3»");
  assert.deepEqual(call("GetTradeSkillNumMade", 2), [1, 1]);
  call("TradeSkillOnlyShowMakeable", 1);
  assert.deepEqual(rows(call).map(([name]) => name), ["Рецепт без реагентов"],
    "no blasting powder in the bags hides the dynamite; nothing to lack keeps the other");
});

test("an enchant over an enchanted item asks REPLACE_ENCHANT; ReplaceEnchant casts it; slot 7 of a trade takes it", () => {
  const { call, world, model, events } = fixture({ open: FRAMEXML_CANNED_ENCHANTING });
  world.replaceNames.set(FRAMEXML_CANNED_BRACERS_GUID, ["Старые чары", "Новые чары"]);
  call("DoTradeSkill", 3, 1);
  events.length = 0;
  assert.equal(model.targetItem(FRAMEXML_CANNED_BRACERS_GUID), true);
  assert.deepEqual(world.calls, [], "nothing before the answer (Wow.exe 0x005210d0)");
  assert.deepEqual(events, [["REPLACE_ENCHANT", "Старые чары", "Новые чары"]]);
  assert.deepEqual(call("SpellCanTargetItem"), [true], "the enchant still waits");
  assert.equal(model.replaceEnchant(), true);
  assert.deepEqual(world.calls, [{ kind: "item", spellId: 7418, guid: FRAMEXML_CANNED_BRACERS_GUID }]);
  assert.equal(model.replaceEnchant(), false, "nothing waits any more");

  call("DoTradeSkill", 3, 1);
  world.tradeReplaceNames = ["Чары партнёра", "Новые чары"];
  events.length = 0;
  assert.equal(model.targetTradeSlot(), true);
  assert.deepEqual(events, [["TRADE_REPLACE_ENCHANT", "Чары партнёра", "Новые чары"]]);
  assert.equal(world.calls.length, 1, "asked first (0x005198a0)");
  assert.equal(model.targetTradeSlot(true), true, "ReplaceTradeEnchant");
  assert.deepEqual(world.calls.at(-1), { kind: "trade", spellId: 7418 });
  assert.equal(model.targetTradeSlot(), false, "the enchant went");
});
}
