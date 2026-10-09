// Plan item 3.23: answers that were constants although the data is on the wire.
// B — UnitIsPVPFreeForAll (Wow.exe 0x60cfb0) and GetArmorPenetration (0x60e4e0 → 0x6de410, capped at 100).
// F — the trainer service's requirements (0x595470, 0x5945b0, 0x5955e0, 0x5952f0).
import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { CHARACTER_STAT_MAX_LEVEL, CHARACTER_STAT_MAX_RATING } = await import("../dist/code/world/CharacterStatData.js");
const {
  frameXmlTrainerSkillReq, frameXmlTrainerNumAbilityReq, frameXmlTrainerAbilityReq, frameXmlTrainerSkillLine,
} = await import("../dist/code/browser/framexml/FrameXmlTrainerRequirements.js");

const offset = (name) => UPDATE_FIELDS[name].offset;

function seamFixture({ characterStats } = {}) {
  const selfGuid = 0x10n;
  const targetGuid = 0x20n;
  const self = { guid: selfGuid, typeId: 4, fields: new Map([
    [offset("UNIT_FIELD_BYTES_0"), 1 | (1 << 8) | (1 << 24)], [offset("UNIT_FIELD_LEVEL"), 80],
  ]) };
  const target = { guid: targetGuid, typeId: 4, fields: new Map([[offset("UNIT_FIELD_BYTES_0"), 2 | (1 << 8)]]) };
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self], [targetGuid, target]]) },
    actionButtons: [], casts: new Map(), cooldownRemaining: () => 0, partyStats: new Map(), targetGuid,
    group: { groupType: 0, members: [{ guid: 0x30n, name: "Друг", status: 0x10 | 0x1, online: true }] },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined, monotonic: () => 1000,
    globalCooldownUntil: () => 0, castSpell: () => {}, targetGuid: () => targetGuid,
    ...(characterStats ? { characterStats: () => characterStats } : {}),
  });
  return { self, target, world, seam };
}

test("UnitIsPVPFreeForAll: UNIT_BYTE2_FLAG_FFA_PVP (0x04) of a unit in sight; a member out of sight by 0x10", () => {
  const { seam, target } = seamFixture();
  const ffa = (unit) => [...FRAMEXML_SEAM_BINDINGS.UnitIsPVPFreeForAll(seam, [unit])];
  assert.deepEqual(ffa("target"), [false]);
  target.fields.set(offset("UNIT_FIELD_BYTES_2"), 0x01 << 8);
  assert.deepEqual(ffa("target"), [false], "UNIT_BYTE2_FLAG_PVP is not the FFA bit");
  target.fields.set(offset("UNIT_FIELD_BYTES_2"), 0x04 << 8);
  assert.deepEqual(ffa("target"), [true]);
  target.fields.set(offset("UNIT_FIELD_BYTES_2"), 0x04);
  assert.deepEqual(ffa("target"), [false], "byte 0 is the sheath state, not the PvP byte");
  assert.deepEqual(ffa("party1"), [true], "an out-of-sight member answers MEMBER_STATUS_PVP_FFA");
  assert.deepEqual(ffa("focus"), [false]);
});

test("GetArmorPenetration is CR_ARMOR_PENETRATION's rating bonus, at most 100", () => {
  const perLevel = new Array(25 * CHARACTER_STAT_MAX_LEVEL).fill(0);
  perLevel[24 * CHARACTER_STAT_MAX_LEVEL + 79] = 4.69;
  const scalar = { [0 * CHARACTER_STAT_MAX_RATING + 25]: 1 };
  const { seam, self } = seamFixture({ characterStats: { spellCritBase: [], spellCritPerIntellect: [], combatRatingPerLevel: perLevel, combatRatingScalar: scalar } });
  const arp = () => FRAMEXML_SEAM_BINDINGS.GetArmorPenetration(seam, [])[0];
  assert.equal(arp(), 0);
  self.fields.set(offset("PLAYER_FIELD_COMBAT_RATING_1") + 24, 469);
  assert.ok(Math.abs(arp() - 100) < 1e-9, String(arp()));
  self.fields.set(offset("PLAYER_FIELD_COMBAT_RATING_1") + 24, 200);
  assert.ok(Math.abs(arp() - 200 / 4.69) < 1e-9, String(arp()));
  self.fields.set(offset("PLAYER_FIELD_COMBAT_RATING_1") + 24, 1400);
  assert.equal(arp(), 100, "capped at 100 as the client does");
});

function trainerSource(overrides = {}) {
  const spells = new Map([
    [100, { name: "Огненный шар", rank: "Уровень 1" }],
    [101, { name: "Чародейский интеллект", rank: "" }],
    [2018, { name: "Кузнечное дело", rank: "Подмастерье", effects: [44, 47, 0], effectMiscValue: [164, 0, 0] }],
    [3000, { name: "Жест", rank: "", effects: [6, 0, 0], effectMiscValue: [0, 0, 0] }],
    [3001, { name: "Урок", rank: "", effects: [36, 0, 0], effectMiscValue: [0, 0, 0] }],
  ]);
  return {
    skillLineName: (id) => ({ 164: "Кузнечное дело", 6: "Огонь", 43: "Мечи" })[id],
    playerSkills: () => [{ skillId: 164, value: 75 }],
    spell: (id) => spells.get(id),
    knowsSpell: (id) => id === 100,
    spellAbilities: (id) => (id === 3000 ? [
      { skillLine: 43, raceMask: 2, classMask: 0 },
      { skillLine: 6, raceMask: 0, classMask: 1 << 7 },
    ] : undefined),
    raceId: () => 1,
    classId: () => 8,
    ...overrides,
  };
}

const row = (fields) => ({ requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [0, 0, 0], spellId: 100, ...fields });

test("GetTrainerServiceSkillReq: the line's name, the rank and whether the player has it; none → nil, 0, 1", () => {
  const source = trainerSource();
  assert.deepEqual(frameXmlTrainerSkillReq(row({}), source), [undefined, 0, true]);
  assert.deepEqual(frameXmlTrainerSkillReq(row({ requiredSkillLine: 164, requiredSkillRank: 75 }), source), ["Кузнечное дело", 75, true]);
  assert.deepEqual(frameXmlTrainerSkillReq(row({ requiredSkillLine: 164, requiredSkillRank: 76 }), source), ["Кузнечное дело", 76, false]);
  assert.deepEqual(frameXmlTrainerSkillReq(row({ requiredSkillLine: 6, requiredSkillRank: 1 }), source), ["Огонь", 1, false]);
  assert.deepEqual(frameXmlTrainerSkillReq(undefined, source), [undefined, 0, true]);
});

test("GetTrainerServiceNumAbilityReq/AbilityReq: the set required spells, «name (rank)», known or not", () => {
  const source = trainerSource();
  const service = row({ requiredAbilities: [100, 0, 101] });
  assert.equal(frameXmlTrainerNumAbilityReq(service), 2);
  assert.equal(frameXmlTrainerNumAbilityReq(row({})), 0);
  assert.deepEqual(frameXmlTrainerAbilityReq(service, 1, source), ["Огненный шар (Уровень 1)", true]);
  assert.deepEqual(frameXmlTrainerAbilityReq(service, 3, source), ["Чародейский интеллект", false]);
  assert.equal(frameXmlTrainerAbilityReq(service, 2, source), undefined);
  assert.equal(frameXmlTrainerAbilityReq(service, 4, source), undefined);
});

test("GetTrainerServiceSkillLine: SKILL_STEP's line, else SkillLineAbility for the race and class; LEARN_SPELL unknown", () => {
  const source = trainerSource();
  assert.equal(frameXmlTrainerSkillLine(row({ spellId: 2018 }), source), "Кузнечное дело");
  assert.equal(frameXmlTrainerSkillLine(row({ spellId: 3000 }), source), "Огонь", "the orc-only row is skipped for a human mage");
  assert.equal(frameXmlTrainerSkillLine(row({ spellId: 3000 }), trainerSource({ raceId: () => 2, classId: () => 1 })), "Мечи");
  assert.equal(frameXmlTrainerSkillLine(row({ spellId: 3001 }), source), undefined, "the taught spell is not known here");
  assert.equal(frameXmlTrainerSkillLine(row({ spellId: 100 }), source), undefined, "no effects in the metadata");
});

test("the live seam's trainer bindings answer through the row", () => {
  const { world } = seamFixture();
  world.trainer = { guid: 1n, trainerType: 0, greeting: "", spells: [
    { spellId: 100, usable: 0, moneyCost: 10, pointCost: [0, 0], requiredLevel: 1, requiredSkillLine: 0, requiredSkillRank: 0, requiredAbilities: [101, 0, 0] },
  ] };
  world.knownSpells = [{ id: 101, slot: 0 }];
  const live = new LiveWorldSeam({
    world: () => world, store: () => undefined, monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
    spell: (id) => ({ 100: { id, name: "Огненный шар", rank: "Уровень 2" }, 101: { id, name: "Огненный шар", rank: "Уровень 1" } })[id],
  });
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetTrainerServiceNumAbilityReq(live, [1])], [1]);
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetTrainerServiceAbilityReq(live, [1, 1])], ["Огненный шар (Уровень 1)", true]);
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetTrainerServiceSkillReq(live, [1])], [undefined, 0, true]);
});
