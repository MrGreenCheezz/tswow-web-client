import assert from "node:assert/strict";
import test from "node:test";
import {
  craftableCount, filterCraftable, learnedProfessions, professionRecipes, professionSpellSkill,
  recipeAcceptsItem, sortCraftRecipes,
} from "../dist/code/browser/ui/ProfessionRules.js";
import { buildCastSpellOnItem, TARGET_FLAG_ITEM } from "../dist/code/world/SpellProtocol.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";

const skill = (skillId) => ({ skillId, value: 50, max: 75, temporaryBonus: 0, permanentBonus: 0, step: 1 });
const alchemy = { id: 2259, effects: [47, 118, 0], effectMiscValue: [0, 171, 0] };
const fishing = { id: 7620, effects: [50, 118, 6], effectMiscValue: [35591, 356, 0] };
const recipe = { id: 2330, effects: [24, 0, 0], effectMiscValue: [], tradeSkill: true, reagents: [{ itemId: 2447, count: 2 }, { itemId: 765, count: 1 }] };
const lines = { 2259: 171, 2330: 171, 2018: 164, 7620: 356, 999: 171 };
const data = {
  skillLine: (id) => ({ id, categoryId: [171, 164, 792].includes(id) ? 11 : 9 }),
  skillOfSpell: (id) => lines[id],
};

test("profession windows are owned skills, including secondary fishing and custom professions", () => {
  assert.deepEqual(learnedProfessions([skill(171), skill(356), skill(754), skill(792)], [alchemy, fishing], data)
    .map((entry) => entry.skillId), [171, 356, 792]);
  assert.equal(professionSpellSkill(alchemy, data), 171);
  // A custom TSWoW line outside the stock categories counts when it owns opener/recipe spells,
  // so its recipes do not leave the book for a window that never lists them.
  const customData = {
    skillLine: (id) => id === 900 ? { id, categoryId: 42 } : data.skillLine(id),
    skillOfSpell: (id) => id === 9001 ? 900 : data.skillOfSpell(id),
  };
  const customRecipe = { id: 9001, effects: [24, 0, 0], effectMiscValue: [] };
  assert.deepEqual(
    learnedProfessions([skill(900), skill(754)], [customRecipe], customData).map((entry) => entry.skillId),
    [900], "a custom line with recipes is a profession; a class line without any is not");
  assert.deepEqual(learnedProfessions([skill(900)], [], customData), [],
    "without spells even a custom line stays out");
});

test("recipe list is learned recipe intersection, never a profession starter or hidden service", () => {
  const known = [alchemy, recipe, { ...recipe, id: 999, hidden: true }, { ...recipe, id: 2018 }];
  assert.deepEqual(professionRecipes(171, known, data).map((spell) => spell.id), [2330]);
  assert.deepEqual(professionRecipes(164, [alchemy, recipe], data), []);
});
test("reagents count complete crafts, preserve loading state, and never include bank-only stock", () => {
  assert.equal(craftableCount(recipe, new Map([[2447, 7], [765, 9]])), 3);
  assert.equal(craftableCount(recipe, new Map([[2447, 7]])), 0);
  assert.equal(craftableCount({ ...recipe, reagents: undefined }, new Map()), undefined);
  assert.equal(craftableCount({ ...recipe, reagents: [] }, new Map()), Infinity);
});

test("craft sorting orders by name, level and difficulty with name as the stable tiebreak", () => {
  const rows = [
    { spell: { id: 2, name: "Б", spellLevel: 10 }, difficulty: "gray" },
    { spell: { id: 1, name: "А", spellLevel: 20 }, difficulty: "orange" },
    { spell: { id: 3, name: "В", spellLevel: 10 }, difficulty: "green" },
  ];
  assert.deepEqual(sortCraftRecipes(rows, "name").map((row) => row.spell.id), [1, 2, 3]);
  assert.deepEqual(sortCraftRecipes(rows, "level").map((row) => row.spell.id), [2, 3, 1]);
  assert.deepEqual(sortCraftRecipes(rows, "difficulty").map((row) => row.spell.id), [1, 3, 2],
    "hardest first, gray last");
  assert.deepEqual(
    sortCraftRecipes([{ spell: { id: 4, name: "Г", spellLevel: 1 }, difficulty: "" }], "difficulty")
      .map((row) => row.spell.id), [4]);
});

test("the craftable filter hides only what the bags cannot complete", () => {
  const costly = { spell: { id: 1, name: "А", reagents: [{ itemId: 10, count: 2 }] }, difficulty: "" };
  const free = { spell: { id: 2, name: "Б" }, difficulty: "" };
  const owned = new Map([[10, 3]]);
  assert.deepEqual(filterCraftable([costly, free], owned, false).map((row) => row.spell.id), [1, 2]);
  assert.deepEqual(filterCraftable([costly, free], owned, true).map((row) => row.spell.id), [1, 2]);
  assert.deepEqual(filterCraftable([costly, free], new Map(), true).map((row) => row.spell.id), [2],
    "a recipe without reagents is always attemptable");
});

test("the professions window lists owned professions with an opener each", async () => {
  const listeners = new Map();
  const node = (tag = "div") => ({
    tagName: tag.toUpperCase(), children: [], hidden: false, disabled: false, value: "", textContent: "",
    dataset: {}, id: "", className: "", title: "", style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, remove() {}, focus() {},
    addEventListener(type, run) { listeners.set(`${tag}:${type}`, run); },
    removeEventListener() {},
    click() { listeners.get(`${tag}:click`)?.({ preventDefault() {}, stopPropagation() {} }); },
    querySelector() { return node(); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  });
  globalThis.document = {
    createElement: node, body: node("body"), documentElement: node("html"),
    createTextNode: (text) => ({ textContent: text }),
    getElementById: () => node(), querySelectorAll: () => [],
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1440, innerHeight: 900,
    setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args) };
  globalThis.location = { origin: "http://localhost:5173", protocol: "http:", hostname: "localhost" };
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
  usePanelHost({ viewport: document.body, attach() {} });
  const { toggleProfessionList, professionListOpen, openProfession, showProfessions } = await import("../dist/code/browser/ui/Professions.js");
  const { characterSkillsPane } = await import("../dist/code/browser/ui/Dom.js");
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const base = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;
  const fields = new Map([[base, 171], [base + 1, 75 | (150 << 16)]]);
  game.world = { state: { selfGuid: 1n, objects: new Map([[1n, { guid: 1n, fields }]]) }, knownSpells: [],
    itemTemplates: new Map(), casts: new Map(), cooldownRemaining: () => 0,
    events: { on: () => () => {} } };
  game.spells = new Map();
  game.talentData = {
    revision: 1,
    skillLine: (id) => ({ id, name: "Алхимия", categoryId: 11, iconId: 0 }),
    skillCategory: () => undefined,
  };
  try {
    toggleProfessionList();
    assert.equal(professionListOpen(), true);
    const rows = [];
    const walk = (entry) => {
      if (entry.tagName === "DIV" && entry.children.some((child) => child.tagName === "BUTTON")) rows.push(entry);
      for (const child of entry.children) walk(child);
    };
    walk(document.body);
    assert.equal(rows.length, 1);
    const opener = rows[0].children.find((child) => child.tagName === "BUTTON");
    assert.equal(opener.textContent, "Открыть");

    // The skills pane is repainted on every drained world frame; the «Открыть» button has to be
    // the same node across those repaints, or a click between pointer-down and pointer-up is lost.
    showProfessions();
    const firstSection = characterSkillsPane.children[0];
    showProfessions();
    assert.equal(characterSkillsPane.children[0], firstSection, "an unchanged skills pane is not rebuilt");

    // And the list rows: closing and reopening the list keeps the node a click is landing on.
    const openedRow = rows[0];
    toggleProfessionList();
    assert.equal(professionListOpen(), false);
    toggleProfessionList();
    assert.equal(professionListOpen(), true);
    const rewalked = [];
    const collect = (entry) => {
      if (entry.tagName === "DIV" && entry.children.some((child) => child.tagName === "BUTTON")) rewalked.push(entry);
      for (const child of entry.children) collect(child);
    };
    collect(document.body);
    assert.equal(rewalked[0], openedRow, "the list row survives a reopen and stays clickable");

    assert.equal(openProfession(171), true, "the list entry opens its craft window");
    toggleProfessionList();
    assert.equal(professionListOpen(), false);
  } finally {
    game.world = undefined;
    game.spells = new Map();
    game.talentData = undefined;
  }
});

test("enchant target selection follows DBC equipment class, subclass and inventory masks", () => {
  const enchant = { effects: [53, 0, 0], equippedItemClass: 4, equippedItemSubclass: 2, equippedItemInvTypes: 1 << 5 };
  assert.equal(recipeAcceptsItem(enchant, { itemClass: 4, subClass: 1, inventoryType: 5 }), true);
  assert.equal(recipeAcceptsItem(enchant, { itemClass: 4, subClass: 1, inventoryType: 7 }), false);
  assert.equal(recipeAcceptsItem(enchant, { itemClass: 2, subClass: 1, inventoryType: 5 }), false);
});

test("craft enchant serializes one ordinary item target without unit/destination or trade flags", () => {
  const reader = new PacketReader(buildCastSpellOnItem(7418, 23, 0x4000000000001234n));
  assert.equal(reader.u8(), 23);
  assert.equal(reader.u32(), 7418);
  assert.equal(reader.u8(), 0);
  assert.equal(reader.u32(), TARGET_FLAG_ITEM);
  assert.equal(reader.packedGuid(), 0x4000000000001234n);
  assert.equal(reader.remaining, 0);
});

test("WorldClient sends enchants only for learned spells and carried items, and cancellation keeps cast identity", async () => {
  const { WorldClient } = await import("../dist/code/world/WorldClient.js");
  const { UPDATE_FIELDS: fields } = await import("../dist/code/generated/updateFields.js");
  const { OPCODES } = await import("../dist/code/generated/opcodes.js");
  const wire = [];
  const world = new WorldClient({ send(opcode, payload) { wire.push({ opcode, payload }); }, close() {} }, "Craft fixture");
  world.state.selfGuid = 1n;
  world.state.objects.set(1n, { guid: 1n, fields: new Map([[fields.PLAYER_FIELD_PACK_SLOT_1.offset, 100]]) });
  world.state.objects.set(100n, { guid: 100n, fields: new Map() });
  world.state.objects.set(101n, { guid: 101n, fields: new Map() });
  world.knownSpells = [{ id: 7418, slot: 0 }];
  world.castSpellOnItem(999, 100n);
  world.castSpellOnItem(7418, 101n);
  assert.equal(wire.length, 0, "unlearned spells and items outside carried slots never send");
  world.castSpellOnItem(7418, 100n);
  assert.equal(wire.length, 1);
  assert.equal(wire[0].opcode, OPCODES.CMSG_CAST_SPELL);
  const cast = new PacketReader(wire[0].payload);
  cast.u8(); assert.equal(cast.u32(), 7418); cast.u8();
  assert.equal(cast.u32(), TARGET_FLAG_ITEM); assert.equal(cast.packedGuid(), 100n);
  world.cancelSpellCast();
  assert.equal(wire.length, 1, "cancel has no packet without a real active cast");
  world.casts.set(1n, { spellId: 7418, castCount: 17, startedAt: 0, duration: 1000, channel: false });
  world.cancelSpellCast();
  assert.equal(wire[1].opcode, OPCODES.CMSG_CANCEL_CAST);
  assert.deepEqual([...wire[1].payload], [17, 250, 28, 0, 0]);
  world.close();
});

test("actual dataset marks recipes and carries their reagent/output operands", async () => {
  const { dbcDirectory } = await import("../tools/paths.mjs");
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const spells = await loadSpellMetadata(dbcDirectory());
  const potion = spells.get(2330);
  assert.equal(potion.tradeSkill, true);
  assert.ok(potion.effects.includes(24));
  assert.ok(potion.effectItemType.includes(118));
  assert.deepEqual(potion.reagents, [{ itemId: 2447, count: 1 }, { itemId: 765, count: 1 }, { itemId: 3371, count: 1 }]);
  assert.equal(spells.get(133).tradeSkill, false);
  assert.equal(professionSpellSkill(spells.get(2259), data), 171);
  const withTool = [...spells.values()].find((spell) => spell.requiredToolCategories.length > 0);
  assert.ok(withTool, "the dataset contains profession tools");
  assert.equal(withTool.requiredToolNames.length, withTool.requiredToolCategories.length);
  assert.ok(withTool.requiredToolNames.every((name) => name.length > 0 && name !== "Профессиональный инструмент"));
});
