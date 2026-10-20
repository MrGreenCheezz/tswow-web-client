import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

// Merged 2026-10-20 from 5 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-live-trainer-buy.test.mjs
{
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js",
);
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");

function spell(spellId, usable) {
  return {
    spellId, usable, moneyCost: 0, pointCost: [0, 0], requiredLevel: 0,
    requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [0, 0, 0],
  };
}

test("live Trainer C-API binding sends the selected visible spell ID through WorldClient", () => {
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); },
    close() {},
  });
  const guid = 0x123456789n;
  world.trainer = {
    guid, trainerType: 0, greeting: "Welcome",
    spells: [spell(100, 2), spell(200, 0), spell(300, 1), spell(400, 0)],
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: (id) => ({ id, name: `Spell ${id}`, rank: "", description: "", iconPath: "" }),
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  try {
    assert.deepEqual(call("GetTrainerServiceTypeFilter", "used"), [false],
      "the original Blizzard_TrainerUI hides learned services by default");
    assert.deepEqual(call("GetNumTrainerServices"), [3]);
    call("SetTrainerServiceTypeFilter", "used", true);
    assert.deepEqual(call("GetNumTrainerServices"), [4]);
    call("BuyTrainerService", 1);
    call("BuyTrainerService", 3);
    assert.equal(sent.length, 0, "known and unavailable rows cannot send training requests");

    call("SetTrainerServiceTypeFilter", "used", false);
    call("SetTrainerServiceTypeFilter", "unavailable", false);
    assert.deepEqual(call("GetNumTrainerServices"), [2]);
    assert.deepEqual(call("GetTrainerServiceInfo", 2), ["Spell 400", "", "available", true]);
    call("BuyTrainerService", 2);
    call("BuyTrainerService", 3);

    const buys = sent.filter(({ opcode }) => opcode === OPCODES.CMSG_TRAINER_BUY_SPELL);
    assert.equal(buys.length, 1, "only the selected available visible row is sent");
    const payload = new PacketReader(buys[0].payload);
    assert.equal(payload.u64(), guid);
    assert.equal(payload.i32(), 400, "the packet carries the spell ID, not the 1-based UI row");
    payload.assertFinished();
  } finally {
    world.close();
  }
});

test("12.10: a trainer service's description is written through the description writer (Wow.exe 0x005959d0)", () => {
  const world = new WorldClient({ send() {}, close() {} });
  world.trainer = { guid: 1n, trainerType: 0, greeting: "", spells: [spell(133, 0)] }; // 0: available, shown
  const fireball = {
    id: 133, name: "Огненный шар", rank: "", iconPath: "",
    description: "Наносит $s1 ед. урона от огня.",
    effectBasePoints: [13, 0, 0], effectDieSides: [9, 1, 0], effectPeriod: [0, 0, 0],
    effectChainTargets: [0, 0, 0], effectRadius: [0, 0, 0], duration: 0, maxDuration: 0, procChance: 100,
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: (id) => (id === 133 ? fireball : undefined),
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  try {
    const [text] = FRAMEXML_SEAM_BINDINGS.GetTrainerServiceDescription(seam, [1]);
    assert.ok(!text.includes("$"), text);
    assert.match(text, /^Наносит 14\D+22 ед\. урона от огня\.$/);
  } finally {
    world.close();
  }
});
}

// ── framexml-trainer-groups.test.mjs
{
// Plan item 3.29: the trainer's skill-line headers, collapsing and order as Wow.exe 3.3.5a 12340 builds
// them (ClassTrainerFrame.cpp: 0x596450, 0x594ba0, 0x5947d0, 0x5941b0, 0x594ae0, 0x595090, 0x596150,
// 0x5961f0; read 2026-10-02), over a live WorldClient; and the learn-effect table behind them (3.23F).

const { frameXmlTrainerDisplay, frameXmlTrainerDefaultSelection, FrameXmlTrainerList } =
  await import("../dist/code/browser/framexml/FrameXmlTrainerGroups.js");
const {
  frameXmlTrainerServiceGroup, frameXmlTrainerSkillLine, frameXmlTradeskillServiceGroup, TRADESKILL_SERVICE_GROUP_NAMES,
} = await import("../dist/code/browser/framexml/FrameXmlTrainerRequirements.js");
const { globalString, GLOBAL_STRING_DATA_AVAILABLE } = await import("../dist/code/generated/globalStrings.js");
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

// 3.24 (12.10): a profession trainer's groups — Wow.exe 0x596450 for a type-2 trainer: passive 3, SKILL_STEP 1,
// else 2 (a spell Spell.dbc lacks too); headers named by the GlobalStrings row at 0x00a13e08 + group * 0x40.
test("a trade skill trainer files a service by kind: passive 3, SKILL_STEP 1, anything else 2", () => {
  const source = {
    ...requirementSource(),
    spell: (id) => ({ 2018: { name: "Кузнечное дело", rank: "" }, 2660: { name: "Грубый точильный камень", rank: "" },
      9998: { name: "Знаток", rank: "", passive: true }, 5000: { name: "Ученик", rank: "" } })[id],
  };
  assert.equal(frameXmlTradeskillServiceGroup(2018, source), 1, "SKILL_STEP (44) in an effect");
  assert.equal(frameXmlTradeskillServiceGroup(2660, source), 2, "a recipe: neither effect");
  assert.equal(frameXmlTradeskillServiceGroup(5000, source), 2, "a learning spell (LEARN_SPELL) is not a step");
  assert.equal(frameXmlTradeskillServiceGroup(9998, source), 3, "passive before the effects");
  assert.equal(frameXmlTradeskillServiceGroup(424242, source), 2, "a spell with no row: 2, as Wow.exe");
  assert.equal(frameXmlTradeskillServiceGroup(2660, { ...source, learnEffects: () => undefined }), undefined,
    "no table and no effects on the row: not known yet");
  assert.deepEqual(TRADESKILL_SERVICE_GROUP_NAMES,
    ["", "TRADESKILL_SERVICE_STEP", "TRADESKILL_SERVICE_LEARN", "TRADESKILL_SERVICE_PASSIVE"]);
  // Groups by number; services by required skill rank, then name (0x593ce0, 0x5949a0) — not by level.
  const rows = [row(2660, 0, 30, { requiredSkillRank: 1 }), row(9998, 0), row(2018, 1, 1, { requiredSkillRank: 50 }),
    row(5000, 0, 40)];
  const names = { 2018: "Кузнечное дело", 2660: "Грубый точильный камень", 9998: "Знаток", 5000: "Ученик" };
  const display = frameXmlTrainerDisplay(rows, {
    tradeskill: true, state: (r) => STATES[r.usable], group: (r) => frameXmlTradeskillServiceGroup(r.spellId, source),
    groupName: (id) => ["", "Развитие", "Рецепты", "Пассивная"][id], name: (r) => names[r.spellId], rank: () => "",
    shown: () => true,
  }, new Set());
  assert.deepEqual(describe(display), ["[Развитие]", "2018", "[Рецепты]", "5000", "2660", "[Пассивная]", "9998"],
    "5000 (level 40, rank 0) before 2660 (level 30, rank 1)");
});

test("the live seam lists a profession trainer under the TRADESKILL_SERVICE headers", () => {
  const world = new WorldClient({ send() {}, close() {} });
  const selfGuid = 0x10n;
  world.state.selfGuid = selfGuid;
  world.state.objects.set(selfGuid, { guid: selfGuid, typeId: 4, fields: new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 | (1 << 8)], [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 20],
  ]) });
  world.trainer = {
    guid: 0x701n, trainerType: 2, greeting: "Кузня",
    spells: [row(2660, 0, 1, { requiredSkillRank: 5 }), row(9998, 0), row(2018, 0, 1, { pointCost: [0, 1] })],
  };
  const spells = {
    2018: { name: "Кузнечное дело", rank: "Ученик", passive: false },
    2660: { name: "Грубый точильный камень", rank: "", passive: false },
    9998: { name: "Знаток", rank: "", passive: true },
    133: { name: "Огненный шар", rank: "Уровень 1", passive: false },
  };
  const source = requirementSource();
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined,
    spell: (id) => (spells[id] ? { id, ...spells[id], description: "", iconPath: "" } : undefined),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    // No SkillLine metadata: a trade skill trainer's headers are GlobalStrings, its groups need only the effects.
    spellAbilities: (id) => source.spellAbilities(id),
    spellLearnEffects: () => EFFECTS,
  });
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  try {
    seam.trainerChanged("show");
    assert.deepEqual(call("IsTradeskillTrainer"), [true]);
    assert.deepEqual(call("GetNumTrainerServices"), [6]);
    const header = (name) => (GLOBAL_STRING_DATA_AVAILABLE ? globalString(name) : undefined) ?? "";
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((index) => call("GetTrainerServiceInfo", index).slice(0, 3)), [
      [header("TRADESKILL_SERVICE_STEP"), "", "header"], ["Кузнечное дело", "Ученик", "available"],
      [header("TRADESKILL_SERVICE_LEARN"), "", "header"], ["Грубый точильный камень", "", "available"],
      [header("TRADESKILL_SERVICE_PASSIVE"), "", "header"], ["Знаток", "", "available"],
    ]);
    assert.deepEqual(call("GetTrainerSelectionIndex"), [2], "the first available service: the step");
    assert.deepEqual(call("GetTrainerServiceCost", 2), [100, 0, 1]);
    if (GLOBAL_STRING_DATA_AVAILABLE) {
      assert.deepEqual([1, 3, 5].map((index) => call("GetTrainerServiceInfo", index)[0]),
        ["Развитие навыков", "Рецепты", "Пассивная"], "the client's own words (GlobalStrings.lua)");
    }
    // A class trainer next on the same seam needs SkillLine for its groups: without it, the flat list.
    world.trainer = { guid: 0x702n, trainerType: 0, greeting: "", spells: [row(133, 0, 1)] };
    seam.trainerChanged("show");
    assert.deepEqual(call("IsTradeskillTrainer"), [false]);
    assert.deepEqual(call("GetNumTrainerServices"), [1]);
    assert.deepEqual(call("GetTrainerServiceInfo", 1), ["Огненный шар", "Уровень 1", "available", true], "no header row");
  } finally {
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
}

// ── framexml-trainer-hidden-rows.test.mjs
{
// Plan item 3.29 (13.10): the trainer window's whole row array as Wow.exe 3.3.5a 12340 keeps it — hidden rows
// after the visible ones, reached by every index function (DAT_00c0e4a0), sorted by the CRT qsort 0x0040be50
// (VS2005) — and the collapse and line filter surviving everything but a new list (0x00596450 vs 0x00596b00).

const { frameXmlMsvcQsort } = await import("../dist/code/browser/framexml/FrameXmlMsvcQsort.js");
const { frameXmlTrainerSort, frameXmlTrainerSortedSelection } =
  await import("../dist/code/browser/framexml/FrameXmlTrainerSort.js");
const { FrameXmlTrainerList } = await import("../dist/code/browser/framexml/FrameXmlTrainerGroups.js");
const { FrameXmlTrainerListChanges } = await import("../dist/code/browser/framexml/FrameXmlTrainerListChange.js");
const { frameXmlTrainerBuyAll } = await import("../dist/code/browser/framexml/FrameXmlTrainerSkillLines.js");

const byKey = (a, b) => a.key - b.key;
const items = (keys) => [...keys].map((key, index) => ({ key: Number(key), name: String.fromCharCode(97 + index) }));
const names = (list) => list.map((item) => item.name).join("");

test("the VS2005 qsort: shortsort moves the first of equal maxima last; a 9-run partitions then shortsorts", () => {
  const three = items("000");
  frameXmlMsvcQsort(three, byKey);
  assert.equal(names(three), "bca", "selection of the maximum into the last place, from the left");
  const nine = items("101010101");
  frameXmlMsvcQsort(nine, byKey);
  assert.equal(names(nine), "bfdhegcai", "median of three, the partition walk, then shortsort of 0..7");
  const ten = items("0000000000");
  frameXmlMsvcQsort(ten, byKey);
  assert.equal(names(ten), "abcdefghij", "an all-equal run over 8 is left as it is");
  const even = items("1010101010");
  frameXmlMsvcQsort(even, byKey);
  assert.equal(names(even), "fbhdjgciae", "the middle of an even run is lo + size/2; the pivot follows its swap");
  for (let seed = 1; seed <= 40; seed += 1) {
    let state = seed * 2654435761 >>> 0;
    const random = Array.from({ length: 1 + (seed * 7) % 60 }, () => {
      state = (state * 1103515245 + 12345) >>> 0;
      return { key: state % 9, name: "" };
    });
    frameXmlMsvcQsort(random, byKey);
    for (let index = 1; index < random.length; index += 1) assert.ok(random[index - 1].key <= random[index].key, `seed ${seed}`);
  }
});

/** A mage's lines, as framexml-trainer.test.mjs has them. */
const LINES = { 8: "Огонь", 6: "Магия льда", 237: "Тайная магия" };
const SPELLS = {
  133: { name: "Огненный шар", rank: "Уровень 1", line: 8 },
  143: { name: "Огненный шар", rank: "Уровень 2", line: 8 },
  116: { name: "Ледяная стрела", rank: "Уровень 1", line: 6 },
  1459: { name: "Чародейский интеллект", rank: "Уровень 1", line: 237 },
};
function row(spellId, usable, requiredLevel = 1) {
  return { spellId, usable, moneyCost: 100, pointCost: [0, 0], requiredLevel, requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [0, 0, 0] };
}
function source(shown = [true, true, false]) {
  return {
    tradeskill: false,
    state: (r) => r.usable,
    group: (r) => SPELLS[r.spellId]?.line ?? 0,
    groupName: (id) => LINES[id],
    name: (r) => SPELLS[r.spellId].name,
    rank: (r) => SPELLS[r.spellId].rank,
    shown: (state) => shown[state],
  };
}
const describe = (entries) => entries.map((entry) => entry.header ? `[${entry.name}${entry.expanded ? "" : " +"}]` : `${entry.row.spellId}`);

test("the hidden rows stay after the visible ones in the qsort's order, not packet order", () => {
  const rows = [row(133, 0, 1), row(143, 0, 4), row(116, 0, 4), row(1459, 0, 1)];
  const sorted = frameXmlTrainerSort(rows, source(), new Set([8]));
  assert.equal(sorted.visible, 5);
  // Laid out 133 143 116 1459 [Магия льда] [Огонь] [Тайная магия]; shortsort of 7 leaves the collapsed
  // Огонь services reversed behind the visible rows.
  assert.deepEqual(describe(sorted.entries),
    ["[Магия льда]", "116", "[Огонь +]", "[Тайная магия]", "1459", "143", "133"]);
  assert.equal(frameXmlTrainerSortedSelection(sorted), 116);
  // A rebuild sorts the array as it stands (0x00594ba0): the same shortsort now puts them back.
  const again = frameXmlTrainerSort(rows, source(), new Set([8]), undefined, sorted.entries);
  assert.deepEqual(describe(again.entries).slice(5), ["133", "143"]);
  // Nothing visible available: the array's second element, hidden or not (0x00594ba0's tail).
  const none = frameXmlTrainerSort([row(133, 1, 1), row(143, 1, 4)], source(), new Set([8]));
  assert.deepEqual(describe(none.entries), ["[Огонь +]", "143", "133"]);
  assert.equal(frameXmlTrainerSortedSelection(none), 143);
});

test("an index past the visible rows reaches a hidden row; «everything» stops at the visible ones", () => {
  const rows = [row(133, 0, 1), row(143, 0, 4), row(116, 0, 4), row(1459, 0, 1)];
  const list = new FrameXmlTrainerList({ ...source(), rows: () => rows, describable: () => true, grouped: () => true });
  list.listChanged();
  assert.equal(list.setExpanded(3, false), true, "row 3 is the Огонь header");
  assert.equal(list.count(), 5, "GetNumTrainerServices: the visible rows");
  assert.deepEqual(list.info(6), ["Огненный шар", "Уровень 2", "available", true], "GetTrainerServiceInfo(6)");
  assert.equal(list.service(7)?.spellId, 133, "BuyTrainerService(7) and the cost/icon lookups reach 133");
  assert.equal(list.service(8), undefined, "past the whole array: nothing");
  list.select(6);
  assert.equal(list.selectionIndex(), 6, "SelectTrainerService reaches a hidden row too");
  const bought = [];
  frameXmlTrainerBuyAll(list.entries(), (id) => bought.push(id));
  assert.deepEqual(bought, [116, 1459], "BuyTrainerService(0): the visible available rows only");
});

test("a state change keeps the collapse, the line filter and the array's order; a new list resets them", () => {
  let rows = [row(133, 0, 1), row(143, 0, 4), row(116, 0, 4), row(1459, 0, 1)];
  const list = new FrameXmlTrainerList({ ...source(), rows: () => rows, describable: () => true, grouped: () => true });
  list.listChanged();
  list.setExpanded(3, false);
  assert.equal(list.setSkillLineFilter(2, false, false), true, "Тайная магия off");
  assert.deepEqual(describe(list.entries()), ["[Магия льда]", "116", "[Огонь +]"]);
  rows = [row(133, 0, 1), row(143, 0, 4), row(116, 2, 4), row(1459, 0, 1)]; // 116 learned: a new packet object
  list.stateChanged();
  assert.deepEqual(describe(list.entries()), ["[Огонь +]"], "116 used and filtered; Огонь still collapsed, the line still off");
  assert.equal(list.skillLineFilter(2), false);
  list.listChanged();
  assert.deepEqual(describe(list.entries()), ["[Огонь]", "133", "143", "[Тайная магия]", "1459"],
    "a new list: every line expanded and on");
});

test("WorldClient's callbacks: a purchase's answer changes no list, its refresh is a state change", () => {
  const changes = new FrameXmlTrainerListChanges();
  const first = { guid: 7n };
  assert.equal(changes.classify({ trainer: first }), "list");
  assert.equal(changes.classify({ trainer: first, merchantMessage: { error: false } }), "none", "BUY_SUCCEEDED");
  const refreshed = { guid: 7n };
  assert.equal(changes.classify({ trainer: refreshed }), "state", "the list WorldClient asked again");
  assert.equal(changes.classify({ trainer: refreshed, merchantMessage: { error: true } }), "none", "BUY_FAILED asks nothing");
  assert.equal(changes.classify({ trainer: { guid: 7n } }), "list", "a new talk to the same trainer");
  assert.equal(changes.classify({ trainer: { guid: 9n } }), "list", "another trainer");
  assert.equal(changes.classify({}), "list", "closed");
  assert.equal(changes.classify({}), "none");
});
}

// ── framexml-trainer-seam.test.mjs
{
const { CannedWorldSeam, CANNED_TRAINER } = await import(
  "../dist/code/browser/framexml/CannedWorldSeam.js",
);
const { LiveWorldSeam } = await import(
  "../dist/code/browser/framexml/LiveWorldSeam.js",
);
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js",
);

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} binding exists`);
  return [...binding(seam, args)];
}

function pump() {
  const events = [];
  return { events, now: () => 100, fire(event, ...args) { events.push([event, ...args]); return 1; } };
}

test("Canned Trainer projects packet rows and routes one available purchase", () => {
  const seam = new CannedWorldSeam();
  const worldPump = pump();
  seam.attach(worldPump);
  worldPump.events.length = 0;
  assert.equal(seam.openTrainer(), 1);
  assert.deepEqual(worldPump.events, [[FRAMEXML_SEAM_EVENTS.trainerUpdate]]);
  assert.deepEqual(api(seam, "GetTrainerServiceTypeFilter", "used"), [false],
    "the original Blizzard_TrainerUI starts with TRAINER_FILTER_USED = 0");
  assert.deepEqual(api(seam, "GetNumTrainerServices"), [2]);
  assert.deepEqual(api(seam, "GetTrainerServiceInfo", 2), ["Кровопускание", "", "unavailable", true]);
  api(seam, "SetTrainerServiceTypeFilter", "used", true);
  assert.deepEqual(api(seam, "GetNumTrainerServices"), [3]);
  assert.deepEqual(api(seam, "GetTrainerServiceInfo", 1), ["Рывок", "", "available", true]);
  assert.deepEqual(api(seam, "GetTrainerServiceInfo", 2), ["Удар героя", "", "used", true]);
  assert.deepEqual(api(seam, "GetTrainerServiceInfo", 3), ["Кровопускание", "", "unavailable", true]);
  assert.deepEqual(api(seam, "GetTrainerServiceCost", 1), [1250, 0, 0]);
  assert.deepEqual(api(seam, "GetTrainerServiceLevelReq", 1), [4]);
  assert.deepEqual(api(seam, "GetTrainerServiceIcon", 1), [CANNED_TRAINER.services[0].iconPath]);
  assert.deepEqual(api(seam, "GetTrainerServiceDescription", 1), [CANNED_TRAINER.services[0].description]);
  worldPump.events.length = 0;
  api(seam, "SelectTrainerService", 2);
  assert.deepEqual(api(seam, "GetTrainerSelectionIndex"), [2]);
  assert.deepEqual(worldPump.events, [], "selection command does not recursively publish a description event");
  api(seam, "BuyTrainerService", 1);
  api(seam, "BuyTrainerService", 2);
  assert.deepEqual(seam.trainerBuyRequests, [100]);
  api(seam, "SetTrainerServiceTypeFilter", "available", false);
  assert.deepEqual(api(seam, "GetNumTrainerServices"), [2]);
  assert.deepEqual(api(seam, "GetTrainerSelectionIndex"), [1], "filter selects the first visible service");
  seam.closeTrainer();
  assert.deepEqual(api(seam, "GetNumTrainerServices"), [0]);
  seam.detach();
});

test("3.24: trainer type 2 is the stock profession trainer — its rows, IsTradeskillTrainer and the free slots", () => {
  const tradeskill = { ...CANNED_TRAINER, trainerType: 2, freeProfessions: 1 };
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, tradeskill);
  seam.attach(pump());
  assert.equal(seam.openTrainer(), 1);
  assert.equal(seam.trainerType(), 2);
  assert.equal(seam.isTradeskillTrainer(), true);
  assert.deepEqual(api(seam, "IsTradeskillTrainer"), [true]);
  assert.deepEqual(api(seam, "GetNumTrainerServices"), [2]);
  assert.deepEqual(api(seam, "GetTrainerGreetingText"), [CANNED_TRAINER.greeting]);
  assert.deepEqual(api(seam, "UnitCharacterPoints", "player"), [0, 1], "the second word: free profession slots");
  assert.deepEqual(api(seam, "UnitCharacterPoints", "target"), [0, 0]);
  seam.closeTrainer();
  assert.deepEqual(api(seam, "GetNumTrainerServices"), [0]);
  seam.detach();

  const unknown = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, { ...CANNED_TRAINER, trainerType: 7 });
  unknown.attach(pump());
  assert.equal(unknown.openTrainer(), 0, "a type SMSG_TRAINER_LIST never carries stays native");
  assert.deepEqual(api(unknown, "GetNumTrainerServices"), [0]);
  unknown.detach();
});

test("3.24: stock ClassTrainerFrame answers every type SMSG_TRAINER_LIST carries — the profession trainer too", async () => {
  const { frameXmlStockTrainerType } = await import("../dist/code/browser/framexml/FrameXmlTrainerController.js");
  assert.deepEqual([0, 1, 2, 3].map(frameXmlStockTrainerType), [true, true, true, true]);
  assert.deepEqual([undefined, -1, 4, 7].map(frameXmlStockTrainerType), [false, false, false, false]);
});

test("trainer ownership controller is identity-safe and closes the published owner", async () => {
  const ownerModule = await import("../dist/code/browser/framexml/FrameXmlTrainerController.js");
  let disposed = 0;
  const owner = {
    isOpen: () => false, show() {}, hide() {}, close: () => true, refresh() {},
    dispose() { disposed += 1; },
  };
  const cleanup = ownerModule.publishFrameXmlTrainer(owner);
  try {
    assert.equal(ownerModule.frameXmlTrainerOpen(), false);
    assert.equal(ownerModule.closeFrameXmlTrainer(), true);
    const replacement = { isOpen: () => false, show() {}, hide() {}, close: () => false, refresh() {} };
    const replacementCleanup = ownerModule.publishFrameXmlTrainer(replacement);
    assert.equal(disposed, 1, "replacing a pending owner disposes the old owner");
    replacementCleanup();
  } finally {
    cleanup();
  }
  // Controller semantics are intentionally tested separately from the DOM/VM owner above:
  // publish is identity-safe and close is a no-op once it is absent.
  assert.equal(ownerModule.frameXmlTrainerOpen(), false);
  assert.equal(ownerModule.closeFrameXmlTrainer(), false);
});

test("trainer controller demotes identity-safely when a published owner throws", async () => {
  const ownerModule = await import("../dist/code/browser/framexml/FrameXmlTrainerController.js");
  let demoted = 0;
  const owner = {
    isOpen: () => true, show() {}, hide() {}, close: () => { throw new Error("close failed"); },
    refresh() { throw new Error("refresh failed"); }, demote() { demoted += 1; },
  };
  const cleanup = ownerModule.publishFrameXmlTrainer(owner);
  try {
    assert.equal(ownerModule.closeFrameXmlTrainer(), false);
    assert.equal(ownerModule.notifyFrameXmlTrainer("update"), false);
    assert.equal(demoted, 2);
  } finally {
    cleanup();
  }
});

test("lazy trainer owner keeps native panel pending, then hands off only after the gate", async () => {
  const node = () => {
    const value = {
      hidden: false, value: "", textContent: "", style: { setProperty() {}, removeProperty() {} },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      dataset: {}, children: [],
      addEventListener() {}, removeEventListener() {}, append() {}, appendChild() {},
      replaceChildren() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
      querySelector() { return node(); }, querySelectorAll() { return []; },
      getContext() { return { setTransform() {}, clearRect() {} }; },
    };
    return value;
  };
  const shared = node();
  globalThis.document = {
    head: shared, body: shared, documentElement: shared,
    createElement: node, getElementById: () => shared, querySelector: () => shared,
    querySelectorAll: () => [],
  };
  globalThis.window = {
    innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
    location: { protocol: "http:", hostname: "localhost" },
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  globalThis.location = globalThis.window.location;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const { createLazyFrameXmlTrainerOwner } = await import(
    "../dist/code/browser/framexml/FrameXmlWorldMount.js",
  );
  const seam = new CannedWorldSeam();
  seam.attach(pump());
  seam.openTrainer();
  const uiParent = { type: "Frame", name: "UIParent", children: [], visible: true };
  const root = {
    type: "Frame", name: "ClassTrainerFrame", named: true, parent: uiParent, children: [],
    attributes: {}, points: [], scriptSources: new Map(), registeredEvents: new Set([
      "TRAINER_UPDATE", "TRAINER_DESCRIPTION_UPDATE",
    ]), scripts: new Map([["OnLoad", () => {}], ["OnShow", () => {}], ["OnHide", () => {}], ["OnEvent", () => {}]]),
    visible: false,
  };
  const frames = new Map([["UIParent", uiParent], ["ClassTrainerFrame", root]]);
  for (let i = 1; i <= 11; i += 1) frames.set(`ClassTrainerSkill${i}`, {
    type: "Button", name: `ClassTrainerSkill${i}`, parent: root,
    scripts: new Map([["OnClick", () => {}]]),
  });
  for (const [name, type] of [
    ["ClassTrainerListScrollFrame", "ScrollFrame"], ["ClassTrainerDetailScrollFrame", "ScrollFrame"],
    ["ClassTrainerDetailScrollChildFrame", "Frame"], ["ClassTrainerSkillIcon", "Button"],
    ["ClassTrainerTrainButton", "Button"], ["ClassTrainerCancelButton", "Button"],
    ["ClassTrainerFrameCloseButton", "Button"], ["ClassTrainerNameText", "FontString"],
    ["ClassTrainerGreetingText", "FontString"],
  ]) frames.set(name, {
    type, name, parent: root,
    scripts: type === "Button" ? new Map([["OnClick", () => {}]]) : new Map(),
  });
  const wait = new Promise((resolve) => { globalThis.resolveTrainerLoad = resolve; });
  let loadCalls = 0;
  const boot = {
    bridge: {
      getFrame: (name) => frames.get(name),
      hasScript: (frame, name) => frame?.scripts?.has(name) === true,
      isVisible: (frame) => frame.visible === true,
      Show: (frame) => { frame.visible = true; return true; },
      Hide: (frame) => { frame.visible = false; return true; },
      dispatchEvent: () => 1,
    },
    vm: {
      globalFunction: () => ({}),
      call: () => [], release() {},
    },
    loadAddon: async () => { loadCalls += 1; return await wait; },
  };
  const renderer = {
    addRoots() {},
    sync() {},
    elementFor: (frame) => frame ? {
      getAttribute: (name) => name === "data-framexml-name" ? frame.name : name === "data-framexml-type" ? frame.type : null,
    } : undefined,
  };
  const owner = createLazyFrameXmlTrainerOwner(seam, boot, renderer);
  owner.show(); owner.show();
  assert.equal(loadCalls, 1);
  assert.equal(root.visible, false, "native fallback remains while LoD is pending");
  owner.hide();
  globalThis.resolveTrainerLoad({ ok: true, roots: [] });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(root.visible, false, "close before load prevents a late stock open");
  delete globalThis.resolveTrainerLoad;
  seam.detach();
});

async function trainerOwnerFixture({
  type = 0,
  loadResult = { ok: true, roots: [] },
  loadError = undefined,
  throwOnSync = false,
  throwOnCall = false,
  errorOnShow = false,
  errorOnCall = false,
  diagnosticOnShow = false,
  hideCloses = false,
} = {}) {
  const { createLazyFrameXmlTrainerOwner } = await import(
    "../dist/code/browser/framexml/FrameXmlWorldMount.js",
  );
  const { trainerWindow } = await import("../dist/code/browser/ui/Dom.js");
  trainerWindow.hidden = false;
  const seam = new CannedWorldSeam();
  seam.attach(pump());
  seam.openTrainer();
  let context = {};
  let listSignature = "trainer-1";
  seam.trainerType = () => type;
  seam.trainerContextSignature = () => listSignature;
  let closeCalls = 0;
  const close = seam.closeTrainer.bind(seam);
  seam.closeTrainer = () => { closeCalls += 1; close(); };
  const uiParent = { type: "Frame", name: "UIParent", children: [], visible: true };
  const root = {
    type: "Frame", name: "ClassTrainerFrame", named: true, parent: uiParent, children: [],
    attributes: {}, points: [], scriptSources: new Map(), registeredEvents: new Set([
      "TRAINER_UPDATE", "TRAINER_DESCRIPTION_UPDATE",
    ]), scripts: new Map([
      ["OnLoad", () => {}], ["OnShow", () => {}], ["OnHide", () => {}], ["OnEvent", () => {}],
    ]), visible: false,
  };
  const frames = new Map([["UIParent", uiParent], ["ClassTrainerFrame", root]]);
  for (let i = 1; i <= 11; i += 1) frames.set(`ClassTrainerSkill${i}`, {
    type: "Button", name: `ClassTrainerSkill${i}`, parent: root,
    scripts: new Map([["OnClick", () => {}]]),
  });
  for (const [name, frameType] of [
    ["ClassTrainerListScrollFrame", "ScrollFrame"], ["ClassTrainerDetailScrollFrame", "ScrollFrame"],
    ["ClassTrainerDetailScrollChildFrame", "Frame"], ["ClassTrainerSkillIcon", "Button"],
    ["ClassTrainerTrainButton", "Button"], ["ClassTrainerCancelButton", "Button"],
    ["ClassTrainerFrameCloseButton", "Button"],
  ]) frames.set(name, {
    type: frameType, name, parent: root,
    scripts: frameType === "Button" ? new Map([["OnClick", () => {}]]) : new Map(),
  });
  let resolveLoad;
  let rejectLoad;
  const loadPromise = new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; });
  let loadCalls = 0;
  let vmErrorCount = 0;
  const bridgeDiagnostics = [];
  const boot = {
    bridge: {
      diagnostics: bridgeDiagnostics,
      getFrame: (name) => frames.get(name),
      hasScript: (frame, name) => frame?.scripts?.has(name) === true,
      isVisible: (frame) => frame.visible === true,
      Show: (frame) => {
        if (errorOnShow) vmErrorCount += 1;
        if (diagnosticOnShow) bridgeDiagnostics.push({ scope: "script", message: "OnShow failed" });
        frame.visible = true;
        return true;
      },
      Hide: (frame) => {
        const changed = frame.visible === true;
        frame.visible = false;
        if (hideCloses && changed && frame === root) seam.closeTrainer();
        return true;
      },
      dispatchEvent: () => 1,
    },
    get errorCount() { return vmErrorCount; },
    vm: {
      globalFunction: () => ({}),
      call: () => {
        if (throwOnCall) throw new Error("stock call failed");
        if (errorOnCall) vmErrorCount += 1;
        return [];
      },
      release() {},
    },
    loadAddon: async () => {
      loadCalls += 1;
      if (loadError) throw loadError;
      return await loadPromise;
    },
  };
  let synced = false;
  let syncCalls = 0;
  const elements = new Map();
  const renderer = {
    addRoots() {},
    sync() {
      syncCalls += 1;
      if (throwOnSync) throw new Error("renderer sync failed");
      synced = true;
    },
    elementFor: (frame) => {
      if (!synced || !frame) return undefined;
      if (!elements.has(frame)) {
        const element = {
          parentElement: frame.parent ? renderer.elementFor(frame.parent) : undefined,
          getAttribute: (name) => name === "data-framexml-name" ? frame.name
            : name === "data-framexml-type" ? frame.type : null,
        };
        elements.set(frame, element);
      }
      return elements.get(frame);
    },
  };
  let nativeCalls = 0;
  let failureCalls = 0;
  let failureSawTrainer = false;
  const owner = createLazyFrameXmlTrainerOwner(
    seam, boot, renderer, () => {
      failureCalls += 1;
      failureSawTrainer = seam.trainerServiceCount() > 0;
    }, () => context,
    () => { nativeCalls += 1; trainerWindow.hidden = false; },
  );
  return {
    owner, seam, root, trainerWindow, boot, renderer,
    get loadCalls() { return loadCalls; }, get syncCalls() { return syncCalls; },
    get nativeCalls() { return nativeCalls; }, get failureCalls() { return failureCalls; },
    get failureSawTrainer() { return failureSawTrainer; },
    get closeCalls() { return closeCalls; },
    resolve: (value = loadResult) => resolveLoad(value), reject: (error) => rejectLoad(error),
    setContext: (value) => { context = value; }, setSignature: (value) => { listSignature = value; },
    setType: (value) => { type = value; },
    dispose: () => { owner.dispose?.(); seam.detach(); },
  };
}

const flushTrainerOwner = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test("trainer owner reconciles parented roots, coalesces pending load, and hands off once", async () => {
  const fixture = await trainerOwnerFixture();
  fixture.owner.show();
  fixture.owner.show();
  assert.equal(fixture.loadCalls, 1);
  assert.equal(fixture.nativeCalls, 1, "native fallback is shown before the async request");
  assert.equal(fixture.trainerWindow.hidden, false);
  assert.equal(fixture.root.visible, false);
  fixture.owner.refresh("update");
  assert.equal(fixture.nativeCalls, 2, "a pending update repaints the native current snapshot");
  fixture.resolve();
  await flushTrainerOwner();
  assert.equal(fixture.syncCalls, 1, "the parented root is reconciled before the gate");
  assert.equal(fixture.root.visible, true);
  assert.equal(fixture.trainerWindow.hidden, true);
  fixture.owner.close();
  fixture.dispose();
});

test("trainer owner pending close calls the seam once and closed refresh hides stock", async () => {
  const pending = await trainerOwnerFixture();
  pending.owner.show();
  assert.equal(pending.owner.close(), true);
  assert.equal(pending.closeCalls, 1);
  pending.resolve();
  await flushTrainerOwner();
  assert.equal(pending.root.visible, false);
  pending.owner.show();
  assert.equal(pending.nativeCalls, 2, "closed pending state permits a fresh native fallback");
  pending.owner.close();
  pending.dispose();

  const visible = await trainerOwnerFixture();
  visible.owner.show();
  visible.resolve();
  await flushTrainerOwner();
  assert.equal(visible.root.visible, true);
  visible.owner.refresh("closed");
  assert.equal(visible.root.visible, false);
  assert.equal(visible.closeCalls, 0, "event-driven close does not recurse through the seam");
  visible.dispose();
});

test("trainer owner demotes on failed/rejected/throwing load and leaves native visible", async () => {
  for (const options of [
    { loadResult: { ok: false, roots: [] } },
    { loadError: new Error("addon failed") },
    { throwOnSync: true },
    { throwOnCall: true, hideCloses: true },
    { errorOnShow: true },
    { errorOnCall: true },
    { diagnosticOnShow: true },
  ]) {
    const fixture = await trainerOwnerFixture(options);
    fixture.owner.show();
    fixture.resolve(options.loadResult);
    if (options.loadError) fixture.reject(options.loadError);
    await flushTrainerOwner();
    assert.equal(fixture.failureCalls, 1, `demotion option ${JSON.stringify(options)}`);
    assert.equal(fixture.failureSawTrainer, true,
      "demotion snapshots the trainer before a partially shown root can close it");
    assert.equal(fixture.nativeCalls, 1);
    assert.equal(fixture.trainerWindow.hidden, false);
    assert.equal(fixture.root.visible, false);
    fixture.dispose();
  }
});

test("trainer owner retargets stale world/list completions and never shows stale stock", async () => {
  const world = await trainerOwnerFixture();
  world.owner.show();
  world.setContext({ nextWorld: true });
  world.resolve();
  await flushTrainerOwner();
  assert.equal(world.root.visible, false);
  assert.equal(world.loadCalls, 2, "the current world gets a fresh coalesced attempt");
  world.owner.close();
  world.dispose();

  const list = await trainerOwnerFixture();
  list.owner.show();
  list.setSignature("trainer-2");
  list.owner.refresh("update");
  list.resolve();
  await flushTrainerOwner();
  assert.equal(list.root.visible, true, "update retargets the pending owner to the current list");
  assert.equal(list.loadCalls, 1);
  list.owner.refresh("closed");
  assert.equal(list.root.visible, false);
  list.dispose();
});

test("3.24: a profession trainer (type 2) loads stock ClassTrainerFrame and hands off after the gate", async () => {
  const profession = await trainerOwnerFixture({ type: 2 });
  profession.owner.show();
  assert.equal(profession.loadCalls, 1, "the profession trainer asks for Blizzard_TrainerUI");
  assert.equal(profession.nativeCalls, 1, "native stays the fallback while the add-on loads");
  profession.resolve();
  await flushTrainerOwner();
  assert.equal(profession.root.visible, true);
  assert.equal(profession.trainerWindow.hidden, true, "native steps aside only after the gate");
  assert.equal(profession.owner.close(), true);
  assert.equal(profession.root.visible, false);
  profession.dispose();
});

test("a trainer type SMSG_TRAINER_LIST never carries stays native, and a transition to it does not close it", async () => {
  const inert = await trainerOwnerFixture({ type: 7 });
  inert.owner.show();
  assert.equal(inert.loadCalls, 0);
  assert.equal(inert.owner.close(), false);
  inert.dispose();

  const fixture = await trainerOwnerFixture();
  fixture.owner.show();
  fixture.resolve();
  await flushTrainerOwner();
  assert.equal(fixture.root.visible, true);
  fixture.setType(7);
  fixture.owner.refresh("update");
  assert.equal(fixture.root.visible, false);
  assert.equal(fixture.closeCalls, 0);
  assert.equal(fixture.nativeCalls, 2);
  assert.equal(fixture.trainerWindow.hidden, false);
  fixture.dispose();
});

test("trainer ability prerequisites remain neutral when only raw ids are present", () => {
  const trainer = {
    ...CANNED_TRAINER,
    services: [{ ...CANNED_TRAINER.services[0], requiredAbilities: [12345, 0, 0] }],
  };
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, trainer);
  seam.attach(pump());
  seam.openTrainer();
  assert.deepEqual(api(seam, "GetTrainerServiceNumAbilityReq", 1), [0]);
  assert.deepEqual(api(seam, "GetTrainerServiceAbilityReq", 1, 1), []);
  seam.detach();
});

test("live trainer keeps raw ability prerequisites neutral and closes a profession trainer (3.24)", () => {
  let closeCalls = 0;
  const world = {
    trainer: {
      guid: 0x701n, trainerType: 2, greeting: "profession", spells: [{
        spellId: 100, usable: 0, moneyCost: 1, pointCost: [0, 0], requiredLevel: 1,
        requiredSkillLine: 171, requiredSkillRank: 75, requiredAbilities: [12345, 0, 0],
      }],
    },
    closeTrainer: () => { closeCalls += 1; },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    // Only the service's own spell is known; the required 12345 has no row.
    spell: (id) => (id === 100 ? { name: "Truthful spell", hidden: false } : undefined),
    monotonic: () => 1,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  // 3.24: the profession trainer's rows are stock's now (before the learn-effect table, the flat list).
  assert.equal(seam.trainerServiceCount(), 1);
  assert.equal(seam.trainerServiceNumAbilityReq(1), 1, "0x5945b0 counts the set slots");
  assert.equal(seam.trainerServiceAbilityReq(1, 1), undefined, "an unknown required spell is nil and nil (0x5955e0)");
  assert.equal(seam.isTradeskillTrainer(), true);
  assert.equal(seam.trainerGreeting(), "profession", "stock reads a profession trainer's greeting too");
  seam.closeTrainer();
  assert.equal(closeCalls, 1, "stock ClassTrainerFrame's OnHide closes a profession trainer as any other");
  world.trainer = { ...world.trainer, trainerType: 7 };
  seam.closeTrainer();
  assert.equal(closeCalls, 1, "a type the list never carries is left to the native window");
});
}

// ── framexml-trainer-skill-lines.test.mjs
{
// Plan item 3.29 (L12, 04.10): the trainer's skill-line filter and «buy everything» as Wow.exe 3.3.5a 12340
// has them — GetTrainerSkillLines 0x594650, GetTrainerSkillLineFilter 0x593eb0, SetTrainerSkillLineFilter
// 0x596010 → 0x595010 → 0x594ba0, BuyTrainerService 0x595e60 → 0x594e50 / 0x594da0 (ClassTrainerFrame.cpp).

const { FrameXmlTrainerList } = await import("../dist/code/browser/framexml/FrameXmlTrainerGroups.js");
const { FrameXmlTrainerLineFilter, TRAINER_LINE_FILTER_ALL } =
  await import("../dist/code/browser/framexml/FrameXmlTrainerSkillLines.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { spellLearnEffectsFrom } = await import("../dist/code/browser/SpellLearnEffectsClient.js");

function row(spellId, usable, requiredLevel = 1) {
  return {
    spellId, usable, moneyCost: 100, pointCost: [0, 0], requiredLevel,
    requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [0, 0, 0],
  };
}

/** A mage's lines, sorted by name: Магия льда (6), Огонь (8), Тайная магия (237). */
const LINES = { 8: "Огонь", 6: "Магия льда", 237: "Тайная магия" };
const SPELLS = {
  133: { name: "Огненный шар", rank: "Уровень 1", line: 8 },
  2136: { name: "Огненный взрыв", rank: "Уровень 1", line: 8 },
  116: { name: "Ледяная стрела", rank: "Уровень 1", line: 6 },
  1459: { name: "Чародейский интеллект", rank: "Уровень 1", line: 237 },
  1460: { name: "Чародейский интеллект", rank: "Уровень 2", line: 237 },
};

function list(rows, shown = [true, true, false]) {
  return new FrameXmlTrainerList({
    tradeskill: false,
    state: (r) => r.usable,
    group: (r) => SPELLS[r.spellId]?.line ?? 0,
    groupName: (id) => LINES[id],
    name: (r) => SPELLS[r.spellId].name,
    rank: (r) => SPELLS[r.spellId].rank,
    shown: (state) => shown[state],
    rows: () => rows,
    describable: () => true,
    grouped: () => true,
  });
}

const names = (trainer) => trainer.entries().map((entry) => entry.header ? `[${entry.name}]` : `${entry.row.spellId}`);

test("the mask: a bit per sorted line, cleared, set alone, every line; position 32 is position 0", () => {
  const filter = new FrameXmlTrainerLineFilter();
  assert.equal(filter.mask, TRAINER_LINE_FILTER_ALL);
  filter.set(1, false, false);
  assert.equal(filter.shown(1), false);
  assert.equal(filter.shown(0), true);
  assert.equal(filter.allShown(1), true, "only the first line counted");
  assert.equal(filter.allShown(2), false);
  filter.set(1, true, false);
  assert.equal(filter.mask, TRAINER_LINE_FILTER_ALL);
  filter.set(2, true, true);
  assert.equal(filter.mask, 4, "exclusive: that line alone");
  assert.equal(filter.shown(34), true, "1 << (34 & 31)");
  filter.set(-1, false, false);
  assert.equal(filter.mask, TRAINER_LINE_FILTER_ALL, "a negative position is every line, whatever the rest");
  filter.set(0, false, false);
  filter.reset();
  assert.equal(filter.mask, TRAINER_LINE_FILTER_ALL);
});

test("a line filtered out takes its header and services; the names keep every line; a new list turns all on", () => {
  // 116 used: hidden by the type filter, so Магия льда shows no header — but stays in GetTrainerSkillLines.
  const rows = [row(133, 0), row(2136, 1, 4), row(116, 2), row(1459, 0), row(1460, 0, 20)];
  const trainer = list(rows);
  trainer.listChanged();
  assert.deepEqual(names(trainer), ["[Огонь]", "133", "2136", "[Тайная магия]", "1459", "1460"]);
  assert.deepEqual(trainer.skillLineNames(), ["Магия льда", "Огонь", "Тайная магия"]);
  assert.equal(trainer.skillLineFilter(-1), true);
  assert.equal(trainer.skillLineFilter(2), true);
  assert.equal(trainer.skillLineFilter(3), undefined, "past the last line");
  assert.equal(trainer.selectionIndex(), 2, "Огненный шар");
  assert.equal(trainer.setSkillLineFilter(1, false, false), true, "Огонь off");
  assert.deepEqual(names(trainer), ["[Тайная магия]", "1459", "1460"]);
  assert.equal(trainer.selectionIndex(), 2, "the rebuild reselected: Чародейский интеллект 1");
  assert.equal(trainer.skillLineFilter(1), false);
  assert.equal(trainer.skillLineFilter(-1), false, "not every line on");
  assert.deepEqual(trainer.skillLineNames(), ["Магия льда", "Огонь", "Тайная магия"], "a hidden line keeps its name");
  assert.equal(trainer.setSkillLineFilter(0, true, true), true, "Магия льда alone");
  assert.deepEqual(names(trainer), [], "its one service is used and filtered by type");
  assert.equal(trainer.setSkillLineFilter(3, true, false), false, "past the last line changes nothing");
  assert.equal(trainer.setSkillLineFilter(-1, false, false), true, "every line");
  assert.equal(names(trainer).length, 6);
  trainer.setSkillLineFilter(2, false, false);
  trainer.listChanged();
  assert.equal(names(trainer).length, 6, "a new list (0x596450) turns every line on again");
});

const EFFECTS = spellLearnEffectsFrom({
  version: 2, skillRaceClass: [[8, 0, 1 << 7], [6, 0, 1 << 7], [237, 0, 1 << 7]], spells: [],
});

function liveFixture() {
  const sent = [];
  const world = new WorldClient({ send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); }, close() {} });
  const guid = 0x700n;
  world.trainer = {
    guid, trainerType: 0, greeting: "",
    spells: [row(1459, 0, 1), row(133, 0, 1), row(1460, 0, 20), row(116, 1, 4), row(2136, 2, 6)],
  };
  world.state.selfGuid = 0x10n;
  world.state.objects.set(0x10n, { guid: 0x10n, typeId: 4, fields: new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 | (8 << 8)], [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 20],
  ]) });
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined,
    spell: (id) => (SPELLS[id] ? { id, ...SPELLS[id], description: "", iconPath: "" } : undefined),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    skillMetadata: () => ({ skillLine: (id) => (LINES[id] ? { name: LINES[id] } : undefined) }),
    spellAbilities: (id) => (SPELLS[id]?.line ? [{ skillLine: SPELLS[id].line, raceMask: 0, classMask: 1 << 7 }] : []),
    spellLearnEffects: () => EFFECTS,
  });
  const fired = [];
  seam.attach({ now: () => 0, fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  const buys = () => sent.filter(({ opcode }) => opcode === OPCODES.CMSG_TRAINER_BUY_SPELL).map(({ payload }) => {
    const reader = new PacketReader(payload);
    assert.equal(reader.u64(), guid);
    const spellId = reader.i32();
    reader.assertFinished();
    return spellId;
  });
  seam.trainerChanged("show");
  return { world, seam, call, fired, buys, close: () => { seam.detach(); world.close(); } };
}

test("the stock C API: names, filter reads and writes, its errors, TRAINER_UPDATE", () => {
  const { call, fired, close } = liveFixture();
  try {
    assert.deepEqual(call("GetTrainerSkillLines"), ["Магия льда", "Огонь", "Тайная магия"]);
    assert.deepEqual(call("GetNumTrainerServices"), [7]);
    assert.deepEqual(call("GetTrainerSkillLineFilter", 0), [1]);
    fired.length = 0;
    call("SetTrainerSkillLineFilter", 2, 0);
    assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.trainerUpdate]]);
    assert.deepEqual(call("GetNumTrainerServices"), [5], "Огонь's header and Огненный шар are gone");
    assert.deepEqual(call("GetTrainerSkillLineFilter", 2), [undefined]);
    assert.deepEqual(call("GetTrainerSkillLineFilter", "1"), [1], "a numeric string is a number");
    assert.deepEqual(call("GetTrainerSkillLineFilter", 0), [undefined]);
    call("SetTrainerSkillLineFilter", 3, 1, 1);
    assert.deepEqual(call("GetTrainerServiceInfo", 1), ["Тайная магия", "", "header", true], "exclusive");
    assert.deepEqual(call("GetNumTrainerServices"), [3]);
    call("SetTrainerSkillLineFilter", 0);
    assert.deepEqual(call("GetNumTrainerServices"), [7], "0: every line, the rest unread");
    fired.length = 0;
    assert.throws(() => call("SetTrainerSkillLineFilter"), /^Error: Usage: SetTrainerSkillLineFilter\(index \[, on\\off, exclusive\]\)$/);
    assert.throws(() => call("SetTrainerSkillLineFilter", 4, 1), /^Error: Bad skill line in SetTrainerSkillLineFilter$/);
    assert.throws(() => call("SetTrainerSkillLineFilter", 4), /Bad skill line/, "the line is checked first");
    assert.throws(() => call("SetTrainerSkillLineFilter", 1), /^Error: Missing on\/\/off parameter in SetTrainerSkillLineFilter$/);
    assert.throws(() => call("SetTrainerSkillLineFilter", 1, true), /Missing on\/\/off/, "a boolean is not a number");
    assert.throws(() => call("GetTrainerSkillLineFilter"), /^Error: Usage: GetTrainerSkillLineFilter\(index\)$/);
    assert.throws(() => call("GetTrainerSkillLineFilter", 4), /^Error: Bad skill line in GetTrainerSkillLineFilter$/);
    assert.deepEqual(fired, [], "an error changes nothing");
    assert.deepEqual(call("GetNumTrainerServices"), [7]);
  } finally {
    close();
  }
});

test("BuyTrainerService(0) buys every visible available row in turn; nil is a usage error that buys nothing", () => {
  const { call, buys, close } = liveFixture();
  try {
    assert.throws(() => call("BuyTrainerService"), /^Error: Usage: BuyTrainerService\(index\)$/);
    assert.throws(() => call("BuyTrainerService", undefined), /Usage/);
    assert.throws(() => call("BuyTrainerService", "x"), /Usage/);
    assert.deepEqual(buys(), [], "slotOf's 0 is never «everything»");
    // Rows: [Магия льда], 116 (unavailable), [Огонь], 133, [Тайная магия], 1459, 1460; 2136 is used (hidden).
    call("BuyTrainerService", 0);
    assert.deepEqual(buys(), [133, 1459, 1460], "headers, unavailable and hidden rows buy nothing");
    call("SetTrainerSkillLineFilter", 2, 0);
    call("BuyTrainerService", -1.5);
    assert.deepEqual(buys().slice(3), [1459, 1460], "only what shows: Огонь is filtered out");
    call("BuyTrainerService", "3");
    assert.deepEqual(buys().slice(5), [], "row 3 of the filtered list is the Тайная магия header");
    call("BuyTrainerService", "4");
    assert.deepEqual(buys().slice(5), [1459], "row 4, a numeric string");
    call("BuyTrainerService", 2.9);
    assert.deepEqual(buys().slice(6), [], "row 2 is Ледяная стрела, unavailable (2.9 truncates to 2)");
    call("BuyTrainerService", 4.6);
    assert.deepEqual(buys().slice(6), [1459], "4.6 is row 4 (cvttsd2si), not row 5");
  } finally {
    close();
  }
});

test("the canned trainer with skill lines answers through the same list: headers, collapse, filter, buy all", async () => {
  const { CannedWorldSeam, CANNED_GROUPED_TRAINER, CANNED_TRAINER } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const grouped = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, CANNED_GROUPED_TRAINER);
  const fired = [];
  grouped.attach({ now: () => 0, fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  const call = (seam, name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  try {
    assert.deepEqual(call(grouped, "GetNumTrainerServices"), [0], "closed");
    grouped.openTrainer();
    const rows = () => Array.from({ length: call(grouped, "GetNumTrainerServices")[0] },
      (_, index) => call(grouped, "GetTrainerServiceInfo", index + 1).slice(0, 3).join("|"));
    assert.deepEqual(rows(), [
      "Защита||header", "Оборонительная стойка||available",
      "Неистовство||header", "Боевой крик|Уровень 1|available",
      "Оружие||header", "Рывок||available", "Кровопускание||unavailable",
    ], "lines by name, services by level; the used Удар героя is filtered");
    assert.deepEqual(call(grouped, "GetTrainerSkillLines"), ["Защита", "Неистовство", "Оружие"]);
    assert.deepEqual(call(grouped, "GetTrainerSelectionIndex"), [2]);
    assert.deepEqual(call(grouped, "GetTrainerServiceCost", 6), [1250, 0, 0], "row 6 is Рывок");
    call(grouped, "CollapseTrainerSkillLine", 5);
    assert.deepEqual(call(grouped, "GetTrainerServiceInfo", 5), ["Оружие", "", "header", false]);
    assert.deepEqual(call(grouped, "GetNumTrainerServices"), [5]);
    call(grouped, "ExpandTrainerSkillLine", 0);
    call(grouped, "SetTrainerSkillLineFilter", 1, 0);
    assert.deepEqual(rows().slice(0, 2), ["Неистовство||header", "Боевой крик|Уровень 1|available"]);
    call(grouped, "BuyTrainerService", 0);
    assert.deepEqual(grouped.trainerBuyRequests, [6673, 100], "every visible available row; Защита is filtered out");
    call(grouped, "BuyTrainerService", 1);
    assert.deepEqual(grouped.trainerBuyRequests, [6673, 100], "a header buys nothing");
    grouped.closeTrainer();
    grouped.openTrainer();
    assert.deepEqual(call(grouped, "GetNumTrainerServices"), [7], "a new list: every line on, every line open");
  } finally {
    grouped.detach();
  }
  // The flat canned trainer: «everything» is its visible available rows; no lines.
  const flat = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, CANNED_TRAINER);
  flat.attach({ now: () => 0, fire: () => 1 });
  try {
    flat.openTrainer();
    assert.deepEqual(call(flat, "GetTrainerSkillLines"), []);
    assert.throws(() => call(flat, "SetTrainerSkillLineFilter", 1, 1), /Bad skill line/);
    call(flat, "BuyTrainerService", 0);
    assert.deepEqual(flat.trainerBuyRequests, [100]);
  } finally {
    flat.detach();
  }
});
}
