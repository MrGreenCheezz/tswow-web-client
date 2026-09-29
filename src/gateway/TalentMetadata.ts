import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DbcError, openDbcFile } from "./Dbc.js";

/**
 * The four tables a talent tree, a spellbook tab and a profession window are drawn from.
 *
 * None of this is on the wire. `SMSG_TALENTS_INFO` carries a list of `{talentId, rank}` and
 * nothing else — no tree, no tier, no column, no prerequisite, no name. The shape of the tree is
 * entirely client data, which is why the interface could not draw one before this endpoint existed.
 *
 * Everything is served at once and cached for the session, the same arrangement `/dbc/factions`
 * uses and for the same reason: the answer is wanted for every talent in every tree on every
 * repaint, and the tables are small — 892 talents, 33 tabs, 362 glyphs, 150 skill lines.
 */

export interface TalentTabInfo {
  id: number;
  name: string;
  /** Bit per class id, `1 << (classId - 1)`. Zero for the three pet trees. */
  classMask: number;
  /**
   * For a pet tree, the `PetTalentType` its family must have: 1 ferocity, 2 tenacity, 4 cunning.
   * Zero for a class tree. This is the only link between a pet's family and its talents.
   */
  petCategory: number;
  /** Core TalentTab.PetTalentMask; intersect with petFamilyMasks[family]. */
  petTalentMask: number;
  orderIndex: number;
  iconId: number;
  /** `SpellIcon.TextureFilename`, resolved to the texture path used by FrameXML. */
  iconPath: string;
  /** `TalentTab.BackgroundFile`, the basename consumed by TalentFrameBase. */
  backgroundFile: string;
}

export interface TalentInfo {
  id: number;
  tabId: number;
  /** Row in the tree, counting from zero. Each tier needs five points spent below it. */
  tier: number;
  column: number;
  /** The spell learned at each rank, trimmed to the ranks that exist. */
  ranks: number[];
  /** What must be learned first, and to what rank. Empty for most talents. */
  prerequisites: Array<{ talentId: number; rank: number }>;
}

export interface GlyphInfo {
  id: number;
  spellId: number;
  /** Major or minor, as a mask. Read rather than named: see the note on the reader below. */
  flags: number;
  iconId: number;
}

export interface SkillLineInfo {
  id: number;
  name: string;
  categoryId: number;
  iconId: number;
  /** `SpellIcon.TextureFilename` of `iconId`, the picture the stock spellbook's tab carries; "" when unknown. */
  iconPath: string;
}

/** A `SkillLineCategory.dbc` heading, in the order the stock skills tab draws it. */
export interface SkillLineCategoryInfo {
  id: number;
  name: string;
  /** The client's explicit `SortIndex`; lower values are drawn first. */
  orderIndex: number;
}

/** The client-side visibility/membership row behind one spell-book entry. */
export interface SpellSkillAbilityInfo {
  skillLine: number;
  raceMask: number;
  classMask: number;
  excludeRace: number;
  excludeClass: number;
  minSkillLineRank: number;
  supercededBySpell: number;
  acquireMethod: number;
  trivialSkillLineRankHigh: number;
  trivialSkillLineRankLow: number;
  characterPoints: [number, number];
}

export interface TalentData {
  tabs: TalentTabInfo[];
  talents: TalentInfo[];
  glyphs: GlyphInfo[];
  skillLines: SkillLineInfo[];
  skillCategories: SkillLineCategoryInfo[];
  /** Spell id to the skill line it belongs to: the spellbook's tabs, and a profession's spells. */
  spellSkill: Record<number, number>;
  /** Every SkillLineAbility row, retained so the browser can apply class/race visibility masks. */
  spellAbilities: Record<number, SpellSkillAbilityInfo[]>;
  /**
   * Creature family to its `PetTalentType`, which is the only link between a hunter pet and the
   * three trees it may use: the family's type is matched against `TalentTab.CategoryEnumID`.
   * Families with no talents at all are left out rather than stored as zero.
   */
  petFamilies: Record<number, number>;
  /** CreatureFamily signed PetTalentType >= 0 mapped to 2 ** type, including type zero. */
  petFamilyMasks: Record<number, number>;
  /**
   * `CreatureFamily.Name_lang` per family, for the stock stable's and pet frame's family line.
   * Optional: a payload from a gateway older than the field simply has none.
   */
  petFamilyNames?: Record<number, string>;
}

/** `Talent.SpellRank` is nine wide and zero-padded past the ranks a talent actually has. */
const MAX_TALENT_RANKS = 9;
/** `Talent.PrereqTalent` and `PrereqRank` are three wide, and in practice at most one is filled. */
const MAX_TALENT_PREREQS = 3;

/**
 * `GlyphProperties.dbc`, read without a definition file.
 *
 * WoWDBDefs is vendored under `tools/dbd` and this table is not among the definitions this build
 * carries, so there is no generated layout for it and `Dbc` cannot open it. Rather than guess, the
 * four columns were established by measurement against the real file and the check is repeated
 * here on every load:
 *
 * * the header declares 4 fields of 16 bytes, which the reader refuses to proceed without;
 * * column 1 resolves in `Spell.dbc` for 361 of 362 rows and in `SpellIcon.dbc` for none of them;
 * * column 3 resolves in `SpellIcon.dbc` for 355 and is zero for the rest.
 *
 * So the order is ID, SpellID, GlyphSlotFlags, SpellIconID. `npm run dbd:fetch` would replace all
 * of this with a generated layout the moment the definition is vendored, and `tests/talents.test.mjs`
 * re-derives the two column roles against the dataset so a wrong guess cannot survive quietly.
 */
const GLYPH_FIELDS = 4;
const GLYPH_RECORD_SIZE = 16;

async function loadGlyphProperties(dbcDirectory: string): Promise<GlyphInfo[]> {
  const data = await readFile(join(dbcDirectory, "GlyphProperties.dbc")).catch(() => undefined);
  if (!data) return [];
  if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") {
    throw new DbcError("GlyphProperties: not a WDBC file");
  }
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  if (fields !== GLYPH_FIELDS || recordSize !== GLYPH_RECORD_SIZE) {
    throw new DbcError(
      `GlyphProperties: the file has ${fields} fields of ${recordSize} bytes, but this build reads ` +
      `it as ${GLYPH_FIELDS} of ${GLYPH_RECORD_SIZE}. Vendor tools/dbd/GlyphProperties.dbd instead ` +
      `of trusting the hand-written layout in TalentMetadata.ts.`);
  }

  const glyphs: GlyphInfo[] = [];
  for (let row = 0; row < records; row++) {
    const at = 20 + row * recordSize;
    glyphs.push({
      id: data.readInt32LE(at),
      spellId: data.readInt32LE(at + 4),
      flags: data.readInt32LE(at + 8),
      iconId: data.readInt32LE(at + 12),
    });
  }
  return glyphs;
}

export async function loadTalentData(dbcDirectory: string): Promise<TalentData> {
  const [talentTable, tabTable, skillTable, categoryTable, abilityTable, familyTable, glyphs, spellIconTable] = await Promise.all([
    openDbcFile(dbcDirectory, "Talent"),
    openDbcFile(dbcDirectory, "TalentTab"),
    openDbcFile(dbcDirectory, "SkillLine"),
    openDbcFile(dbcDirectory, "SkillLineCategory"),
    openDbcFile(dbcDirectory, "SkillLineAbility"),
    openDbcFile(dbcDirectory, "CreatureFamily"),
    loadGlyphProperties(dbcDirectory),
    openDbcFile(dbcDirectory, "SpellIcon"),
  ]);

  const spellIconPaths = new Map<number, string>();
  for (const row of spellIconTable.rows()) {
    spellIconPaths.set(spellIconTable.id(row), spellIconTable.string(row, "TextureFilename"));
  }

  const tabs: TalentTabInfo[] = [];
  for (const row of tabTable.rows()) {
    tabs.push({
      id: tabTable.id(row),
      name: tabTable.locstring(row, "Name_lang"),
      classMask: tabTable.int(row, "ClassMask"),
      // A pet tree has no class and carries the family's `PetTalentType` here instead.
      petCategory: tabTable.int(row, "CategoryEnumID"),
      petTalentMask: tabTable.int(row, "CategoryEnumID") >>> 0,
      orderIndex: tabTable.int(row, "OrderIndex"),
      iconId: tabTable.int(row, "SpellIconID"),
      iconPath: spellIconPaths.get(tabTable.int(row, "SpellIconID")) ?? "",
      backgroundFile: tabTable.string(row, "BackgroundFile"),
    });
  }

  const talents: TalentInfo[] = [];
  for (const row of talentTable.rows()) {
    const ranks: number[] = [];
    for (let rank = 0; rank < MAX_TALENT_RANKS; rank++) {
      const spell = talentTable.int(row, "SpellRank", rank);
      // Zero-padded past the real ranks, and the padding has to be dropped rather than counted:
      // the number of ranks is what the interface shows as "2/5".
      if (spell <= 0) break;
      ranks.push(spell);
    }
    const prerequisites: Array<{ talentId: number; rank: number }> = [];
    for (let index = 0; index < MAX_TALENT_PREREQS; index++) {
      const required = talentTable.int(row, "PrereqTalent", index);
      if (required <= 0) continue;
      // The rank column is zero-based like the one on the wire: a prerequisite of "rank 0" means
      // one point, not none, so it is raised here once rather than at every use.
      prerequisites.push({ talentId: required, rank: talentTable.int(row, "PrereqRank", index) + 1 });
    }
    talents.push({
      id: talentTable.id(row),
      tabId: talentTable.int(row, "TabID"),
      tier: talentTable.int(row, "TierID"),
      column: talentTable.int(row, "ColumnIndex"),
      ranks,
      prerequisites,
    });
  }

  const skillLines: SkillLineInfo[] = [];
  for (const row of skillTable.rows()) {
    skillLines.push({
      id: skillTable.id(row),
      name: skillTable.locstring(row, "DisplayName_lang"),
      categoryId: skillTable.int(row, "CategoryID"),
      iconId: skillTable.int(row, "SpellIconID"),
      iconPath: spellIconPaths.get(skillTable.int(row, "SpellIconID")) ?? "",
    });
  }

  const skillCategories: SkillLineCategoryInfo[] = [];
  for (const row of categoryTable.rows()) {
    const id = categoryTable.id(row);
    const name = categoryTable.locstring(row, "Name_lang");
    if (id <= 0 || !name) continue;
    skillCategories.push({
      id,
      name,
      orderIndex: categoryTable.int(row, "SortIndex"),
    });
  }
  skillCategories.sort((left, right) => left.orderIndex - right.orderIndex || left.id - right.id);

  // Ten thousand rows, and the useful half of them is one number each: which skill line a spell
  // belongs to. That is what groups the spellbook into tabs and what fills a profession window.
  const spellSkill: Record<number, number> = {};
  const spellAbilities: Record<number, SpellSkillAbilityInfo[]> = {};
  for (const row of abilityTable.rows()) {
    const spell = abilityTable.int(row, "Spell");
    const line = abilityTable.int(row, "SkillLine");
    if (spell > 0 && line > 0 && spellSkill[spell] === undefined) spellSkill[spell] = line;
    if (spell <= 0 || line <= 0) continue;
    const abilities = spellAbilities[spell] ?? (spellAbilities[spell] = []);
    abilities.push({
      skillLine: line,
      raceMask: abilityTable.int(row, "RaceMask"),
      classMask: abilityTable.int(row, "ClassMask"),
      excludeRace: abilityTable.int(row, "ExcludeRace"),
      excludeClass: abilityTable.int(row, "ExcludeClass"),
      minSkillLineRank: abilityTable.int(row, "MinSkillLineRank"),
      supercededBySpell: abilityTable.int(row, "SupercededBySpell"),
      acquireMethod: abilityTable.int(row, "AcquireMethod"),
      trivialSkillLineRankHigh: abilityTable.int(row, "TrivialSkillLineRankHigh"),
      trivialSkillLineRankLow: abilityTable.int(row, "TrivialSkillLineRankLow"),
      characterPoints: [
        abilityTable.int(row, "CharacterPoints", 0),
        abilityTable.int(row, "CharacterPoints", 1),
      ],
    });
  }

  const petFamilies: Record<number, number> = {};
  const petFamilyMasks: Record<number, number> = {};
  const petFamilyNames: Record<number, string> = {};
  for (const row of familyTable.rows()) {
    const type = familyTable.int(row, "PetTalentType");
    if (type > 0) petFamilies[familyTable.id(row)] = type;
    if (type >= 0 && type < 32) petFamilyMasks[familyTable.id(row)] = 2 ** type;
    const name = familyTable.locstring(row, "Name_lang");
    if (name) petFamilyNames[familyTable.id(row)] = name;
  }

  return {
    tabs, talents, glyphs, skillLines, skillCategories, spellSkill, spellAbilities, petFamilies, petFamilyMasks,
    petFamilyNames,
  };
}
