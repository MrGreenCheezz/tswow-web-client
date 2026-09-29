import type { SpellMetadata } from "../SpellMetadata.js";
import type { KnownSpell } from "../../world/SpellProtocol.js";
import type { SpellSkillAbilityInfo } from "../../gateway/TalentMetadata.js";

/** SPELL_AURA_MOD_SHAPESHIFT in the 3.3.5 core's SpellAuraDefines.h. */
const MOD_SHAPESHIFT = 36;
const STOCK_STANCE_BUTTONS = 10;

export interface FrameXmlShapeshiftForm {
  readonly spellId: number;
  readonly name: string;
  readonly texture: string;
  readonly formId: number | undefined;
  readonly order: number;
}

/**
 * The authored stance flag alone excludes warrior and druid forms in the original Spell.dbc.
 * Those enter the bar through MOD_SHAPESHIFT; flagged non-shapeshift spells include paladin auras
 * and death knight presences. Work only from known spells with resolved client metadata.
 */
export function frameXmlShapeshiftForms(
  known: readonly KnownSpell[],
  spell: (id: number) => SpellMetadata | undefined,
  spellAbilities?: (id: number) => readonly Pick<SpellSkillAbilityInfo, "supercededBySpell">[] | undefined,
): readonly FrameXmlShapeshiftForm[] {
  const byForm = new Map<string, FrameXmlShapeshiftForm & { slot: number; rankLevel: number }>();
  for (const entry of known) {
    const metadata = spell(entry.id);
    if (!metadata || metadata.passive || !metadata.name || !metadata.iconPath
      || !Number.isInteger(metadata.stanceBarOrder) || metadata.stanceBarOrder < 0) continue;
    const effect = metadata.effectAura.findIndex((aura) => aura === MOD_SHAPESHIFT);
    const formId = effect < 0 ? undefined : metadata.effectMiscValue[effect];
    if (!(formId !== undefined && formId > 0) && !metadata.displayInStanceBar) continue;
    const key = formId !== undefined && formId > 0 ? `form:${formId}` : `spell:${metadata.name}`;
    const candidate = {
      spellId: entry.id, name: metadata.name, texture: metadata.iconPath,
      formId: formId !== undefined && formId > 0 ? formId : undefined,
      order: metadata.stanceBarOrder, slot: entry.slot, rankLevel: metadata.spellLevel,
    };
    const previous = byForm.get(key);
    if (!previous || candidate.rankLevel > previous.rankLevel
      || (candidate.rankLevel === previous.rankLevel && candidate.spellId > previous.spellId)) {
      byForm.set(key, candidate);
    }
  }
  const candidates = [...byForm.values()];
  const candidateIds = new Set(candidates.map((form) => form.spellId));
  return candidates
    .filter((form) => !spellAbilities?.(form.spellId)?.some((row) =>
      row.supercededBySpell !== form.spellId && candidateIds.has(row.supercededBySpell)))
    .sort((left, right) => left.order - right.order || left.slot - right.slot || left.spellId - right.spellId)
    .slice(0, STOCK_STANCE_BUTTONS);
}
