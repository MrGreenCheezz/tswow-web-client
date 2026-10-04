/**
 * Plan item 3.23F: a trainer service's requirements as Blizzard_TrainerUI.lua:302-317 reads them and
 * Wow.exe answers them, from the trainer row the server sent (`SMSG_TRAINER_LIST`: the skill line and
 * rank, three required spells) and the tables this client already holds.
 *
 * - `GetTrainerServiceSkillReq(i)` (0x595470): with a skill line and a rank on the row and the line in
 *   SkillLine.dbc — its name, the rank, and 1 when one of the player's 128 skill slots holds that
 *   line at the rank or more (nil otherwise); with none — nil, 0, 1.
 * - `GetTrainerServiceNumAbilityReq(i)` (0x5945b0): how many of the three required spells are set.
 * - `GetTrainerServiceAbilityReq(i, n)` (0x5955e0): the n-th required spell's name, as «name (rank)»
 *   when it has a rank text, and 1 when the player knows it (nil otherwise).
 * - `GetTrainerServiceSkillLine(i)` (0x5952f0): the skill line the service's spell teaches. For each of
 *   its three effects: SKILL_STEP (44) names the line in its misc value; any other effect looks the
 *   spell up in SkillLineAbility.dbc for the player's race and class (0x812410). LEARN_SPELL (36)
 *   not aimed at the pet looks up the spell it teaches instead. The effects come from
 *   `/dbc/spell-learn-effects` (SpellLearnEffectsClient.ts, 02.10): every spell with a LEARN_SPELL or
 *   SKILL_STEP effect is in it, so a spell missing from the loaded table is read as having neither
 *   (an all-zero row, which the client would answer nil for, is not told apart). Before the table
 *   lands the answer is nil rather than a guess.
 * - The class trainer's group (3.29, 0x594ae0 → 0x71a700): the skill line of the spell — or of the spell
 *   its first LEARN_SPELL effect not aimed at the pet teaches — for the player's race and class; no
 *   SKILL_STEP case. `frameXmlTrainerServiceGroup`, 0 for none.
 */

import type { SpellMetadata } from "../SpellMetadata.js";
import type { SpellLearnEffect } from "../SpellLearnEffectsClient.js";

export const SPELL_EFFECT_LEARN_SPELL = 36;
export const SPELL_EFFECT_SKILL_STEP = 44;
const TARGET_UNIT_PET = 5;

export interface FrameXmlTrainerRequirementRow {
  readonly requiredSkillLine: number;
  readonly requiredSkillRank: number;
  readonly requiredAbilities: readonly number[];
  readonly spellId: number;
}

export interface FrameXmlTrainerRequirementSource {
  readonly skillLineName: (id: number) => string | undefined;
  /** The player's skill slots: line id and current value. */
  readonly playerSkills: () => ReadonlyArray<{ readonly skillId: number; readonly value: number }>;
  readonly spell: (id: number) => Pick<SpellMetadata, "name" | "rank"> & {
    readonly effects?: readonly number[] | undefined;
    readonly effectMiscValue?: readonly number[] | undefined;
    readonly effectImplicitTargetA?: readonly number[] | undefined;
  } | undefined;
  readonly knowsSpell: (id: number) => boolean;
  /** SkillLineAbility rows of a spell (skill line and the race/class masks). */
  readonly spellAbilities: (id: number) => ReadonlyArray<{
    readonly skillLine: number; readonly raceMask: number; readonly classMask: number;
    readonly excludeRace?: number; readonly excludeClass?: number;
  }> | undefined;
  readonly raceId: () => number | undefined;
  readonly classId: () => number | undefined;
  /**
   * The spell's three effects when it has a LEARN_SPELL or SKILL_STEP one, an empty list for any other
   * spell, undefined while `/dbc/spell-learn-effects` has not landed (SpellLearnEffectsClient.ts).
   */
  readonly learnEffects?: (id: number) => readonly SpellLearnEffect[] | undefined;
  /**
   * Whether SkillRaceClassInfo opens the skill line to the race and class (0x810ed0); undefined while
   * unknown, which filters nothing (SpellLearnEffectsTable.skillAllowed).
   */
  readonly skillAllowed?: (skillLine: number, raceId: number, classId: number) => boolean | undefined;
}

export function frameXmlTrainerSkillReq(
  row: FrameXmlTrainerRequirementRow | undefined, source: FrameXmlTrainerRequirementSource,
): readonly [string | undefined, number, boolean] {
  if (!row || row.requiredSkillLine === 0 || row.requiredSkillRank === 0) return [undefined, 0, true];
  const name = source.skillLineName(row.requiredSkillLine);
  if (!name) return [undefined, 0, true];
  const skill = source.playerSkills().find((entry) => entry.skillId === row.requiredSkillLine);
  return [name, row.requiredSkillRank, skill !== undefined && skill.value >= row.requiredSkillRank];
}

export function frameXmlTrainerNumAbilityReq(row: FrameXmlTrainerRequirementRow | undefined): number {
  if (!row) return 0;
  let count = 0;
  for (let index = 0; index < 3; index += 1) if ((row.requiredAbilities[index] ?? 0) > 0) count += 1;
  return count;
}

export function frameXmlTrainerAbilityReq(
  row: FrameXmlTrainerRequirementRow | undefined, requirement: number, source: FrameXmlTrainerRequirementSource,
): readonly [string | undefined, boolean] | undefined {
  const spellId = row && requirement >= 1 && requirement <= 3 ? row.requiredAbilities[requirement - 1] ?? 0 : 0;
  const spell = spellId > 0 ? source.spell(spellId) : undefined;
  // Wow.exe pushes nil and nil for an empty slot or an unknown spell.
  if (!spell?.name) return undefined;
  const name = spell.rank ? `${spell.name} (${spell.rank})` : spell.name;
  return [name, source.knowsSpell(spellId)];
}

/**
 * 0x812410 for the player: the first SkillLineAbility row of the spell whose skill line SkillRaceClassInfo
 * opens to the race and class (0x810ed0) and whose masks take them (0x810320: ExcludeRace/ExcludeClass
 * are flags that invert their mask; a mask of 0 is every one).
 */
function abilityFor(
  spellId: number, source: FrameXmlTrainerRequirementSource,
): { readonly skillLine: number } | undefined {
  const race = source.raceId() ?? 0;
  const klass = source.classId() ?? 0;
  const raceBit = race > 0 ? (1 << ((race - 1) & 31)) >>> 0 : 0;
  const classBit = klass > 0 ? (1 << ((klass - 1) & 31)) >>> 0 : 0;
  const takes = (mask: number, exclude: number | undefined, bit: number): boolean => {
    const effective = (exclude ?? 0) !== 0 ? ~mask >>> 0 : mask >>> 0;
    return effective === 0 || (effective & bit) !== 0;
  };
  return source.spellAbilities(spellId)?.find((row) =>
    takes(row.raceMask, row.excludeRace, raceBit) && takes(row.classMask, row.excludeClass, classBit)
    && source.skillAllowed?.(row.skillLine, race, klass) !== false);
}

/**
 * A spell's three effects as the client reads them: the spell row's own when it carries them, else the
 * learn-effect table's; undefined while neither is known.
 */
function effectsOf(
  spellId: number, source: FrameXmlTrainerRequirementSource,
): readonly { readonly effect: number; readonly implicitTargetA: number; readonly miscValue: number; readonly triggerSpell?: number }[] | undefined {
  const learned = source.learnEffects?.(spellId);
  if (learned) {
    // A spell with neither effect: one ordinary effect stands for it (see the module comment).
    return learned.length > 0 ? learned : [{ effect: -1, implicitTargetA: 0, miscValue: 0 }];
  }
  const spell = source.spell(spellId);
  if (!spell?.effects) return undefined;
  return [0, 1, 2].map((index) => ({ effect: spell.effects?.[index] ?? 0,
    implicitTargetA: spell.effectImplicitTargetA?.[index] ?? 0, miscValue: spell.effectMiscValue?.[index] ?? 0 }));
}

export function frameXmlTrainerSkillLine(
  row: FrameXmlTrainerRequirementRow | undefined, source: FrameXmlTrainerRequirementSource,
): string | undefined {
  const effects = row ? effectsOf(row.spellId, source) : undefined;
  if (!row || !effects || !source.spell(row.spellId)) return undefined;
  for (const effect of effects) {
    if (effect.effect === 0) continue;
    if (effect.effect === SPELL_EFFECT_SKILL_STEP) {
      const name = source.skillLineName(effect.miscValue);
      if (name) return name;
      continue;
    }
    let spellId = row.spellId;
    if (effect.effect === SPELL_EFFECT_LEARN_SPELL && effect.implicitTargetA !== TARGET_UNIT_PET) {
      // Without the taught spell (an old spell row and no table) there is nothing to look up.
      if (effect.triggerSpell === undefined) continue;
      spellId = effect.triggerSpell;
    }
    const ability = abilityFor(spellId, source);
    const name = ability ? source.skillLineName(ability.skillLine) : undefined;
    if (name) return name;
  }
  return undefined;
}

/**
 * 3.29: the class trainer's group of a service (0x594ae0): the SkillLineAbility skill line, for the
 * player's race and class, of the spell its first LEARN_SPELL effect not aimed at the pet teaches, or
 * of its own spell; 0 when there is none — and undefined while the effects are not known.
 */
export function frameXmlTrainerServiceGroup(spellId: number, source: FrameXmlTrainerRequirementSource): number | undefined {
  const effects = effectsOf(spellId, source);
  if (!effects) return undefined;
  const learn = effects.find((effect) => effect.effect === SPELL_EFFECT_LEARN_SPELL && effect.implicitTargetA !== TARGET_UNIT_PET);
  if (learn && learn.triggerSpell === undefined) return undefined;
  const taught = learn?.triggerSpell ?? spellId;
  return abilityFor(taught, source)?.skillLine ?? 0;
}
