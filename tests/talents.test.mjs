import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  MAX_TALENT_RANK, learnedInTab, nextRankRequest, pointsInTree, prerequisitesMet, talentArrows,
  talentTreeState, tierRequirement, treeHeight,
} from "../dist/code/browser/ui/TalentTree.js";
import {
  PLAYER_MAX_SKILLS, SKILL_CATEGORY_PROFESSION, effectiveSkill, readSkills,
} from "../dist/code/browser/ui/Skills.js";
import { buildLearnPetTalents, buildRemoveGlyph } from "../dist/code/world/CharacterProgressProtocol.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

/** Two talents in one tree: the second needs three points in the first. */
const ROOT = { id: 1, tabId: 10, tier: 0, column: 0, ranks: [101, 102, 103, 104, 105], prerequisites: [] };
const TIER1 = { id: 2, tabId: 10, tier: 1, column: 1, ranks: [201, 202], prerequisites: [] };
const CHILD = { id: 3, tabId: 10, tier: 1, column: 0, ranks: [301], prerequisites: [{ talentId: 1, rank: 3 }] };
/** A second talent on the free row, so the tree can reach five points without filling ROOT. */
const FILLER = { id: 4, tabId: 10, tier: 0, column: 2, ranks: [401, 402, 403], prerequisites: [] };
const TREE = [ROOT, TIER1, CHILD, FILLER];

test("a tier needs five points per tier below it, in that tree and no other", () => {
  assert.equal(MAX_TALENT_RANK, 5);
  assert.equal(tierRequirement(0), 0, "the first row is free");
  assert.equal(tierRequirement(1), 5);
  assert.equal(tierRequirement(3), 15);

  const empty = talentTreeState(TREE, new Map(), 10);
  assert.equal(empty.find((cell) => cell.talent.id === ROOT.id).available, true);
  assert.equal(empty.find((cell) => cell.talent.id === TIER1.id).blockedBy, "tier");

  // Four points is one short; the fifth opens the row.
  const four = talentTreeState(TREE, new Map([[ROOT.id, 4]]), 10);
  assert.equal(four.find((cell) => cell.talent.id === TIER1.id).blockedBy, "tier");
  const five = talentTreeState(TREE, new Map([[ROOT.id, 5]]), 10);
  assert.equal(five.find((cell) => cell.talent.id === TIER1.id).available, true);
});

test("a prerequisite is a rank, not a tick, and only the first one is enforced", () => {
  assert.equal(prerequisitesMet(CHILD, new Map([[ROOT.id, 2]])), false);
  assert.equal(prerequisitesMet(CHILD, new Map([[ROOT.id, 3]])), true);
  assert.equal(prerequisitesMet(CHILD, new Map([[ROOT.id, 5]])), true, "more than enough is enough");
  assert.equal(prerequisitesMet(ROOT, new Map()), true, "no prerequisite is no obstacle");

  // The core reads `talentInfo->PrereqTalent` as a scalar, so a second entry is never checked.
  const twoPrereqs = { ...CHILD, prerequisites: [{ talentId: 1, rank: 1 }, { talentId: 99, rank: 5 }] };
  assert.equal(prerequisitesMet(twoPrereqs, new Map([[ROOT.id, 1]])), true);
});

test("a talent with no points left is blocked for a different reason than a shut tier", () => {
  // The two lead a player to do different things, so they are not folded into one "unavailable".
  const noPoints = talentTreeState(TREE, new Map([[ROOT.id, 5]]), 0);
  assert.equal(noPoints.find((cell) => cell.talent.id === TIER1.id).blockedBy, "points");

  const maxed = talentTreeState(TREE, new Map([[ROOT.id, 5]]), 4);
  assert.equal(maxed.find((cell) => cell.talent.id === ROOT.id).blockedBy, "maxed");
  assert.equal(maxed.find((cell) => cell.talent.id === CHILD.id).available, true, "five points is past its three");

  // Five points in the tree but only two in the talent the child depends on: the row is open and
  // the child still is not, which is the case a single "unavailable" would hide.
  const short = talentTreeState(TREE, new Map([[ROOT.id, 2], [FILLER.id, 3]]), 4);
  assert.equal(short.find((cell) => cell.talent.id === TIER1.id).available, true);
  assert.equal(short.find((cell) => cell.talent.id === CHILD.id).blockedBy, "prerequisite");
});

test("points are counted per tree, and a rank past the talent's own does not inflate it", () => {
  assert.equal(pointsInTree(TREE, new Map([[ROOT.id, 3], [TIER1.id, 2]])), 5);
  // A stale rank for a talent that lost ranks must not add points that are not there.
  assert.equal(pointsInTree(TREE, new Map([[CHILD.id, 9]])), 1, "CHILD has one rank, so it is worth one");
  assert.equal(pointsInTree(TREE, new Map([[999, 5]])), 0, "a talent from another tree counts for nothing");

  const inTab = learnedInTab(TREE, new Map([[ROOT.id, 2], [999, 5], [TIER1.id, 0]]));
  assert.deepEqual([...inTab], [[ROOT.id, 2]], "and a rank of zero is not a learned talent");
});

test("arrows come from the first prerequisite only, and light up when it is met", () => {
  const dark = talentArrows(TREE, new Map([[ROOT.id, 1]]));
  assert.equal(dark.length, 1);
  assert.deepEqual(dark[0].from, { tier: 0, column: 0 });
  assert.deepEqual(dark[0].to, { tier: 1, column: 0 });
  assert.equal(dark[0].satisfied, false);

  const lit = talentArrows(TREE, new Map([[ROOT.id, 3]]));
  assert.equal(lit[0].satisfied, true);

  // A prerequisite in another tab has nowhere on this grid to start from, so no arrow is drawn.
  const foreign = talentArrows([{ ...CHILD, prerequisites: [{ talentId: 500, rank: 1 }] }], new Map());
  assert.deepEqual(foreign, []);
});

test("the grid is as tall as the tree, not as tall as the tallest tree in the game", () => {
  assert.equal(treeHeight(TREE), 2);
  assert.equal(treeHeight([]), 0);
  assert.equal(treeHeight([{ ...ROOT, tier: 6 }]), 7);
});

test("the rank asked for counts from one, because everything above the wire does", () => {
  // SMSG_TALENTS_INFO is parsed with +1 and buildLearnTalent subtracts one again.
  assert.equal(nextRankRequest(0), 1, "the first point in an empty talent");
  assert.equal(nextRankRequest(2), 3, "the third point in a talent showing 2/5");
});

test("skills are three words of two shorts each, and the bonuses are signed", () => {
  const fields = new Map();
  const base = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;
  // Blacksmithing (164) at step 3, 412 of 450, with a permanent book bonus of 10.
  fields.set(base, 164 | (3 << 16));
  fields.set(base + 1, 412 | (450 << 16));
  fields.set(base + 2, 0 | (10 << 16));
  // A second slot left empty, and a third holding a skill with a negative temporary bonus.
  fields.set(base + 6, 186 | (0 << 16));
  fields.set(base + 7, 300 | (300 << 16));
  fields.set(base + 8, 0xfffb | (0 << 16));

  const skills = readSkills({ guid: 1n, typeId: 4, fields });
  assert.equal(skills.length, 2, "an empty slot is skipped, not counted");
  assert.deepEqual(skills[0], {
    skillId: 164, step: 3, value: 412, max: 450, temporaryBonus: 0, permanentBonus: 10,
  });
  assert.equal(effectiveSkill(skills[0]), 422, "what the server compares against a lock");
  assert.equal(skills[1].temporaryBonus, -5, "read unsigned this is 65531 points of mining");
  assert.equal(effectiveSkill(skills[1]), 295);
  assert.equal(PLAYER_MAX_SKILLS, 127);
});

test("the two talent packets the client sends carry the wire's zero-based rank", () => {
  assert.equal(buildRemoveGlyph(3).length, 4);
  // A pet has no single-talent opcode, so one point goes out as a list of one.
  const one = buildLearnPetTalents(0x2a01n, [{ talentId: 2200, rank: 1 }]);
  assert.equal(one.length, 8 + 4 + 8);
  const view = new DataView(one.buffer, one.byteOffset, one.byteLength);
  assert.equal(view.getUint32(8, true), 1, "a count of one");
  assert.equal(view.getUint32(12, true), 2200);
  assert.equal(view.getUint32(16, true), 0, "rank 1 on the screen is rank 0 on the wire");
  assert.equal(buildLearnPetTalents(0n, [{ talentId: 1, rank: 1 }]).length, 12 + 8);
});

test("the hand-written GlyphProperties layout still matches the real table", withDataset, async () => {
  // The definition is not vendored, so the four columns were established by measurement. This is
  // that measurement, repeated: a wrong guess here would otherwise show every glyph's icon as a
  // spell id and never say so.
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const data = await readFile(join(dbcDirectory, "GlyphProperties.dbc"));
  assert.equal(data.subarray(0, 4).toString("latin1"), "WDBC");
  const records = data.readUInt32LE(4);
  assert.equal(data.readUInt32LE(8), 4, "four fields");
  assert.equal(data.readUInt32LE(12), 16, "of four bytes each");

  const spells = await openDbcFile(dbcDirectory, "Spell");
  const icons = await openDbcFile(dbcDirectory, "SpellIcon");
  const spellIds = new Set();
  for (const row of spells.rows()) spellIds.add(spells.id(row));
  const iconIds = new Set();
  for (const row of icons.rows()) iconIds.add(icons.id(row));

  let spellColumn = 0;
  let iconColumn = 0;
  let spellAsIcon = 0;
  for (let row = 0; row < records; row++) {
    const at = 20 + row * 16;
    if (spellIds.has(data.readInt32LE(at + 4))) spellColumn++;
    if (iconIds.has(data.readInt32LE(at + 12))) iconColumn++;
    if (iconIds.has(data.readInt32LE(at + 4))) spellAsIcon++;
  }
  assert.ok(spellColumn > records * 0.95, `column 1 resolves in Spell.dbc for ${spellColumn} of ${records}`);
  assert.ok(iconColumn > records * 0.9, `column 3 resolves in SpellIcon.dbc for ${iconColumn} of ${records}`);
  assert.equal(spellAsIcon, 0, "and column 1 is not an icon id at all, which is what pins the order");
});

test("the talent tables this window needs are the shape the code reads them as", withDataset, async () => {
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const [talents, tabs, skills] = await Promise.all([
    openDbcFile(dbcDirectory, "Talent"),
    openDbcFile(dbcDirectory, "TalentTab"),
    openDbcFile(dbcDirectory, "SkillLine"),
  ]);

  // Thirty class trees — ten classes of three — and three pet trees with no class at all.
  let classTabs = 0;
  const petCategories = new Set();
  for (const row of tabs.rows()) {
    if (tabs.int(row, "ClassMask") !== 0) classTabs++;
    else petCategories.add(tabs.int(row, "CategoryEnumID"));
  }
  assert.equal(classTabs, 30);
  assert.deepEqual([...petCategories].sort((a, b) => a - b), [1, 2, 4], "ferocity, tenacity, cunning");

  // No talent in this dataset has a second prerequisite, which is what makes reading only the
  // first one lossless rather than a simplification.
  let multiple = 0;
  let maxRanks = 0;
  for (const row of talents.rows()) {
    const filled = [0, 1, 2].filter((index) => talents.int(row, "PrereqTalent", index) > 0);
    if (filled.length > 1) multiple++;
    let ranks = 0;
    for (let rank = 0; rank < 9; rank++) if (talents.int(row, "SpellRank", rank) > 0) ranks++;
    maxRanks = Math.max(maxRanks, ranks);
  }
  assert.equal(multiple, 0);
  assert.equal(maxRanks, MAX_TALENT_RANK, "nine columns, five of them ever used");

  // The professions category, which the skills window puts first.
  let professions = 0;
  for (const row of skills.rows()) if (skills.int(row, "CategoryID") === SKILL_CATEGORY_PROFESSION) professions++;
  assert.ok(professions >= 10, `only ${professions} professions found in SkillLine.dbc`);
});
