import assert from "node:assert/strict";
import test from "node:test";

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { resolveFrameXmlSkillRows, createFrameXmlSkillResolvers } = await import(
  "../dist/code/browser/framexml/FrameXmlSkillResolver.js",
);

const base = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;

function playerWithSkills(entries) {
  const fields = new Map();
  for (const [slot, entry] of entries.entries()) {
    const at = base + slot * 3;
    fields.set(at, (entry.id & 0xffff) | ((entry.step & 0xffff) << 16));
    fields.set(at + 1, (entry.value & 0xffff) | ((entry.max & 0xffff) << 16));
    fields.set(at + 2, (entry.temporaryBonus & 0xffff) | ((entry.permanentBonus & 0xffff) << 16));
  }
  return { guid: 1n, typeId: 4, fields };
}

function talent(overrides = {}) {
  const lines = new Map([
    [164, { id: 164, name: "Кузнечное дело", categoryId: 11, iconId: 0 }],
    [186, { id: 186, name: "Горное дело", categoryId: 11, iconId: 0 }],
    [43, { id: 43, name: "Мечи", categoryId: 6, iconId: 0 }],
    [98, { id: 98, name: "Общий", categoryId: 10, iconId: 0 }],
    [999, { id: 999, name: "Не отображается", categoryId: 12, iconId: 0 }],
  ]);
  const categories = [
    { id: 6, name: "Оружие", orderIndex: 5 },
    { id: 12, name: "Не отображается", orderIndex: 8 },
    { id: 11, name: "Профессии", orderIndex: 3 },
    { id: 10, name: "Языки", orderIndex: 7 },
  ];
  return {
    ready: true,
    revision: 1,
    skillLine: (id) => lines.get(id),
    skillCategory: (id) => categories.find((category) => category.id === id),
    // Deliberately not in order: the resolver must use SortIndex, not transport/native order.
    skillCategories: () => categories,
    ...overrides,
  };
}

function world(player, revision = 1) {
  return { player, revision };
}

test("packed skill rows preserve base rank, signed bonuses and exact max rank", () => {
  const rows = resolveFrameXmlSkillRows(playerWithSkills(new Map([
    [0, { id: 164, step: 3, value: 412, max: 450, temporaryBonus: -5, permanentBonus: 10 }],
  ])), talent());

  assert.deepEqual(rows, [{
    kind: "header", id: 11, categoryId: 11, name: "Профессии",
  }, {
    kind: "skill", id: 164, skillId: 164, categoryId: 11, name: "Кузнечное дело",
    step: 3, skillRank: 412, numTempPoints: -5, skillModifier: 10, skillMaxRank: 450,
  }]);
  assert.equal(Object.isFrozen(rows), true);
  assert.equal(Object.isFrozen(rows[1]), true);
});

test("categories follow DBC SortIndex and skills use localized name then id", () => {
  const rows = resolveFrameXmlSkillRows(playerWithSkills(new Map([
    [0, { id: 186, step: 1, value: 100, max: 150, temporaryBonus: 0, permanentBonus: 0 }],
    [1, { id: 164, step: 1, value: 200, max: 300, temporaryBonus: 0, permanentBonus: 0 }],
    [2, { id: 43, step: 1, value: 50, max: 100, temporaryBonus: 0, permanentBonus: 0 }],
  ])), talent());

  assert.deepEqual(rows.map((row) => row.kind === "header" ? [row.kind, row.id] : [row.kind, row.id]), [
    ["header", 11], ["skill", 186], ["skill", 164], ["header", 6], ["skill", 43],
  ]);
});

test("unready or missing metadata is authoritative empty, and hidden/unknown rows are omitted", () => {
  const player = playerWithSkills(new Map([
    [0, { id: 164, step: 1, value: 1, max: 10, temporaryBonus: 0, permanentBonus: 0 }],
    [1, { id: 999, step: 1, value: 1, max: 10, temporaryBonus: 0, permanentBonus: 0 }],
    [2, { id: 12345, step: 1, value: 1, max: 10, temporaryBonus: 0, permanentBonus: 0 }],
  ]));
  assert.deepEqual(resolveFrameXmlSkillRows(player, { ...talent(), ready: false }), []);
  assert.deepEqual(resolveFrameXmlSkillRows(player, talent({
    skillCategory: () => undefined,
  })), []);
  assert.deepEqual(resolveFrameXmlSkillRows(player, talent()), [{
    kind: "header", id: 11, categoryId: 11, name: "Профессии",
  }, {
    kind: "skill", id: 164, skillId: 164, categoryId: 11, name: "Кузнечное дело",
    step: 1, skillRank: 1, numTempPoints: 0, skillModifier: 0, skillMaxRank: 10,
  }]);
});

test("cached snapshots refresh only when the player/world revision changes", () => {
  const player = playerWithSkills(new Map([
    [0, { id: 164, step: 1, value: 1, max: 10, temporaryBonus: 0, permanentBonus: 0 }],
  ]));
  let source = { world: world(player, 1), talent: talent() };
  const resolver = createFrameXmlSkillResolvers(() => ({
    player: source.world.player,
    playerRevision: source.world.revision,
    talent: source.talent,
  }));
  const first = resolver.skillRows();
  assert.equal(resolver.skillRows(), first);
  player.fields.set(base + 1, 2 | (10 << 16));
  assert.equal(resolver.skillRows(), first, "the caller must advance its world revision after a mutation");
  source = { ...source, world: world(player, 2) };
  const second = resolver.skillRows();
  assert.notEqual(second, first);
  assert.equal(second.find((row) => row.kind === "skill").skillRank, 2);
  source = { ...source, world: world(undefined, 3) };
  assert.deepEqual(resolver.skillRows(), []);
});
