import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.12 (13.10) — what the tooltips still lacked, as Wow.exe 3.3.5a 12340 does it (read-only Ghidra,
// .runtime/re-2026-10-11/glue-1110/t1013-*.txt):
// * a stranger's summon: the creating spell's row is asked for and the owner line comes with it (0x0061e830);
//   the creature-type default reads a shapeshift form's type first (0x0071f300);
// * UnitReaction(unit, "player") is the unit's ReputationRank + 1 (0x007251c0) — the colour-blind standing line
//   names «Уважение», «Превознесение»…;
// * GameTooltip:SetTalent(…, isPreview): the preview rank, the preview requirements, the ADD/REMOVE hints
//   (0x00626e20 → 0x00622800 → 0x005c76e0);
// * the stat difference adds the item's passive spell auras (0x0061f350 → 0x0061b5e0) and a druid's feral
//   attack power (0x0061f410 → 0x0061a8f0).
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const {
  frameXmlUnitSummonTitle, frameXmlSummonSpellWait, frameXmlUnitPendingAnswers,
} = await import("../dist/code/browser/framexml/FrameXmlUnitTooltipExtras.js");
const { unitRankTowardsPlayer, unitReputationFaction, rankOfReaction } = await import("../dist/code/browser/game/UnitStandingRank.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { frameXmlTooltipExtrasAdapter, frameXmlItemSpellAuras } = await import("../dist/code/browser/framexml/FrameXmlTooltipExtrasAdapter.js");
const { FrameXmlTalentPreviewModel } = await import("../dist/code/browser/framexml/FrameXmlTalentPreview.js");
const {
  gameTooltipItemStats, gameTooltipStatTableKnown, gameTooltipFeralAttackPower,
} = await import("../dist/code/browser/glue/GlueTooltipStatDelta.js");
const { frameXmlQuestText } = await import("../dist/code/browser/framexml/FrameXmlQuestText.js");

const F = (name) => UPDATE_FIELDS[name].offset;
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

test("summon title: a row not loaded is asked for and waited on; the form's creature type decides the default", () => {
  const HUNTER = 0x20n;
  const hunter = object(HUNTER, 4, {});
  const pet = object(0xf130000123000040n, 3, { OBJECT_FIELD_ENTRY: 0x1230, UNIT_FIELD_CREATEDBY: HUNTER, UNIT_CREATED_BY_SPELL: 883 });
  const world = {
    state: { objects: new Map([[HUNTER, hunter], [pet.guid, pet]]) },
    names: { get: (guid) => guid === HUNTER ? "Охотник" : undefined },
    requestName() {},
    creatureTemplates: new Map([[0x1230, { found: true, name: "Волк", creatureType: 7 }]]),
  };
  const rows = new Map();
  const asked = [];
  const sources = { spellEffects: (id) => rows.get(id), requestSpell: (id) => asked.push(id) };
  assert.equal(frameXmlUnitSummonTitle(world, pet, sources), undefined, "no row yet: no guessed line");
  assert.deepEqual(asked, [883], "the row is asked for");
  const wait = frameXmlSummonSpellWait(pet, (id) => rows.has(id));
  assert.equal(typeof wait, "function");
  assert.equal(wait(), false);
  const ready = frameXmlUnitPendingAnswers({ ...world, guildNames: undefined }, pet, undefined, [wait]);
  assert.equal(ready(), false, "the tooltip waits");
  rows.set(883, [56, 0, 0]);
  assert.equal(wait(), true);
  assert.equal(ready(), true, "the row came: draw again");
  assert.equal(frameXmlSummonSpellWait(pet, (id) => rows.has(id)), undefined, "nothing to wait for any more");
  assert.equal(frameXmlSummonSpellWait(hunter, () => false), undefined, "no owner: no line, no wait");
  // Humanoid in the cache, a beast by its form: 0x0071f300 reads the form first.
  assert.deepEqual(frameXmlUnitSummonTitle(world, pet, sources), { globalName: "UNITNAME_SUMMON_TITLE3", ownerName: "Охотник" });
  assert.deepEqual(frameXmlUnitSummonTitle(world, pet, { ...sources, creatureTypeId: () => 1 }),
    { globalName: "UNITNAME_SUMMON_TITLE1", ownerName: "Охотник" });
  assert.equal(frameXmlUnitSummonTitle(world, pet, { ...sources, creatureTypeId: () => undefined })?.globalName,
    "UNITNAME_SUMMON_TITLE3", "no type table: the cache's type");
});

/** A world and faction client for the rank: Sons of Hodir-like reputation faction 1119, list id 79. */
function standingWorld({ standing = 9_000, forced = undefined, flags = 0, ready = true, contested = false } = {}) {
  const self = object(0x10n, 4, { UNIT_FIELD_FACTIONTEMPLATE: 1, UNIT_FIELD_BYTES_0: 1 | (1 << 8), PLAYER_FLAGS: contested ? 0x100 : 0 });
  const npc = object(0xf130000001000001n, 3, { UNIT_FIELD_FACTIONTEMPLATE: 2107 });
  const plain = object(0xf130000002000002n, 3, { UNIT_FIELD_FACTIONTEMPLATE: 14 });
  const sources = {
    world: {
      state: { selfGuid: self.guid, objects: new Map([[self.guid, self], [npc.guid, npc], [plain.guid, plain]]) },
      forcedReactions: forced,
      factions: new Map([[79, { standing, flags }]]),
    },
    factions: {
      ready,
      reputationCatalog: { factions: { 79: { factionId: 1119, raceMasks: [0, 0, 0, 0], classMasks: [0, 0, 0, 0], bases: [0, 0, 0, 0], flags: [0, 0, 0, 0] } } },
      factionOf: (template) => template === 2107 ? 1119 : template === 14 ? 14 : 1,
      templateFlagsOf: () => 0,
      reaction: (selfTemplate) => selfTemplate === 14 ? -1 : 0, // the masks: 14 hostile (REACTION_HOSTILE -1), else neutral (0)
      name: (listId) => listId === 79 ? "Сыновья Ходира" : undefined,
    },
  };
  return { self, npc, plain, sources };
}

test("rank: the unit's view of the player — the reputation rank, a forced rank, the masks", () => {
  const { npc, plain, sources } = standingWorld();
  assert.equal(unitRankTowardsPlayer(npc, sources), 5, "9000 standing: honored (5) — «Уважение»");
  assert.equal(unitRankTowardsPlayer(npc, standingWorld({ standing: 42_000 }).sources), 7, "exalted");
  assert.equal(unitRankTowardsPlayer(npc, standingWorld({ standing: -7_000 }).sources), 0, "hated");
  assert.equal(unitRankTowardsPlayer(npc, standingWorld({ forced: new Map([[1119, 6]]) }).sources), 6, "a forced rank first");
  assert.equal(unitRankTowardsPlayer(plain, sources), 1, "no reputation: the template reaction, hostile → 1");
  assert.equal(unitRankTowardsPlayer(npc, standingWorld({ ready: false }).sources), undefined, "no table: unknown");
  assert.deepEqual([rankOfReaction(-1), rankOfReaction(0), rankOfReaction(1)], [1, 3, 4]);
  const faction = unitReputationFaction(npc, sources);
  assert.equal(faction?.name, "Сыновья Ходира");
  assert.equal(faction?.row.factionId, 1119);
  assert.equal(unitReputationFaction(plain, sources), undefined, "a faction without a reputation");
});

test("UnitReaction(unit, \"player\") is the rank + 1 with the hook; the other direction keeps the template", () => {
  const { self, npc } = standingWorld();
  const world = { targetGuid: npc.guid, state: { selfGuid: self.guid, objects: new Map([[self.guid, self], [npc.guid, npc]]) } };
  const base = { world: () => world, spell: () => undefined, reaction: () => 0 }; // REACTION_NEUTRAL
  const plain = new LiveWorldSeam(base);
  assert.equal(plain.unitReaction("target", "player"), 4, "without the hook: the neutral template, 4");
  const ranked = new LiveWorldSeam({ ...base, unitRankToPlayer: () => 5 });
  assert.equal(ranked.unitReaction("target", "player"), 6, "honored: FACTION_STANDING_LABEL6 «Уважение»");
  assert.equal(ranked.unitReaction("player", "target"), 4, "the player's view is not the unit's");
  assert.equal(ranked.unitReaction("player", "player"), 5, "the player itself");
  const unknown = new LiveWorldSeam({ ...base, unitRankToPlayer: () => undefined });
  assert.equal(unknown.unitReaction("target", "player"), 4, "no rank yet: the template answer");
});

const cell = (index, id, tier, rank, maxRank, prerequisites = [], previewRank = rank) =>
  ({ index, id, tier, column: index, rank, maxRank, prerequisites, previewRank, meetsPrereq: true, meetsPreviewPrereq: true });
const talentData = {
  talentsIn: (tab) => tab === 161 ? [{ id: 10, ranks: [100, 101, 102] }, { id: 11, ranks: [200] }] : [],
  glyph: () => undefined,
};

test("talent preview: the preview rank and requirements, then the ADD/REMOVE hints by the preview rules", () => {
  let base = {
    activeTalentGroup: 1, unspentPoints: 2,
    groups: [{ group: 1, spec: 0, active: true, unspentPoints: 2, tabs: [{ index: 1, id: 161, name: "Оружие", pointsSpent: 4, previewPointsSpent: 0,
      talents: [cell(1, 10, 1, 1, 3), cell(2, 11, 2, 0, 1, [{ talentId: 10, requiredRank: 3, meetsPrereq: false, meetsPreviewPrereq: false }])] }] }],
  };
  const model = new FrameXmlTalentPreviewModel({ snapshot: () => base, packet: () => base, learn: () => {} });
  const seam = { talentSnapshot: () => model.apply(false, base), talentPreview: model };
  const adapter = frameXmlTooltipExtrasAdapter(seam, () => ({ talentData }), (id) => ({ title: `Т${id}` }));
  // Nothing previewed: rank 1, a point can be placed, none taken back (the learned rank is the floor).
  assert.deepEqual(adapter.talent(1, 1, false, false, undefined, true),
    { ranks: [100, 101, 102], rank: 1, requirements: [], previewAdd: true, previewRemove: false });
  model.add(1, 1, 1, false, undefined);
  assert.deepEqual(adapter.talent(1, 1, false, false, undefined, true),
    { ranks: [100, 101, 102], rank: 2, requirements: [], previewAdd: true, previewRemove: true }, "the preview rank 2");
  assert.deepEqual(adapter.talent(1, 1, false, false, undefined, false),
    { ranks: [100, 101, 102], rank: 1, requirements: [], learnable: true }, "without isPreview: the learned rank and LEARN");
  // Tier 2 needs 5 points: 4 learned + 1 previewed meets it (0x006224f0 adds both); the prerequisite at 3 does not.
  const second = adapter.talent(1, 2, false, false, undefined, true);
  assert.deepEqual(second?.requirements, [{ kind: "talent", rank: 3, name: "Т100" }], "the tier is met by the preview point");
  assert.equal(second?.previewAdd, undefined, "an unmet requirement: no hint");
  model.add(1, 1, 1, false, undefined); // rank 3 previewed, both free points used
  const third = adapter.talent(1, 1, false, false, undefined, true);
  assert.equal(third.previewAdd, false, "no free point left");
  assert.equal(third.previewRemove, true, "no previewed dependant, no higher tier holding points: removable");
});

const ITEM = (overrides = {}) => ({
  found: true, scalingStatValue: 0, stats: [], resistances: [0, 0, 0, 0, 0, 0, 0], block: 0,
  damage: [{ min: 0, max: 0 }, { min: 0, max: 0 }], delay: 0, sockets: [], ...overrides,
});
/** Table slot (1 + stat index) of an ITEM_MOD type: 11 + type. */
const statSlot = (type) => 1 + 11 + type;

test("item auras: the passive spells' APPLY_AURA effects by 0x0061b5e0, a missing row leaves the table unknown", () => {
  const rows = new Map([
    // MOD_RATING over hit (5) and crit (8) melee ratings, MOD_RESISTANCE fire+frost, MOD_TARGET_RESISTANCE -16.
    [1, { passive: true, effects: [6, 6, 6], effectAura: [189, 22, 123], effectMiscValue: [(1 << 5) | (1 << 8), (1 << 2) | (1 << 4), 126], effectBasePoints: [19, 9, -17] }],
    // MOD_POWER_REGEN mana (0), MOD_ATTACK_POWER, a non-aura effect.
    [2, { passive: true, effects: [6, 6, 3], effectAura: [85, 99, 0], effectMiscValue: [0, 0, 0], effectBasePoints: [4, 29, 99] }],
    // Not passive: an on-use spell adds nothing.
    [3, { passive: false, effects: [6, 0, 0], effectAura: [99, 0, 0], effectMiscValue: [0, 0, 0], effectBasePoints: [999, 0, 0] }],
  ]);
  const asked = [];
  const auras = frameXmlItemSpellAuras([{ spellId: 1 }, { spellId: 2 }, { spellId: 3 }, { spellId: 0 }], (id) => rows.get(id), (ids) => asked.push(...ids));
  assert.deepEqual(auras, [
    { aura: 189, misc: (1 << 5) | (1 << 8), basePoints: 19 }, { aura: 22, misc: (1 << 2) | (1 << 4), basePoints: 9 },
    { aura: 123, misc: 126, basePoints: -17 }, { aura: 85, misc: 0, basePoints: 4 }, { aura: 99, misc: 0, basePoints: 29 },
  ]);
  assert.deepEqual(asked, []);
  const table = gameTooltipItemStats(ITEM({ spellAuras: auras }));
  assert.equal(table[statSlot(16)], 20, "CR 5 (hit melee) → HIT_MELEE_RATING, BasePoints + 1");
  assert.equal(table[statSlot(19)], 20, "CR 8 (crit melee) → CRIT_MELEE_RATING");
  assert.deepEqual([table[1 + 2], table[1 + 4], table[1 + 3]], [10, 10, 0], "fire and frost resistance, not nature");
  assert.equal(table[1 + 58], 16, "spell penetration: −(BasePoints + 1)");
  assert.equal(table[1 + 61], 5, "POWER_REGEN0 (mana per 5) — not merged away: 54 stays 0");
  assert.equal(table[1 + 8], 30, "melee attack power");
  // A row that has not come: asked for, and the item gets no difference.
  const missing = frameXmlItemSpellAuras([{ spellId: 1 }, { spellId: 7 }], (id) => rows.get(id), (ids) => asked.push(...ids));
  assert.equal(missing, null);
  assert.deepEqual(asked, [7]);
  assert.equal(gameTooltipStatTableKnown(ITEM({ spellAuras: null }), "item:1"), false);
  assert.equal(gameTooltipStatTableKnown(ITEM({ spellAuras: [] }), "item:1"), true);
  assert.equal(frameXmlItemSpellAuras([{ spellId: 1 }], () => ({ passive: true, effects: [6, 0, 0] })), null, "an older row without the aura columns");
});

test("feral attack power: a druid's main-hand weapon above 54.81 DPS, (DPS − 54.81) · 14 + 0.5 floored", () => {
  // A 2.0 s staff (17) of 100-140 damage: 60 DPS → floor(5.19 · 14 + 0.5) = 73.
  const staff = ITEM({ itemClass: 2, inventoryType: 17, delay: 2000, damage: [{ min: 100, max: 140 }, { min: 0, max: 0 }] });
  assert.equal(gameTooltipFeralAttackPower(staff, 120), 73);
  assert.equal(gameTooltipFeralAttackPower({ ...staff, inventoryType: 15 }, 120), 0, "a bow (15): no main-hand bit");
  assert.equal(gameTooltipFeralAttackPower({ ...staff, itemClass: 4 }, 120), 0, "not a weapon");
  assert.equal(gameTooltipFeralAttackPower(staff, 109.62), 0, "54.81 DPS exactly: not above");
  const druid = gameTooltipItemStats(staff, true);
  assert.equal(druid[1 + 10], 73, "the feral slot (melee 0 here)");
  assert.equal(gameTooltipItemStats(staff, false)[1 + 10], 0, "not a druid");
  const apStaff = { ...staff, stats: [{ type: 38, value: 40 }] };
  assert.equal(gameTooltipItemStats(apStaff, true)[1 + 10], 113, "the feral power plus the weapon's melee attack power");
  // Melee attack power on the weapon goes into the feral slot too; equal slots clear the feral one (0x0061ba90).
  const withAp = ITEM({ itemClass: 4, inventoryType: 5, stats: [{ type: 38, value: 40 }] });
  assert.equal(gameTooltipItemStats(withAp, true)[1 + 10], 0, "feral = melee: cleared by the merge");
});

test("quest text: `$c`/`$r` lowered as _strlwr does — ASCII only", () => {
  const subject = { name: "Ann", className: "Warrior", raceName: "Night Elf", female: true };
  assert.equal(frameXmlQuestText("$C, $c; $R, $r.", subject), "Warrior, warrior; Night Elf, night elf.");
  assert.equal(frameXmlQuestText("$c / $r", { ...subject, className: "Жрица", raceName: "Эльфийка крови" }), "Жрица / Эльфийка крови",
    "Cyrillic keeps its capital");
});
