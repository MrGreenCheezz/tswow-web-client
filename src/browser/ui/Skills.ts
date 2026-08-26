import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * The character's skills, which have always been in the update fields and were never read.
 *
 * `PLAYER_SKILL_INFO_1_1` is 127 entries of three words, and every one of the three packs two
 * shorts — the macros are `PLAYER_SKILL_INDEX(x) = PLAYER_SKILL_INFO_1_1 + x * 3` and the
 * `PAIR32_LOPART`/`HIPART` pair around it. So one profession is six numbers folded into three
 * words, and a reader that takes each word whole gets a skill id in the hundreds of thousands.
 *
 * The two bonus shorts are **signed**, and the others are not: a temporary bonus can be negative,
 * which reading it unsigned turns into 65 000-odd points of blacksmithing.
 */

/** `PLAYER_MAX_SKILLS` in Player.h. */
export const PLAYER_MAX_SKILLS = 127;
const SKILL_STRIDE = 3;

export interface SkillEntry {
  /** The `SkillLine.dbc` row this is, which is where its name comes from. */
  skillId: number;
  /** Which rank of a profession: apprentice, journeyman, and so on. */
  step: number;
  value: number;
  max: number;
  /** Signed, and usually zero. A temporary bonus is an aura; a permanent one is a book. */
  temporaryBonus: number;
  permanentBonus: number;
}

const lowShort = (word: number): number => word & 0xffff;
const highShort = (word: number): number => (word >>> 16) & 0xffff;
/** The two bonus halves are `int16` at the source, so they have to come back signed. */
const signedShort = (value: number): number => (value & 0x8000) === 0 ? value : value - 0x10000;

/** Every skill the character has, in the order the fields hold them. Empty slots are skipped. */
export function readSkills(object: WorldObjectState): SkillEntry[] {
  const base = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;
  const skills: SkillEntry[] = [];
  for (let index = 0; index < PLAYER_MAX_SKILLS; index++) {
    const at = base + index * SKILL_STRIDE;
    const identity = object.fields.get(at) ?? 0;
    const skillId = lowShort(identity);
    // A cleared slot is a zero word, not a gap in the list: the server writes 0 over a skill it
    // takes away and leaves the slots after it where they are.
    if (skillId === 0) continue;
    const value = object.fields.get(at + 1) ?? 0;
    const bonus = object.fields.get(at + 2) ?? 0;
    skills.push({
      skillId,
      step: highShort(identity),
      value: lowShort(value),
      max: highShort(value),
      temporaryBonus: signedShort(lowShort(bonus)),
      permanentBonus: signedShort(highShort(bonus)),
    });
  }
  return skills;
}

/**
 * `SkillLine.CategoryID` — which section of the skills window a line belongs to.
 *
 * Read off the dataset rather than from memory, because the numbering is not what it looks like:
 * category 5 is not "attributes" but a single pet line, and −1 exists and holds one more. The
 * counts on this dataset are 6→18 weapons, 7→75 class, 8→5 armour, 9→24 secondary, 10→14
 * languages, 11→11 professions, 12→1 placeholder.
 */
export const SKILL_CATEGORY_PET = 5;
export const SKILL_CATEGORY_WEAPON = 6;
export const SKILL_CATEGORY_CLASS = 7;
export const SKILL_CATEGORY_ARMOR = 8;
export const SKILL_CATEGORY_SECONDARY = 9;
export const SKILL_CATEGORY_LANGUAGES = 10;
export const SKILL_CATEGORY_PROFESSION = 11;
export const SKILL_CATEGORY_GENERIC = 12;

export const SKILL_CATEGORY_NAMES: Readonly<Record<number, string>> = {
  [-1]: "Питомец",
  [SKILL_CATEGORY_PET]: "Питомец",
  [SKILL_CATEGORY_WEAPON]: "Оружие",
  [SKILL_CATEGORY_CLASS]: "Класс",
  [SKILL_CATEGORY_ARMOR]: "Броня",
  [SKILL_CATEGORY_SECONDARY]: "Второстепенные",
  [SKILL_CATEGORY_LANGUAGES]: "Языки",
  [SKILL_CATEGORY_PROFESSION]: "Профессии",
  [SKILL_CATEGORY_GENERIC]: "Прочее",
};

/** The order the sections are shown in: professions first, because that is what is asked for. */
export const SKILL_CATEGORY_ORDER: readonly number[] = [
  SKILL_CATEGORY_PROFESSION, SKILL_CATEGORY_SECONDARY, SKILL_CATEGORY_WEAPON,
  SKILL_CATEGORY_ARMOR, SKILL_CATEGORY_CLASS, SKILL_CATEGORY_LANGUAGES,
  SKILL_CATEGORY_PET, -1, SKILL_CATEGORY_GENERIC,
];

/** Total skill including both bonuses, which is the number the server compares against a lock. */
export const effectiveSkill = (skill: SkillEntry): number =>
  skill.value + skill.temporaryBonus + skill.permanentBonus;
