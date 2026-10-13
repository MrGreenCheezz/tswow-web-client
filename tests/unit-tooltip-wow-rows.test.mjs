import assert from "node:assert/strict";
import test from "node:test";

// Plan item 4.04 (13.10): GameTooltip:SetUnit as Wow.exe 3.3.5a 12340 writes it (0x00621070, decompiled in
// .runtime/re-2026-09-30/r4/decomp.txt; callees .runtime/re-2026-10-11/glue-1110/t1013-*.txt): the level line's
// three slots and six templates, the drunk player's lower levels (0x004f7290), the faction line, PVP_ENABLED,
// RESURRECTABLE, beast lore (0x00620950), the racial leader (0x0071b680), the quest objectives (0x005e2370,
// 0x005e2630) and the threat line (0x007374c0).
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const {
  frameXmlUnitLevelSlots, frameXmlDrunkLevelDrop, frameXmlUnitFactionName, frameXmlUnitPvpLine, frameXmlUnitResurrectable,
  frameXmlUnitRacialLeader, frameXmlBeastLoreRows, frameXmlUnitQuestRows, frameXmlSummonedByPlayer, frameXmlUnitTooltipFacts,
} = await import("../dist/code/browser/framexml/FrameXmlUnitTooltipFacts.js");
const {
  glueUnitLevelText, glueUnitLevelSlotsFromLua, glueUnitRowsBeforeSkin, glueUnitRowsAfterSkin, glueUnitThreatRow,
} = await import("../dist/code/browser/glue/GlueUnitTooltip.js");
const { formatClientTemplate } = await import("../dist/code/browser/glue/GlueWidgets.js");

const F = (name) => UPDATE_FIELDS[name].offset;
const floatWord = (value) => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
function object(guid, typeId, fields) {
  const map = new Map();
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "bigint") {
      map.set(F(name), Number(value & 0xffffffffn));
      map.set(F(name) + 1, Number(value >> 32n));
    } else map.set(F(name), value);
  }
  return { guid, typeId, fields: map };
}

/** The ruRU GlobalStrings these rows use (GlobalStrings.lua of the dataset's client). */
const RU = {
  TOOLTIP_UNIT_LEVEL: "Уровень %s", TOOLTIP_UNIT_LEVEL_TYPE: "Уровень %s (%s)",
  TOOLTIP_UNIT_LEVEL_CLASS: "%2$s %1$s-го уровня", TOOLTIP_UNIT_LEVEL_CLASS_TYPE: "%2$s %1$s-го уровня (%3$s)",
  TOOLTIP_UNIT_LEVEL_RACE_CLASS: "%2$s, |3-6(%3$s) %1$s-го уровня",
  TOOLTIP_UNIT_LEVEL_RACE_CLASS_TYPE: "%2$s, |3-6(%3$s) %1$s-го уровня (%4$s)",
  PLAYER: "игрок", BOSS: "босс", ELITE: "элита", CORPSE: "Труп существа", PVP_ENABLED: "PvP",
  RESURRECTABLE: "Можно воскресить", PVP_RANK_LEADER: "Лидер", THREAT_TOOLTIP: "%d%% уровень угрозы",
  DAMAGE_TEMPLATE: "Урон: %d - %d", SINGLE_DAMAGE_TEMPLATE: "Урон: %d", ARMOR_TEMPLATE: "Броня: %d", HP_TEMPLATE: "Здоровье: %d",
  RESISTANCE_TEMPLATE: "%2$s, %1$d", RESISTANCE2_NAME: "Сопротивление огню", RESISTANCE4_NAME: "",
  PET_DIET_TEMPLATE: "Рацион питания: %s", TAMEABLE: "Приручается", TAMEABLE_EXOTIC: "Приручается (Экзотичное)",
  NOT_TAMEABLE: "Приручить нельзя", QUEST_MONSTERS_KILLED: "%s – убито: %d/%d", QUEST_OBJECTS_FOUND: "%s: %d/%d",
  QUEST_ITEMS_NEEDED: "%s: %d/%d",
};
const host = (globals = {}, strings = RU) => ({
  callGlobal: (name, args) => {
    const value = globals[name];
    return typeof value === "function" ? value(...args) : value === undefined ? [] : [value];
  },
  globalString: (key) => strings[key],
  format: (template, ...values) => formatClientTemplate(template, ...values),
});

const SELF = 0x10n;
const self = (fields = {}) => object(SELF, 4, { UNIT_FIELD_LEVEL: 80, UNIT_FIELD_BYTES_0: 1 | (8 << 8), ...fields });
const record = (overrides = {}) => ({ found: true, flags: 0, classification: 0, creatureFamily: 0, ...overrides });

test("level slots: race and class for a player, the type word below friendly, BOSS/ELITE, the skull and the corpse", () => {
  const me = self();
  const player = object(0x20n, 4, { UNIT_FIELD_LEVEL: 70, UNIT_FIELD_HEALTH: 100 });
  assert.deepEqual(frameXmlUnitLevelSlots(player, me, undefined, { canAttack: false, raceName: "Эльфийка крови", className: "Жрица" }),
    { level: "70", race: "Эльфийка крови", cls: "Жрица", typeKey: "PLAYER" });
  const wolf = object(0xf1300000010000aan, 3, { UNIT_FIELD_LEVEL: 60, UNIT_FIELD_HEALTH: 100 });
  const names = (id) => ({ 1: "Животное", 7: "Гуманоид", 10: "Не указано" })[id];
  const sources = (playerRank, extra = {}) => ({ creatureTypeId: 1, creatureTypeName: names, playerRank, unitRank: 3, canAttack: true, ...extra });
  assert.deepEqual(frameXmlUnitLevelSlots(wolf, me, record(), sources(1)), { level: "60", cls: "Животное" }, "hostile: the word");
  assert.deepEqual(frameXmlUnitLevelSlots(wolf, me, record(), sources(3)), { level: "60", cls: "Животное" }, "neutral: the word");
  assert.deepEqual(frameXmlUnitLevelSlots(wolf, me, record(), sources(4)), { level: "60" }, "friendly: none");
  assert.deepEqual(frameXmlUnitLevelSlots(wolf, me, record({ flags: 0x0400_0000 }), sources(1)), { level: "60" }, "TREAT_AS_RAID_UNIT");
  assert.deepEqual(frameXmlUnitLevelSlots(wolf, me, record(), sources(1, { creatureTypeId: 10 })), { level: "60" }, "type 10: none");
  assert.deepEqual(frameXmlUnitLevelSlots(wolf, me, record(), sources(undefined)), { level: "60" }, "no reaction yet: no guess");
  assert.deepEqual(frameXmlUnitLevelSlots(wolf, me, record({ classification: 1 }), sources(1)), { level: "60", cls: "Животное", typeKey: "ELITE" });
  assert.deepEqual(frameXmlUnitLevelSlots(wolf, me, record({ classification: 2 }), sources(1)).typeKey, "ELITE", "rare elite");
  assert.equal(frameXmlUnitLevelSlots(wolf, me, record({ classification: 3 }), sources(1)).typeKey, undefined, "world boss rank: no word");
  assert.equal(frameXmlUnitLevelSlots(wolf, me, record({ classification: 4 }), sources(1)).typeKey, undefined, "rare: no word");
  const pet = object(0xf1400000010000abn, 3, { UNIT_FIELD_LEVEL: 60, UNIT_FIELD_HEALTH: 1, UNIT_FIELD_PETNUMBER: 7 });
  assert.equal(frameXmlUnitLevelSlots(pet, me, record({ classification: 1 }), sources(1)).typeKey, undefined, "a pet has no rank word");
  assert.deepEqual(frameXmlUnitLevelSlots(wolf, me, record({ flags: 0x4 }), sources(1)), { level: "??", cls: "Животное", typeKey: "BOSS" });
  const high = object(0xf1300000010000acn, 3, { UNIT_FIELD_LEVEL: 90, UNIT_FIELD_HEALTH: 1 });
  assert.equal(frameXmlUnitLevelSlots(high, me, record(), sources(1, { unitRank: 1 })).level, "??", "hates the player, 10 above");
  assert.equal(frameXmlUnitLevelSlots(high, me, record(), sources(1, { unitRank: 2 })).level, "90", "unfriendly is not enough");
  assert.equal(frameXmlUnitLevelSlots(object(0xf1300000010000adn, 3, { UNIT_FIELD_LEVEL: 89, UNIT_FIELD_HEALTH: 1 }), me, record(),
    sources(1, { unitRank: 0 })).level, "89", "nine above: the number");
  assert.equal(frameXmlUnitLevelSlots(object(0xf1300000010000aen, 3, { UNIT_FIELD_HEALTH: 1 }), me, record(), sources(1)).level, "??", "level 0");
  const corpse = object(0xf1300000010000afn, 3, { UNIT_FIELD_LEVEL: 60 });
  assert.deepEqual(frameXmlUnitLevelSlots(corpse, me, record(), sources(1)), { level: "60", corpse: true }, "health 0: CORPSE");
  const ghost = object(0x21n, 4, { UNIT_FIELD_LEVEL: 70, UNIT_FIELD_HEALTH: 0 });
  assert.deepEqual(frameXmlUnitLevelSlots(ghost, me, undefined, { canAttack: false, raceName: "Человек", className: "Воин" }),
    { level: "70", corpse: true, typeKey: "PLAYER" }, "a dead player: CORPSE, still PLAYER");
});

test("drunk: 0x004f7290 · 5, fistp(x + 0.5), off an attackable unit, never below 1", () => {
  const drunk = (value, fake = 0) => self({ PLAYER_BYTES_3: value << 8, PLAYER_FAKE_INEBRIATION: fake });
  assert.deepEqual([0, 5, 10, 30, 50, 70, 100].map((value) => frameXmlDrunkLevelDrop(drunk(value))), [0, 1, 1, 2, 3, 4, 6]);
  assert.equal(frameXmlDrunkLevelDrop(drunk(0, 50)), 3, "the fake value when it is the larger");
  assert.equal(frameXmlDrunkLevelDrop(drunk(10, 300)), 6, "100 at most");
  const wolf = object(0xf1300000010000aan, 3, { UNIT_FIELD_LEVEL: 60, UNIT_FIELD_HEALTH: 100 });
  const sources = (canAttack) => ({ creatureTypeId: 1, creatureTypeName: () => "Животное", playerRank: 1, unitRank: 3, canAttack });
  assert.equal(frameXmlUnitLevelSlots(wolf, drunk(100), record(), sources(true)).level, "54");
  assert.equal(frameXmlUnitLevelSlots(wolf, drunk(100), record(), sources(false)).level, "60", "only a unit the player can attack");
  const cub = object(0xf1300000010000abn, 3, { UNIT_FIELD_LEVEL: 3, UNIT_FIELD_HEALTH: 100 });
  assert.equal(frameXmlUnitLevelSlots(cub, drunk(100), record(), sources(true)).level, "1", "never below 1");
});

test("faction line: the first race/class entry, not hidden; HIDE_FACTION_TOOLTIP none", () => {
  const HUMAN = 1, ORC = 2, WARRIOR = 1, MAGE = 8;
  const row = { raceMasks: [1 << (ORC - 1), 0, 1 << (HUMAN - 1), 0], classMasks: [0, 1 << (MAGE - 1), 0, 0], flags: [0, 4, 0, 0] };
  assert.equal(frameXmlUnitFactionName(record(), row, "Штормград", HUMAN, WARRIOR), "Штормград", "the third entry: human");
  assert.equal(frameXmlUnitFactionName(record(), row, "Штормград", ORC, WARRIOR), "Штормград", "the first: orc");
  assert.equal(frameXmlUnitFactionName(record(), row, "Штормград", 4, MAGE), undefined, "a class-only entry that is hidden");
  assert.equal(frameXmlUnitFactionName(record(), row, "Штормград", 4, WARRIOR), undefined, "no entry for a night elf warrior");
  assert.equal(frameXmlUnitFactionName(record({ flags: 0x10 }), row, "Штормград", HUMAN, WARRIOR), undefined, "HIDE_FACTION_TOOLTIP");
  assert.equal(frameXmlUnitFactionName(undefined, row, "Штормград", HUMAN, WARRIOR), "Штормград", "a player: no record");
  assert.equal(frameXmlUnitFactionName(record(), undefined, "Штормград", HUMAN, WARRIOR), undefined, "no reputation");
  const byClass = { raceMasks: [0, 0, 0, 0], classMasks: [1 << (MAGE - 1), 0, 0, 0], flags: [0, 0, 0, 0] };
  assert.equal(frameXmlUnitFactionName(record(), byClass, "Кирин-Тор", 4, MAGE), "Кирин-Тор", "an empty race mask with a class mask");
  assert.equal(frameXmlUnitFactionName(record(), byClass, "Кирин-Тор", 4, WARRIOR), undefined);
  const rows = glueUnitRowsBeforeSkin(host(), { level: { level: "1" }, resurrectable: true, pvp: false }, () => true);
  assert.deepEqual(rows.map((row) => [row.text, row.color.r, row.color.g, row.color.b]), [["Можно воскресить", 0, 1, 0]],
    "RESURRECTABLE green (0x00ad2d40); the facts' PvP answer wins over UnitIsPVP");
});

test("PvP, RESURRECTABLE, the racial leader, a player's summon", () => {
  const me = self();
  assert.equal(frameXmlUnitPvpLine(object(1n, 3, { UNIT_FIELD_BYTES_2: 1 << 8 })), true);
  assert.equal(frameXmlUnitPvpLine(object(1n, 4, { PLAYER_FLAGS: 0x100 })), true, "contested");
  assert.equal(frameXmlUnitPvpLine(object(1n, 3, { PLAYER_FLAGS: 0x100 })), false, "only a player's flags");
  const dead = object(0x22n, 4, { UNIT_FIELD_HEALTH: 0 });
  assert.equal(frameXmlUnitResurrectable(dead, me, true), true);
  assert.equal(frameXmlUnitResurrectable(dead, me, false), false, "cannot assist");
  assert.equal(frameXmlUnitResurrectable(object(0x23n, 4, { UNIT_FIELD_HEALTH: 5 }), me, true), false, "alive");
  assert.equal(frameXmlUnitResurrectable(object(0xf13n, 3, {}), me, true), false, "a creature");
  const king = object(0xf130000001000001n, 3, { UNIT_FIELD_BYTES_2: 1 << 8 });
  assert.equal(frameXmlUnitRacialLeader(king, record({ leader: true })), true);
  assert.equal(frameXmlUnitRacialLeader(object(0xf13n, 3, {}), record({ leader: true })), false, "not PvP-flagged");
  assert.equal(frameXmlUnitRacialLeader(king, record()), false);
  assert.equal(frameXmlSummonedByPlayer(object(0xf13n, 3, { UNIT_FIELD_SUMMONEDBY: 0x99n })), true);
  assert.equal(frameXmlSummonedByPlayer(object(0xf13n, 3, { UNIT_FIELD_SUMMONEDBY: 0xf130000001000001n })), false);
});

test("beast lore: damage, armour, health, resistances, diet, tameable — only with SPECIALINFO", () => {
  const fields = {
    UNIT_DYNAMIC_FLAGS: 0x10, UNIT_FIELD_HEALTH: 4200,
    UNIT_FIELD_MINDAMAGE: floatWord(10.5), UNIT_FIELD_MAXDAMAGE: floatWord(20.2),
  };
  const beast = object(0xf13n, 3, fields);
  beast.fields.set(F("UNIT_FIELD_RESISTANCES"), 350);
  beast.fields.set(F("UNIT_FIELD_RESISTANCES") + 2, 25);
  beast.fields.set(F("UNIT_FIELD_RESISTANCES") + 4, 30); // frost: RESISTANCE4_NAME is empty in this fixture
  beast.fields.set(F("UNIT_FIELD_RESISTANCES") + 5, 0xffffffff); // -1: not above 0
  const foods = { familyMask: (family) => family === 1 ? 3 : 0, foodNames: (mask) => mask === 3 ? ["Мясо", "Рыба"] : [] };
  const rows = frameXmlBeastLoreRows(beast, record({ creatureFamily: 1, flags: 1 }), foods);
  assert.deepEqual(rows, [
    { key: "DAMAGE_TEMPLATE", args: [10, 21] }, { key: "ARMOR_TEMPLATE", args: [350] }, { key: "HP_TEMPLATE", args: [4200] },
    { key: "RESISTANCE_TEMPLATE", args: [25, { global: "RESISTANCE2_NAME" }] },
    { key: "RESISTANCE_TEMPLATE", args: [30, { global: "RESISTANCE4_NAME" }] },
    { key: "PET_DIET_TEMPLATE", args: ["Мясо, Рыба"] }, { key: "TAMEABLE", args: [] },
  ], "10.5 rounds to even 10; 20.2 is raised to 21");
  const texts = glueUnitRowsBeforeSkin(host(), { level: { level: "1" }, beastLore: rows }, () => false).map((row) => row.text);
  assert.deepEqual(texts, ["Урон: 10 - 21", "Броня: 350", "Здоровье: 4200", "Сопротивление огню, 25", "Рацион питания: Мясо, Рыба",
    "Приручается"], "an empty RESISTANCE<i>_NAME writes no row");
  assert.equal(frameXmlBeastLoreRows(beast, record({ creatureFamily: 1, flags: 0x10001 }), foods).at(-1).key, "TAMEABLE_EXOTIC");
  assert.equal(frameXmlBeastLoreRows(beast, record({ creatureFamily: 0, flags: 1 }), foods).at(-1).key, "NOT_TAMEABLE", "no family");
  const same = object(0xf13n, 3, { UNIT_DYNAMIC_FLAGS: 0x10, UNIT_FIELD_MINDAMAGE: floatWord(12), UNIT_FIELD_MAXDAMAGE: floatWord(11.4) });
  assert.deepEqual(frameXmlBeastLoreRows(same, undefined, undefined)[0], { key: "SINGLE_DAMAGE_TEMPLATE", args: [12] });
  assert.deepEqual(frameXmlBeastLoreRows(object(0xf13n, 3, { ...fields, UNIT_DYNAMIC_FLAGS: 0 }), record(), foods), [],
    "no SPECIALINFO: nothing");
});

test("quest rows: kill, kill credit, own text, items to carry, source items while not done", () => {
  const template = {
    title: "Волки", startItem: 900,
    objectives: [
      { slot: 0, entry: 299, count: 10, gameObject: false, text: "" },
      { slot: 1, entry: 300, count: 1, gameObject: false, text: "Вожак выслежен" },
      { slot: 2, entry: 299, count: 1, gameObject: true, text: "" },
    ],
    itemObjectives: [{ itemId: 750, count: 8 }, { itemId: 900, count: 1 }, { itemId: 752, count: 2 }],
    sourceItems: [751, 0, 0, 0],
  };
  const other = { title: "Чужое", objectives: [{ slot: 0, entry: 1, count: 1, gameObject: false, text: "" }], itemObjectives: [] };
  let carried = 3;
  const sources = {
    rows: [{ entry: { state: 0, counters: [4, 0, 0, 0] }, template: other }, { entry: { state: 0, counters: [4, 1, 0, 0] }, template }],
    creatureName: (entry) => entry === 299 ? "Волк" : undefined,
    itemName: (id) => ({ 750: "Шкура волка", 751: "Клык" })[id],
    itemCount: (id) => id === 750 ? carried : 0,
  };
  const quests = frameXmlUnitQuestRows(299, record({ proxyCreatureIds: [300, 0], questItems: [750, 751, 900, 0, 752, 0] }), sources);
  assert.deepEqual(quests, [{ title: "Волки", lines: [
    { key: "QUEST_MONSTERS_KILLED", args: ["Волк", 4, 10] },
    { key: "QUEST_OBJECTS_FOUND", args: ["Вожак выслежен", 1, 1] },
    { key: "QUEST_ITEMS_NEEDED", args: ["Шкура волка", 3, 8] },
    { text: "Клык" },
  ] }], "the start item needed once is no line; the list ends at the first 0; a GO objective never matches");
  carried = 20;
  sources.rows[1].entry.counters.splice(0, 3, 10, 1, 1);
  sources.itemCount = (id) => id === 750 ? carried : id === 900 ? 1 : id === 752 ? 2 : 0;
  const done = frameXmlUnitQuestRows(299, record({ proxyCreatureIds: [300, 0], questItems: [750, 751] }), sources);
  assert.deepEqual(done[0].lines.slice(2), [{ key: "QUEST_ITEMS_NEEDED", args: ["Шкура волка", 8, 8] }],
    "carried up to the need; done: no source-item line");
  assert.deepEqual(frameXmlUnitQuestRows(5, record(), sources), [], "nothing for this creature");
  const rows = glueUnitRowsAfterSkin(host({ GetCVarBool: (name) => [name === "showQuestTrackingTooltips"] }), { level: { level: "1" }, quests });
  assert.deepEqual(rows.map((row) => row.text), ["Волки", " - Волк – убито: 4/10", " - Вожак выслежен: 1/1", " - Шкура волка: 3/8", " - Клык"]);
  assert.deepEqual([rows[0].color.r, rows[0].color.g, rows[0].color.b], [1, 210 / 255, 0], "the title gold (0x00ad2d2c)");
  assert.deepEqual(glueUnitRowsAfterSkin(host({ GetCVarBool: false }), { level: { level: "1" }, quests }), [], "the CVar off");
});

test("templates: six by the filled slots; the Lua path chooses the same way", () => {
  const h = host();
  assert.equal(glueUnitLevelText(h, { level: "80", race: "Человек", cls: "Воин", typeKey: "PLAYER" }), "Человек, |3-6(Воин) 80-го уровня (игрок)");
  assert.equal(glueUnitLevelText(h, { level: "80", race: "Человек", cls: "Воин" }), "Человек, |3-6(Воин) 80-го уровня");
  assert.equal(glueUnitLevelText(h, { level: "??", cls: "Гуманоид", typeKey: "BOSS" }), "Гуманоид ??-го уровня (босс)");
  assert.equal(glueUnitLevelText(h, { level: "60", cls: "Животное" }), "Животное 60-го уровня");
  assert.equal(glueUnitLevelText(h, { level: "60", typeKey: "ELITE" }), "Уровень 60 (элита)");
  assert.equal(glueUnitLevelText(h, { level: "60" }), "Уровень 60");
  assert.equal(glueUnitLevelText(h, { level: "60", corpse: true, race: "Человек", cls: "Воин", typeKey: "PLAYER" }),
    "Труп существа 60-го уровня (игрок)", "a dead player: CORPSE in the class slot, no race");
  const lua = (globals) => glueUnitLevelSlotsFromLua(host(globals), "target");
  const base = { UnitIsPlayer: false, UnitIsDead: false, UnitLevel: (unit) => [unit === "player" ? 80 : 60], UnitCreatureType: "Животное" };
  assert.deepEqual(lua({ ...base, UnitReaction: (a) => [a === "player" ? 2 : 2], UnitClassification: "elite" }),
    { level: "60", cls: "Животное", typeKey: "ELITE" });
  assert.deepEqual(lua({ ...base, UnitReaction: () => [5], UnitClassification: "normal" }), { level: "60" }, "friendly: no word");
  assert.deepEqual(lua({ ...base, UnitReaction: () => [2], UnitClassification: "worldboss" }), { level: "??", cls: "Животное", typeKey: "BOSS" });
  assert.equal(lua({ ...base, UnitLevel: (unit) => [unit === "player" ? 50 : 60], UnitReaction: () => [2] }).level, "??", "the skull");
  assert.deepEqual(lua({ ...base, UnitIsPlayer: true, UnitRace: "Человек", UnitClass: "Воин" }),
    { level: "60", race: "Человек", cls: "Воин", typeKey: "PLAYER" });
  assert.deepEqual(lua({ ...base, UnitIsDead: true, UnitReaction: () => [2] }), { level: "60", corpse: true });
});

test("threat: THREAT_TOOLTIP with fistp(pct − 0.5) while the warning is on", () => {
  const threat = (scaled, enabled = true) => glueUnitThreatRow(host({
    IsThreatWarningEnabled: enabled, UnitDetailedThreatSituation: () => scaled === undefined ? [] : [undefined, 1, scaled, 50, 1000],
  }), "target")?.text;
  assert.equal(threat(100), "100% уровень угрозы", "the victim: 99.5 rounds to even 100");
  assert.equal(threat(99), "98% уровень угрозы", "98.5 rounds to even 98");
  assert.equal(threat(50.7), "50% уровень угрозы");
  assert.equal(threat(51.5), "51% уровень угрозы");
  assert.equal(threat(80, false), undefined, "the warning off");
  assert.equal(threat(undefined), undefined, "not on the list");
});

test("facts: the live gathering of one creature and its rows in GameTooltip:SetUnit's order", async () => {
  const me = self();
  const wolf = object(0xf130000012b000aan, 3, {
    OBJECT_FIELD_ENTRY: 299, UNIT_FIELD_LEVEL: 60, UNIT_FIELD_HEALTH: 100, UNIT_FIELD_BYTES_2: 1 << 8, UNIT_DYNAMIC_FLAGS: 0x10,
  });
  const facts = frameXmlUnitTooltipFacts({
    object: wolf, self: me, record: record({ leader: true, flags: 0 }),
    level: { creatureTypeId: 1, creatureTypeName: () => "Животное", playerRank: 1, unitRank: 1, canAttack: true },
    factionRow: { raceMasks: [1, 0, 0, 0], classMasks: [0, 0, 0, 0], flags: [0, 0, 0, 0] }, factionName: "Штормград",
    canAssist: false,
    quests: {
      rows: [{ entry: { state: 0, counters: [2, 0, 0, 0] }, template: { title: "Волки", objectives: [{ slot: 0, entry: 299, count: 5, gameObject: false, text: "" }], itemObjectives: [] } }],
      creatureName: () => "Волк", itemName: () => undefined, itemCount: () => 0,
    },
  });
  assert.equal(facts.factionName, "Штормград");
  assert.equal(facts.leader, true);
  assert.equal(facts.pvp, true);
  assert.equal(facts.beastLore.length > 0, true);
  assert.equal(facts.quests.length, 1);
  const summoned = object(0xf130000012b000abn, 3, { OBJECT_FIELD_ENTRY: 299, UNIT_FIELD_SUMMONEDBY: 0x99n, UNIT_FIELD_HEALTH: 1 });
  assert.equal(frameXmlUnitTooltipFacts({ object: summoned, self: me, record: record(), level: { canAttack: false }, canAssist: false,
    quests: { rows: [], creatureName: () => undefined, itemName: () => undefined, itemCount: () => 0 } }).quests, undefined,
  "a player's summon: no quest rows");

  const booted = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "TooltipFonts.xml\nTooltip.lua",
      "interface/framexml/tooltipfonts.xml": `<Ui>
        <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
        <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
      </Ui>`,
      "interface/framexml/tooltip.lua": `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
${Object.entries(RU).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}
UNIT_SKINNABLE_LEATHER = "Можно снять шкуру"
MASTER_LOOTER = "Ответственный за добычу"
function UnitExists(unit) return unit == "target" end
function UnitName(unit) return "Волк" end
function UnitIsPlayer() return false end
function UnitIsDead() return Dead end
function UnitIsPVP() return false end
function GetCVarBool(name) return name == "showQuestTrackingTooltips" end
function IsThreatWarningEnabled() return true end
function UnitDetailedThreatSituation(unit, mob) return nil, 3, 100, 100, 5000 end
`,
    }),
    subset: ["TooltipFonts.xml", "Tooltip.lua"],
    exercise: false,
    gameTooltipAdapter: {
      inventoryItem: () => undefined, containerItem: () => undefined, item: () => undefined, spell: () => undefined,
      unitTooltipFacts: () => facts,
      unitSkinnable: () => ({ globalName: "UNIT_SKINNABLE_LEATHER", prefix: "", color: { r: 1, g: 1, b: 1 } }),
      unitLootOwners: () => [{ globalName: "MASTER_LOOTER", name: "Лидер" }],
    },
  });
  await booted.load();
  try {
    const run = (source, results = 0) => {
      const chunk = booted.vm.compileFunction(source, "@unit-tooltip-wow", []);
      try { return booted.vm.call(chunk, [], results); } finally { booted.vm.release(chunk); }
    };
    const lines = () => {
      const out = [];
      for (let index = 1; index <= run(`return GameTooltip:NumLines()`, 1)[0]; index++) out.push(booted.bridge.getFrame(`GameTooltipTextLeft${index}`)?.text);
      return out;
    };
    run(`Dead = true GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") GameTooltip:SetUnit("target")`);
    assert.deepEqual(lines(), [
      "Волк", "Животное 60-го уровня", "Штормград", "PvP", "Урон: 0", "Броня: 0", "Здоровье: 100", "Приручить нельзя",
      "Можно снять шкуру", "Лидер", "Волки", " - Волк – убито: 2/5", "Ответственный за добычу: Лидер", "100% уровень угрозы",
    ]);
    assert.deepEqual(booted.errors, []);
  } finally { booted.close(); }
});
