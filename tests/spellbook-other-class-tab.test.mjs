import assert from "node:assert/strict";
import test, { after } from "node:test";

// The other classes' spellbook tab (the owner's ruling of 2026-09-28): spells from another class's
// ability line leave General for one tab of their own, the last. The line's class comes from its
// single-class SkillLineAbility rows (TalentClient.skillLineClass); the rows below reproduce the
// measured shapes — a masked class spell (Greater Heal), a maskless talent spell in a class line
// (Corpse Explosion), a racial line in category 9, a profession, a mount line with a few paladin
// rows, a rowless module spell — for the owner's class 13 HERO and for a stock mage.
const { TalentClient } = await import("../dist/code/browser/TalentClient.js");
const {
  SPELLBOOK_GENERAL_TAB, SPELLBOOK_OTHER_CLASS_TAB, spellbookClassLines, spellbookOtherClassSpell,
  spellbookOtherClassTabName, spellbookTabFor,
} = await import("../dist/code/browser/ui/SpellbookTabs.js");
const { createFrameXmlSpellBookTabResolvers } = await import("../dist/code/browser/framexml/FrameXmlSpellBookTabs.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { learnCreationNames, forgetCreationNames } = await import("../dist/code/browser/ui/UnitSnapshot.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const PRIEST = 5;
const DK = 6;
const MAGE = 8;
const HERO = 13;
const HUMAN = 1;

const row = (skillLine, classMask = 0, raceMask = 0, acquireMethod = 0) => ({
  skillLine, raceMask, classMask, excludeRace: 0, excludeClass: 0, minSkillLineRank: 0,
  supercededBySpell: 0, acquireMethod, trivialSkillLineRankHigh: 0, trivialSkillLineRankLow: 0, characterPoints: [0, 0],
});

/** Filler rows that make a line some class's: `count` single-class rows on made-up spell ids. */
function filler(abilities, skillLine, classMask, count, from) {
  for (let index = 0; index < count; index += 1) abilities[from + index] = [row(skillLine, classMask)];
}

function talentData() {
  const abilities = {
    48063: [row(56, 1 << (PRIEST - 1))], // Великое исцеление: Holy, the priest's
    51328: [row(772, 0)], // Взрыв трупа: a DK talent spell, maskless in Unholy
    58753: [row(373, 0)], // Тотем каменной кожи: maskless in Enhancement
    133: [row(8, 1 << (MAGE - 1))], // Огненный шар: Fire, the mage's
    11366: [row(8, 0)], // Огненная глыба: a mage talent spell, maskless in Fire
    20599: [row(754, 0, 1 << (HUMAN - 1))], // Дипломатия: the human racial line (category 9)
    2550: [row(185, 0)], // Кулинария: a secondary skill
    458: [row(777, 0)], // Гнедой конь: a mount, maskless in category-7 Mounts
    6603: [row(183, 0)], // Автоматическая атака: GENERIC (DND)
  };
  filler(abilities, 56, 1 << (PRIEST - 1), 12, 900000);
  filler(abilities, 772, 1 << (DK - 1), 11, 910000);
  filler(abilities, 373, 1 << (7 - 1), 12, 920000);
  filler(abilities, 8, 1 << (MAGE - 1), 12, 930000);
  filler(abilities, 777, 1 << (2 - 1), 4, 940000); // four paladin mounts among the Mounts rows
  // A realm's own mage line that no talent tree is named after, and one known spell in it.
  abilities[990001] = [row(9999, 1 << (MAGE - 1))];
  filler(abilities, 9999, 1 << (MAGE - 1), 11, 950000);
  const skillLines = [
    [56, 7, "Свет"], [772, 7, "Нечестивость"], [373, 7, "Совершенствование"], [8, 7, "Огонь"],
    [754, 9, "Расовый: люди"], [185, 9, "Кулинария"], [777, 7, "Средства передвижения"], [183, 12, "GENERIC (DND)"],
    [9999, 7, "Ярость"],
  ].map(([id, categoryId, name]) => ({ id, name, categoryId, iconId: 0, iconPath: `Interface\\Icons\\Line_${id}` }));
  const spellSkill = Object.fromEntries(Object.entries(abilities).map(([id, rows]) => [id, rows[0].skillLine]));
  return {
    tabs: [{ id: 81, name: "Огонь", classMask: 1 << (MAGE - 1), petTalentMask: 0, orderIndex: 1, iconPath: "" }],
    talents: [], glyphs: [], skillLines, skillCategories: [{ id: 7, name: "Классовые навыки", orderIndex: 1 }],
    spellSkill, spellAbilities: abilities, petFamilies: {}, petFamilyMasks: {}, petFamilyNames: {},
  };
}

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  game.world = undefined;
  forgetCreationNames();
});

async function loadedTalents() {
  globalThis.fetch = async () => ({ ok: true, json: async () => talentData() });
  const client = new TalentClient("ws://127.0.0.1:1/auth");
  const loaded = new Promise((resolve) => { client.onLoaded = resolve; });
  client.load();
  await loaded;
  return client;
}

const dataOf = (talent) => ({
  skillOfSpell: (id) => talent.skillOfSpell(id),
  spellAbilitiesOf: (id) => talent.spellAbilitiesOf(id),
  skillLine: (id) => talent.skillLine(id),
  skillLineClass: (line) => talent.skillLineClass(line),
});

test("a class-category line belongs to the class of its single-class rows, from ten rows on", async () => {
  const talent = await loadedTalents();
  assert.equal(talent.skillLineClass(56), PRIEST);
  assert.equal(talent.skillLineClass(772), DK, "Unholy by its eleven masked rows, whatever its talent rows say");
  assert.equal(talent.skillLineClass(8), MAGE);
  assert.equal(talent.skillLineClass(777), undefined, "four paladin mounts do not make Mounts a paladin line");
  assert.equal(talent.skillLineClass(754), undefined, "a racial line is category 9");
  assert.equal(talent.skillLineClass(183), undefined);
});

test("class 13 HERO: other classes' spells go to their own tab; General keeps racials, professions and the rest", async () => {
  const talent = await loadedTalents();
  const data = dataOf(talent);
  const actor = { classId: HERO, raceId: HUMAN };
  const known = [48063, 51328, 58753, 133, 20599, 2550, 458, 6603, 777777];
  const classLines = spellbookClassLines(data, known, actor);
  assert.deepEqual([...classLines], [], "HERO has no class line of its own in the stock tables");
  const tabs = Object.fromEntries(known.map((id) => [id, spellbookTabFor(id, data, classLines, actor)]));
  assert.deepEqual(tabs, {
    48063: SPELLBOOK_OTHER_CLASS_TAB, // the priest's, by its masked row
    51328: SPELLBOOK_OTHER_CLASS_TAB, // the DK's, by its line: its own row is maskless and matches
    58753: SPELLBOOK_OTHER_CLASS_TAB,
    133: SPELLBOOK_OTHER_CLASS_TAB,
    20599: SPELLBOOK_GENERAL_TAB, // the racial
    2550: SPELLBOOK_GENERAL_TAB,
    458: SPELLBOOK_GENERAL_TAB, // a mount stays general
    6603: SPELLBOOK_GENERAL_TAB,
    777777: SPELLBOOK_GENERAL_TAB, // a module's rowless spell
  });
  assert.equal(spellbookOtherClassTabName("Герой", false), "Герой", "a class with no tree of its own names the tab");
  assert.equal(spellbookOtherClassTabName("Маг", true), "Другие классы", "beside a stock class's own trees");
  assert.equal(spellbookOtherClassSpell(48063, data, {}), false, "no actor class, no judgement");
});

test("a stock mage keeps its own trees, talent spells included; only the priest's spell leaves", async () => {
  const talent = await loadedTalents();
  const data = dataOf(talent);
  const actor = { classId: MAGE, raceId: HUMAN };
  const known = [133, 11366, 48063, 20599];
  const classLines = spellbookClassLines(data, known, actor);
  assert.deepEqual([...classLines], [8]);
  assert.equal(spellbookTabFor(133, data, classLines, actor), 8);
  assert.equal(spellbookTabFor(11366, data, classLines, actor), 8, "a maskless talent row in the mage's own line");
  assert.equal(spellbookTabFor(48063, data, classLines, actor), SPELLBOOK_OTHER_CLASS_TAB);
  assert.equal(spellbookTabFor(20599, data, classLines, actor), SPELLBOOK_GENERAL_TAB);
  // Talent spells alone still make their tree the class's tab.
  assert.deepEqual([...spellbookClassLines(data, [11366], actor)], [8]);
});

test("the stock book draws General, then the HERO's tab under the class name, last, with the first spell's picture", async () => {
  const talent = await loadedTalents();
  learnCreationNames([], [{ id: HERO, name: "Герой", fileName: "HERO" }]);
  const selfGuid = 0x10n;
  const fields = new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, HUMAN | (HERO << 8)]]);
  const known = [20599, 48063, 6603, 51328];
  game.world = {
    state: { selfGuid, objects: new Map([[selfGuid, { guid: selfGuid, typeId: 4, fields }]]) },
    knownSpells: known.map((id, slot) => ({ id, slot })),
  };
  const icon = (name) => `Interface\\Icons\\${name}`;
  const spells = new Map([
    [20599, { id: 20599, name: "Дипломатия", rank: "Расовая", iconPath: icon("INV_Misc_Note_02"), hidden: false }],
    [48063, { id: 48063, name: "Великое исцеление", rank: "Уровень 9", iconPath: icon("Spell_Holy_GreaterHeal"), hidden: false }],
    [6603, { id: 6603, name: "Автоматическая атака", rank: "", iconPath: icon("INV_Sword_04"), hidden: false }],
    [51328, { id: 51328, name: "Взрыв трупа", rank: "", iconPath: icon("Ability_Creature_Disease_02"), hidden: false }],
  ]);
  const resolvers = createFrameXmlSpellBookTabResolvers(() => ({ world: game.world, talent, spells }));
  assert.deepEqual(resolvers.spellTabs(), [
    ["Общие", icon("INV_Misc_Book_09"), 0, 2, 0, 2],
    ["Герой", icon("Spell_Holy_GreaterHeal"), 2, 2, 2, 2],
  ]);
  assert.equal(resolvers.spellTabFor(20599), 1);
  assert.equal(resolvers.spellTabFor(6603), 1);
  assert.equal(resolvers.spellTabFor(48063), 2);
  assert.equal(resolvers.spellTabFor(51328), 2);
});

test("beside a stock class's trees and its own lines, «Другие классы» is the last tab", async () => {
  const talent = await loadedTalents();
  const selfGuid = 0x10n;
  const fields = new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, HUMAN | (MAGE << 8)]]);
  const known = [48063, 990001, 133];
  game.world = {
    state: { selfGuid, objects: new Map([[selfGuid, { guid: selfGuid, typeId: 4, fields }]]) },
    knownSpells: known.map((id, slot) => ({ id, slot })),
  };
  const spells = new Map(known.map((id) => [id, { id, name: `Заклинание ${id}`, rank: "", iconPath: `Interface\\Icons\\S${id}`, hidden: false }]));
  const resolvers = createFrameXmlSpellBookTabResolvers(() => ({ world: game.world, talent, spells }));
  assert.deepEqual(resolvers.spellTabs().map(([name]) => name), ["Огонь", "Ярость", "Другие классы"],
    "the tree first, the realm's own line by name, the other classes' tab last (no General spell here)");
});
