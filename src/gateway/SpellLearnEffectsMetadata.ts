// The Spell.dbc effects the trainer window reads (plan items 3.29 and 3.23F), served once per page as
// `/dbc/spell-learn-effects?v=1` (CatalogRoutes.ts).
//
// The original client (Wow.exe 3.3.5a 12340, read 2026-10-02) decides a trainer service's skill line
// from its spell row: 0x594ae0 (the class trainer's group, ClassTrainerFrame.cpp's list builder
// 0x596450) and 0x5952f0 (`GetTrainerServiceSkillLine`) take the first LEARN_SPELL (36) effect whose
// ImplicitTargetA is not TARGET_UNIT_PET (5) and look up the spell it teaches (EffectTriggerSpell)
// instead of the service's own; 0x5952f0 also names SKILL_STEP (44)'s line from EffectMiscValue, and
// the trade skill trainer's grouping (0x596450) tells SKILL_STEP spells apart. The page's spell rows
// (`/dbc/spells`) do not carry these words, and of 72 028 rows only about 800 have such an effect, so
// they come as their own small table: every spell with an effect 36 or 44, its three effects as
// `[effect, implicitTargetA, miscValue, triggerSpell]`.
//
// v2 (02.10 review) adds SkillRaceClassInfo.dbc (242 rows): the client takes a SkillLineAbility row for
// a race and class only when a SkillRaceClassInfo row of its skill line has the race and the class in
// its masks (0x812410 → 0x810ed0; a mask of 0 is every one), so the owner's class 13 gets no group
// from another class's line. Rows are `[skillId, raceMask, classMask]` (DBCfmt.h "diiiixix").

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDbcFile } from "./Dbc.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const SPELL_LEARN_EFFECTS_VERSION = 2;

export const SPELL_EFFECT_LEARN_SPELL = 36;
export const SPELL_EFFECT_SKILL_STEP = 44;

export type SpellLearnEffect = [effect: number, implicitTargetA: number, miscValue: number, triggerSpell: number];

export interface SpellLearnEffectsCatalog {
  version: number;
  /** `[spellId, three effects]` for every spell with a LEARN_SPELL or SKILL_STEP effect. */
  spells: [id: number, effects: SpellLearnEffect[]][];
  /** SkillRaceClassInfo: `[skillId, raceMask, classMask]` per row. */
  skillRaceClass: [skillId: number, raceMask: number, classMask: number][];
}

const SKILL_RACE_CLASS_FIELDS = 8;

/** SkillRaceClassInfo.dbc read directly: eight 32-bit fields, SkillID, RaceMask and ClassMask at 1..3. */
async function loadSkillRaceClass(directory: string): Promise<SpellLearnEffectsCatalog["skillRaceClass"]> {
  const data = await readFile(join(directory, "SkillRaceClassInfo.dbc"));
  const records = data.length >= 20 && data.toString("latin1", 0, 4) === "WDBC" ? data.readUInt32LE(4) : -1;
  const fields = data.length >= 20 ? data.readUInt32LE(8) : 0;
  const size = data.length >= 20 ? data.readUInt32LE(12) : 0;
  if (records < 0 || fields !== SKILL_RACE_CLASS_FIELDS || size !== SKILL_RACE_CLASS_FIELDS * 4 || 20 + records * size > data.length) {
    throw new Error("SkillRaceClassInfo.dbc: not the 3.3.5 layout");
  }
  const rows: SpellLearnEffectsCatalog["skillRaceClass"] = [];
  for (let row = 0; row < records; row++) {
    const at = 20 + row * size;
    rows.push([data.readInt32LE(at + 4), data.readUInt32LE(at + 8), data.readUInt32LE(at + 12)]);
  }
  return rows;
}

export async function loadSpellLearnEffects(directory: string): Promise<SpellLearnEffectsCatalog> {
  const spells = await openDbcFile(directory, "Spell");
  const rows: SpellLearnEffectsCatalog["spells"] = [];
  for (let row = 0; row < spells.records; row++) {
    let wanted = false;
    const effects: SpellLearnEffect[] = [];
    for (let index = 0; index < 3; index++) {
      const effect = spells.int(row, "Effect", index);
      if (effect === SPELL_EFFECT_LEARN_SPELL || effect === SPELL_EFFECT_SKILL_STEP) wanted = true;
      effects.push([effect, spells.int(row, "ImplicitTargetA", index), spells.int(row, "EffectMiscValue", index),
        spells.int(row, "EffectTriggerSpell", index)]);
    }
    if (wanted) rows.push([spells.id(row), effects]);
  }
  return { version: SPELL_LEARN_EFFECTS_VERSION, spells: rows, skillRaceClass: await loadSkillRaceClass(directory) };
}
