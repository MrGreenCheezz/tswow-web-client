// Plan item 3.29: the trainer's skill-line headers, collapsing and order as Wow.exe 3.3.5a 12340 builds
// them (ClassTrainerFrame.cpp: 0x596450, 0x594ba0, 0x5947d0, 0x5941b0, 0x594ae0, 0x595090, 0x596150,
// 0x5961f0; read 2026-10-02), over a live WorldClient; and the learn-effect table behind them (3.23F).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const { frameXmlTrainerDisplay, frameXmlTrainerDefaultSelection, FrameXmlTrainerList } =
  await import("../dist/code/browser/framexml/FrameXmlTrainerGroups.js");
const { frameXmlTrainerServiceGroup, frameXmlTrainerSkillLine } =
  await import("../dist/code/browser/framexml/FrameXmlTrainerRequirements.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const {
  spellLearnEffectsFrom, SPELL_LEARN_EFFECTS_ROUTE_VERSION, SPELL_LEARN_EFFECTS_ROUTE_PATH,
} = await import("../dist/code/browser/SpellLearnEffectsClient.js");
const { SPELL_LEARN_EFFECTS_VERSION, loadSpellLearnEffects } = await import("../dist/code/gateway/SpellLearnEffectsMetadata.js");
const { CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");

const DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";

/** A trainer row as SMSG_TRAINER_LIST carries it. */
function row(spellId, usable, requiredLevel = 1, extra = {}) {
  return {
    spellId, usable, moneyCost: 100, pointCost: [0, 0], requiredLevel,
    requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [0, 0, 0], ...extra,
  };
}

/** A mage's lines: Огонь (8), Магия льда (6), Тайная магия (237). */
const LINES = { 8: "Огонь", 6: "Магия льда", 237: "Тайная магия" };
const SPELLS = {
  133: { name: "Огненный шар", rank: "Уровень 1", line: 8 },
  143: { name: "Огненный шар", rank: "Уровень 2", line: 8 },
  2136: { name: "Огненный взрыв", rank: "Уровень 1", line: 8 },
  116: { name: "Ледяная стрела", rank: "Уровень 1", line: 6 },
  1459: { name: "Чародейский интеллект", rank: "Уровень 1", line: 237 },
  // A learning spell: the trainer sells 5000, which teaches 1460 (Тайная магия).
  5000: { name: "Чародейский интеллект", rank: "Уровень 2" },
  1460: { name: "Чародейский интеллект", rank: "Уровень 2", line: 237 },
  // No SkillLineAbility row for the class: the client leaves it out.
  9999: { name: "Чужое", rank: "" },
};
const STATES = { 0: 0, 1: 1, 2: 2 };

function pureSource(shown = [true, true, false]) {
  return {
    tradeskill: false,
    state: (r) => STATES[r.usable],
    group: (r) => SPELLS[r.spellId]?.line ?? 0,
    groupName: (id) => LINES[id],
    name: (r) => SPELLS[r.spellId].name,
    rank: (r) => SPELLS[r.spellId].rank,
    shown: (state) => shown[state],
  };
}

const describe = (entries) => entries.map((entry) => entry.header
  ? `[${entry.name}${entry.expanded ? "" : " +"}]` : `${entry.row.spellId}`);

test("headers per skill line, sorted by name; services by level, then name and rank; filtered states hidden", () => {
  const rows = [row(143, 0, 4), row(116, 0, 4), row(133, 2, 1), row(2136, 1, 6), row(1459, 0, 1), row(9999, 0, 1)];
  assert.deepEqual(describe(frameXmlTrainerDisplay(rows, pureSource(), new Set())),
    ["[Магия льда]", "116", "[Огонь]", "143", "2136", "[Тайная магия]", "1459"],
    "the used Fireball 1 is filtered; the spell with no skill line is left out");
  assert.deepEqual(describe(frameXmlTrainerDisplay(rows, pureSource([true, true, true]), new Set())),
    ["[Магия льда]", "116", "[Огонь]", "133", "143", "2136", "[Тайная магия]", "1459"]);
  assert.deepEqual(describe(frameXmlTrainerDisplay(rows, pureSource([false, false, true]), new Set())),
    ["[Огонь]", "133"], "a line with nothing in a shown state has no header");
  assert.deepEqual(describe(frameXmlTrainerDisplay(rows, pureSource(), new Set([8]))),
    ["[Магия льда]", "116", "[Огонь +]", "[Тайная магия]", "1459"], "a collapsed line keeps its header");
});

test("same level: name, then rank; a line whose every service costs points goes after the others", () => {
  const rows = [row(143, 0, 4), row(133, 0, 4), row(116, 0, 4, { pointCost: [1, 0] }), row(2136, 0, 4)];
  assert.deepEqual(describe(frameXmlTrainerDisplay(rows, pureSource(), new Set())),
    ["[Огонь]", "2136", "133", "143", "[Магия льда]", "116"]);
});

test("the default selection is the first visible available service, else a service second row, else none", () => {
  const source = pureSource([true, true, true]);
  const entries = frameXmlTrainerDisplay([row(133, 2, 1), row(143, 1, 4), row(2136, 0, 6)], source, new Set());
  assert.equal(frameXmlTrainerDefaultSelection(entries), 2136);
  const none = frameXmlTrainerDisplay([row(133, 2, 1), row(143, 1, 4)], source, new Set());
  assert.equal(frameXmlTrainerDefaultSelection(none), 133, "no available service: the second row");
  assert.equal(frameXmlTrainerDefaultSelection([]), 0);
});

test("the list expands every line on a new list; Collapse/Expand take a header row, or all for 0", () => {
  const rows = [row(133, 0), row(116, 0), row(1459, 0)];
  const list = new FrameXmlTrainerList({ ...pureSource(), rows: () => rows, describable: () => true, grouped: () => true });
  list.listChanged();
  assert.deepEqual(list.info(1), ["Магия льда", "", "header", true]);
  assert.deepEqual(list.info(2), ["Ледяная стрела", "Уровень 1", "available", true]);
  assert.equal(list.selectionIndex(), 2);
  assert.equal(list.setExpanded(3, false), true, "row 3 is the Огонь header");
  assert.deepEqual(list.info(3), ["Огонь", "", "header", false]);
  assert.equal(list.count(), 5);
  assert.equal(list.setExpanded(2, false), false, "a service row is not a header");
  assert.equal(list.setExpanded(0, false), true);
  assert.equal(list.count(), 3, "every line collapsed: headers only");
  assert.equal(list.selectionIndex(), undefined, "no visible service left to select");
  list.listChanged();
  assert.equal(list.count(), 6, "a new list expands all again");
  list.select(1);
  assert.equal(list.selectionIndex(), undefined, "selecting a header selects nothing");
});

test("before the tables land the list stays the flat packet order, without headers", () => {
  const rows = [row(1459, 0), row(133, 0), row(116, 1)];
  const list = new FrameXmlTrainerList({ ...pureSource(), rows: () => rows, describable: () => true, grouped: () => false });
  assert.deepEqual(describe(list.entries()), ["1459", "133", "116"]);
});

/** The learn-effect answer the route serves: 5000 teaches 1460; 2018 is a SKILL_STEP for Кузнечное дело (164). */
const EFFECTS = spellLearnEffectsFrom({
  version: 2,
  // SkillRaceClassInfo: the three mage lines open to the mage (class 8) of every race.
  skillRaceClass: [[8, 0, 1 << 7], [6, 0, 1 << 7], [237, 0, 1 << 7], [164, 0, 0]],
  spells: [
    [5000, [[36, 1, 0, 1460], [0, 0, 0, 0], [0, 0, 0, 0]]],
    [5001, [[36, 5, 0, 1460], [0, 0, 0, 0], [0, 0, 0, 0]]],
    [2018, [[44, 1, 164, 0], [47, 1, 0, 0], [0, 0, 0, 0]]],
  ],
});

function requirementSource(learn = EFFECTS) {
  return {
    skillLineName: (id) => ({ ...LINES, 164: "Кузнечное дело" })[id],
    playerSkills: () => [],
    spell: (id) => SPELLS[id] ?? (id === 2018 || id === 5001 ? { name: "x", rank: "" } : undefined),
    knowsSpell: () => false,
    spellAbilities: (id) => (SPELLS[id]?.line ? [{ skillLine: SPELLS[id].line, raceMask: 0, classMask: 1 << 7 }] : []),
    raceId: () => 1,
    classId: () => 8,
    learnEffects: (id) => learn?.effects(id),
    skillAllowed: (line, race, klass) => learn?.skillAllowed(line, race, klass),
  };
}

test("the group is the taught spell's skill line for a LEARN_SPELL not aimed at the pet (0x594ae0)", () => {
  const source = requirementSource();
  assert.equal(frameXmlTrainerServiceGroup(133, source), 8);
  assert.equal(frameXmlTrainerServiceGroup(5000, source), 237, "5000 teaches 1460");
  assert.equal(frameXmlTrainerServiceGroup(5001, source), 0, "aimed at the pet: its own spell, which has no line");
  assert.equal(frameXmlTrainerServiceGroup(9999, source), 0);
  assert.equal(frameXmlTrainerServiceGroup(133, requirementSource(null)), undefined, "no table yet: unknown");
  // 3.23F with the table: GetTrainerServiceSkillLine follows the taught spell and SKILL_STEP's line.
  assert.equal(frameXmlTrainerSkillLine({ spellId: 5000, requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [] }, source), "Тайная магия");
  assert.equal(frameXmlTrainerSkillLine({ spellId: 2018, requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [] }, source), "Кузнечное дело");
  assert.equal(frameXmlTrainerSkillLine({ spellId: 133, requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [] }, source), "Огонь");
});

test("SkillRaceClassInfo and the exclude flags decide the SkillLineAbility row (0x812410: 0x810ed0, 0x810320)", () => {
  // The owner's HERO (class 13): a line SkillRaceClassInfo does not open to the class gives no group,
  // even when its SkillLineAbility row has no class mask (a talent's row).
  const hero = { ...requirementSource(), classId: () => 13,
    spellAbilities: (id) => (SPELLS[id]?.line ? [{ skillLine: SPELLS[id].line, raceMask: 0, classMask: 0 }] : []) };
  assert.equal(frameXmlTrainerServiceGroup(133, hero), 0, "Огонь is the mage's line only");
  assert.equal(frameXmlTrainerSkillLine({ spellId: 133, requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [] }, hero), undefined);
  assert.equal(frameXmlTrainerServiceGroup(133, { ...hero, classId: () => 8 }), 8, "the mage keeps it");
  assert.equal(frameXmlTrainerServiceGroup(133, { ...hero, skillAllowed: () => undefined }), 8,
    "without the table's answer nothing is filtered");
  // ExcludeRace/ExcludeClass are flags that invert their mask, not masks of their own.
  const masked = (row) => ({ ...requirementSource(), spellAbilities: (id) => (id === 133 ? [{ skillLine: 8, ...row }] : []) });
  assert.equal(frameXmlTrainerServiceGroup(133, masked({ raceMask: 1, classMask: 1 << 7, excludeRace: 1 })), 0,
    "human excluded: the mask inverted leaves race 1 out");
  assert.equal(frameXmlTrainerServiceGroup(133, masked({ raceMask: 2, classMask: 1 << 7, excludeRace: 1 })), 8,
    "an orc-only mask inverted lets the human in");
  assert.equal(frameXmlTrainerServiceGroup(133, masked({ raceMask: 0, classMask: 1, excludeClass: 1 })), 8,
    "warrior excluded: the mage passes");
});

test("the tables landing while a trainer is open regroup it once, and TRAINER_UPDATE repaints the rows", () => {
  let grouped = false;
  const rows = [row(133, 0), row(116, 0)];
  const list = new FrameXmlTrainerList({ ...pureSource(), rows: () => rows, describable: () => true, grouped: () => grouped });
  assert.equal(list.groupingChanged(), false, "nothing built yet");
  list.listChanged();
  assert.deepEqual(describe(list.entries()), ["133", "116"]);
  assert.equal(list.groupingChanged(), false);
  grouped = true;
  assert.equal(list.groupingChanged(), true, "the indexes stock holds are stale now");
  assert.equal(list.groupingChanged(), false, "said once");
  assert.deepEqual(describe(list.entries()), ["[Магия льда]", "116", "[Огонь]", "133"]);
  assert.equal(list.selectionIndex(), 4, "the selection is a spell: it follows its row");
});

function liveFixture({ effects = EFFECTS } = {}) {
  const holder = { table: effects ?? undefined };
  const sent = [];
  const world = new WorldClient({ send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); }, close() {} });
  const guid = 0x700n;
  world.trainer = {
    guid, trainerType: 0, greeting: "Чему научить?",
    spells: [row(1459, 0, 1), row(133, 0, 1), row(5000, 0, 14), row(116, 1, 4), row(9999, 0, 1)],
  };
  const selfGuid = 0x10n;
  world.state.selfGuid = selfGuid;
  world.state.objects.set(selfGuid, { guid: selfGuid, typeId: 4, fields: new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 | (8 << 8)], [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 20],
  ]) });
  const source = requirementSource(effects);
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined,
    spell: (id) => (SPELLS[id] ? { id, ...SPELLS[id], description: "", iconPath: "" } : undefined),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    skillMetadata: () => ({ skillLine: (id) => (source.skillLineName(id) ? { name: source.skillLineName(id) } : undefined) }),
    spellAbilities: (id) => source.spellAbilities(id),
    spellLearnEffects: () => holder.table,
  });
  const fired = [];
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  return { world, seam, sent, call, fired, guid, holder };
}

test("the live seam lists headers, collapses a line and buys the spell of the row shown", () => {
  const { world, seam, sent, call, fired, guid } = liveFixture();
  seam.attach({ now: () => 0, fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  try {
    seam.trainerChanged("show");
    assert.deepEqual(call("GetNumTrainerServices"), [7]);
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((index) => call("GetTrainerServiceInfo", index)[0]),
      ["Магия льда", "Ледяная стрела", "Огонь", "Огненный шар", "Тайная магия", "Чародейский интеллект"],
      "the services the line sorts first; 5000 (level 14) after 1459 in Тайная магия");
    assert.deepEqual(call("GetTrainerServiceInfo", 7), ["Чародейский интеллект", "Уровень 2", "available", true]);
    assert.deepEqual(call("GetTrainerSelectionIndex"), [4], "the first available service: Огненный шар");
    fired.length = 0;
    call("CollapseTrainerSkillLine", 3);
    assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.trainerUpdate]]);
    assert.deepEqual(call("GetNumTrainerServices"), [6]);
    assert.deepEqual(call("GetTrainerServiceInfo", 3), ["Огонь", "", "header", false]);
    const buysOf = () => sent.filter(({ opcode }) => opcode === OPCODES.CMSG_TRAINER_BUY_SPELL);
    call("BuyTrainerService", 3);
    assert.equal(buysOf().length, 0, "a header buys nothing");
    call("BuyTrainerService", 6);
    const buys = buysOf();
    assert.equal(buys.length, 1);
    const payload = new PacketReader(buys[0].payload);
    assert.equal(payload.u64(), guid);
    assert.equal(payload.i32(), 5000, "row 6 is the learning spell, not the 6th packet row");
    payload.assertFinished();
    call("ExpandTrainerSkillLine", 3);
    assert.deepEqual(call("GetNumTrainerServices"), [7]);
  } finally {
    seam.detach();
    world.close();
  }
});

test("without the learn-effect table the live trainer stays the flat list", () => {
  const { world, seam, call } = liveFixture({ effects: null });
  try {
    seam.trainerChanged("show");
    assert.deepEqual(call("GetNumTrainerServices"), [5], "every described row, packet order, no headers");
    assert.deepEqual(call("GetTrainerServiceInfo", 1), ["Чародейский интеллект", "Уровень 1", "available", true]);
  } finally {
    world.close();
  }
});

test("the live seam repaints an open trainer when the learn-effect table lands (tick)", () => {
  const { world, seam, call, fired, holder } = liveFixture({ effects: null });
  seam.attach({ now: () => 0, fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  try {
    seam.trainerChanged("show");
    assert.deepEqual(call("GetNumTrainerServices"), [5]);
    seam.tick(1);
    fired.length = 0;
    seam.tick(2);
    assert.equal(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.trainerUpdate).length, 0, "no change, no event");
    holder.table = EFFECTS;
    seam.tick(3);
    assert.equal(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.trainerUpdate).length, 1, "regrouped: stock repaints");
    assert.deepEqual(call("GetNumTrainerServices"), [7]);
    seam.tick(4);
    assert.equal(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.trainerUpdate).length, 1, "once");
  } finally {
    seam.detach();
    world.close();
  }
});

test("the route's version, path and validator agree with the gateway", { skip: !existsSync(DBC) && "no dataset DBC directory" }, async () => {
  assert.equal(SPELL_LEARN_EFFECTS_ROUTE_VERSION, SPELL_LEARN_EFFECTS_VERSION);
  assert.equal(SPELL_LEARN_EFFECTS_ROUTE_PATH, "/dbc/spell-learn-effects?v=2");
  assert.equal(CATALOG_ROUTES.find((route) => route.pathname === "/dbc/spell-learn-effects")?.version, SPELL_LEARN_EFFECTS_VERSION);
  assert.equal(spellLearnEffectsFrom({ version: 1, spells: [], skillRaceClass: [] }), undefined);
  assert.equal(spellLearnEffectsFrom({ version: 2, spells: [] }), undefined, "v2 carries SkillRaceClassInfo");
  assert.equal(spellLearnEffectsFrom({ version: 2, skillRaceClass: [], spells: [[1, [[36, 0, 0]]]] }), undefined, "three effects of four words");
  const catalog = await loadSpellLearnEffects(DBC);
  const table = spellLearnEffectsFrom(JSON.parse(JSON.stringify(catalog)));
  assert.ok(table);
  assert.ok(catalog.spells.length > 500 && catalog.spells.length < 2000, `rows: ${catalog.spells.length}`);
  assert.ok(catalog.spells.every(([, effects]) => effects.some(([effect]) => effect === 36 || effect === 44)));
  // Every SKILL_STEP names a skill line; every LEARN_SPELL teaches a spell.
  const step = catalog.spells.find(([, effects]) => effects.some(([effect]) => effect === 44));
  assert.ok(step && table.effects(step[0]).some((effect) => effect.effect === 44 && effect.miscValue > 0));
  const taught = catalog.spells.filter(([, effects]) => effects.some(([effect, , , trigger]) => effect === 36 && trigger > 0));
  assert.ok(taught.length > 300, `learning spells with a taught spell: ${taught.length}`);
  assert.ok(table.effects(taught[0][0]).some((effect) => effect.effect === 36 && effect.triggerSpell > 0));
  assert.deepEqual(table.effects(133), [], "Fireball has neither effect");
  // SkillRaceClassInfo (0x810ed0): the owner's HERO (class 13) human has Верховая езда (762), not the
  // mage's Тайная магия (237), which the mage keeps.
  assert.ok(catalog.skillRaceClass.length > 100 && catalog.skillRaceClass.length < 2000, `SRCI rows: ${catalog.skillRaceClass.length}`);
  assert.equal(table.skillAllowed(762, 1, 13), true);
  assert.equal(table.skillAllowed(237, 1, 13), false);
  assert.equal(table.skillAllowed(237, 1, 8), true);
  assert.equal(table.skillAllowed(999_999, 1, 8), false, "a line with no row is open to nobody");
});
