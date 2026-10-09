// Plan item 3.29 (L12, 04.10): the trainer's skill-line filter and «buy everything» as Wow.exe 3.3.5a 12340
// has them — GetTrainerSkillLines 0x594650, GetTrainerSkillLineFilter 0x593eb0, SetTrainerSkillLineFilter
// 0x596010 → 0x595010 → 0x594ba0, BuyTrainerService 0x595e60 → 0x594e50 / 0x594da0 (ClassTrainerFrame.cpp).
import assert from "node:assert/strict";
import test from "node:test";

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
