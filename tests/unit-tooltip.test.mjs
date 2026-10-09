// 4.04: the native HUD's unit tooltip, built the way Wow.exe's unit tooltip writer (0x00621070)
// picks its lines and templates, and coloured by the stock GameTooltip_UnitColor.
import assert from "node:assert/strict";
import test from "node:test";

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { setStringSource } = await import("../dist/code/browser/ui/Strings.js");
const tooltip = await import("../dist/code/browser/ui/UnitTooltip.js");
const { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } = await import("../dist/code/world/FactionRules.js");

// The ruRU GlobalStrings.lua values the writer reads (lines 1114, 1865, 2108, 5665, 5760, 7610-7615).
const STRINGS = {
  TOOLTIP_UNIT_LEVEL: "Уровень %s",
  TOOLTIP_UNIT_LEVEL_CLASS: "%2$s %1$s-го уровня",
  TOOLTIP_UNIT_LEVEL_CLASS_TYPE: "%2$s %1$s-го уровня (%3$s)",
  TOOLTIP_UNIT_LEVEL_RACE_CLASS: "%2$s, %3$s %1$s-го уровня",
  TOOLTIP_UNIT_LEVEL_RACE_CLASS_TYPE: "%2$s, %3$s %1$s-го уровня (%4$s)",
  TOOLTIP_UNIT_LEVEL_TYPE: "Уровень %s (%s)",
  ELITE: "элита", BOSS: "босс", PLAYER: "игрок", CORPSE: "Труп существа", PVP_ENABLED: "PvP",
  UNIT_SKINNABLE_LEATHER: "Можно снять шкуру",
};
setStringSource((key) => STRINGS[key]);

// L1 (3.23): type 1 reads CreatureType.dbc's «Животное» (tests/creature-type-names), not «Зверь».
const base = {
  name: "Кабан", isPlayer: false, level: 5, playerLevel: 10, dead: false, reaction: REACTION_HOSTILE,
  canAttack: true, pvpFlagged: false, pvpLine: false, creatureType: 1, rank: 0, boss: false,
};
const texts = (content) => (content.lines ?? []).map((line) => (typeof line === "string" ? line : line.text));

test("a hostile elite beast: red name, its type and the rank word in the CLASS_TYPE template", () => {
  const content = tooltip.unitTooltipContent({ ...base, rank: 1 });
  assert.equal(content.title, "Кабан");
  assert.equal(content.titleColor, "#cc4d38", "FACTION_BAR_COLORS[2]");
  assert.deepEqual(texts(content), ["Животное 5-го уровня (элита)"]);
  assert.equal(content.cursor, true);
});

test("a friendly creature: green name, no creature type, the sub-name under the name", () => {
  const content = tooltip.unitTooltipContent({ ...base, name: "Торговец", reaction: REACTION_FRIENDLY,
    canAttack: false, creatureType: 7, subName: "Торговец оружием" });
  assert.equal(content.titleColor, "#00991a");
  assert.deepEqual(texts(content), ["Торговец оружием", "Уровень 5"]);
});

test("a neutral creature is yellow and shows its type; a rare without elite has no rank word", () => {
  const content = tooltip.unitTooltipContent({ ...base, reaction: REACTION_NEUTRAL, rank: 4 });
  assert.equal(content.titleColor, "#e6b300");
  assert.deepEqual(texts(content), ["Животное 5-го уровня"]);
});

test("the level is hidden for a boss, an unknown level and a hostile unit ten levels above", () => {
  assert.deepEqual(texts(tooltip.unitTooltipContent({ ...base, boss: true, rank: 3 })), ["Животное ??-го уровня (босс)"]);
  assert.equal(tooltip.unitTooltipLevelText({ ...base, level: 20, playerLevel: 10 }), "??");
  assert.equal(tooltip.unitTooltipLevelText({ ...base, level: 19, playerLevel: 10 }), "19");
  assert.equal(tooltip.unitTooltipLevelText({ ...base, level: 20, playerLevel: 10, reaction: REACTION_NEUTRAL }), "20",
    "only an enemy is a skull");
  assert.equal(tooltip.unitTooltipLevelText({ ...base, level: 0 }), "??");
});

test("a dead creature is CORPSE in the class slot", () => {
  assert.deepEqual(texts(tooltip.unitTooltipContent({ ...base, dead: true })), ["Труп существа 5-го уровня"]);
});

test("CreatureType 10 and an unanswered template give no type word", () => {
  assert.deepEqual(texts(tooltip.unitTooltipContent({ ...base, creatureType: 10 })), ["Уровень 5"]);
  assert.deepEqual(texts(tooltip.unitTooltipContent({ ...base, creatureType: undefined, rank: 1 })), ["Уровень 5 (элита)"]);
});

test("a player: guild under the name, race and class with the PLAYER word, PvP line", () => {
  const content = tooltip.unitTooltipContent({
    ...base, name: "Лиара", isPlayer: true, level: 80, playerLevel: 80, reaction: REACTION_FRIENDLY,
    canAttack: false, guild: "Стражи", raceName: "Ночной эльф", className: "Друид", pvpFlagged: true, pvpLine: true,
    creatureType: undefined,
  });
  assert.equal(content.titleColor, "#00991a", "a PvP-flagged friend is green");
  assert.deepEqual(texts(content), ["Стражи", "Ночной эльф, Друид 80-го уровня (игрок)", "PvP"]);
  const plain = tooltip.unitTooltipContent({ ...base, isPlayer: true, reaction: REACTION_FRIENDLY, canAttack: false,
    raceName: "Человек", className: "Воин" });
  assert.equal(plain.titleColor, "#ffffff", "a friend without PvP is white");
});

test("the key changes with what the card says", () => {
  assert.equal(tooltip.unitTooltipKey(base), tooltip.unitTooltipKey({ ...base }));
  assert.notEqual(tooltip.unitTooltipKey(base), tooltip.unitTooltipKey({ ...base, level: 6 }));
  assert.notEqual(tooltip.unitTooltipKey(base), tooltip.unitTooltipKey({ ...base, dead: true }));
});

function creature(guid, fields) {
  return { guid, typeId: 3, position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map(fields) };
}

test("the gatherer reads the cache template, the fields and the pet number", () => {
  const F = UPDATE_FIELDS;
  const self = { guid: 1n, typeId: 4, fields: new Map([[F.UNIT_FIELD_LEVEL.offset, 10]]) };
  const boar = creature(2n, [
    [F.OBJECT_FIELD_ENTRY.offset, 99], [F.UNIT_FIELD_LEVEL.offset, 5], [F.UNIT_FIELD_HEALTH.offset, 40],
    [F.UNIT_FIELD_BYTES_2.offset, 0x01 << 8],
  ]);
  const asked = [];
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, self], [2n, boar]]) },
    names: { get: () => undefined },
    creatureTemplate(entry, guid) {
      asked.push([entry, guid]);
      return { entry, found: true, name: "Кабан", subName: "Вожак", flags: 0, creatureType: 1, classification: 1 };
    },
  };
  const sources = { reaction: () => REACTION_HOSTILE, canAttack: () => true, spellRow: () => undefined };
  const facts = tooltip.unitTooltipFacts(world, boar, sources);
  assert.deepEqual(asked, [[99, 2n]], "asked by entry and guid, the creature query's own key");
  assert.equal(facts.name, "Кабан");
  assert.equal(facts.subName, "Вожак");
  assert.equal(facts.playerLevel, 10);
  assert.equal(facts.pvpLine, true, "UNIT_FIELD_BYTES_2 byte 1 bit 0x01");
  assert.equal(facts.dead, false);
  boar.fields.set(F.UNIT_FIELD_PETNUMBER.offset, 7);
  assert.equal(tooltip.unitTooltipFacts(world, boar, sources).subName, undefined, "a pet keeps its template's sub-name off");
  boar.fields.set(F.UNIT_DYNAMIC_FLAGS.offset, 0x20);
  assert.equal(tooltip.unitTooltipFacts(world, boar, sources).dead, true, "UNIT_DYNFLAG_DEAD");
  world.creatureTemplate = () => undefined;
  assert.equal(tooltip.unitTooltipFacts(world, boar, sources), undefined, "no name yet: no card");
});
