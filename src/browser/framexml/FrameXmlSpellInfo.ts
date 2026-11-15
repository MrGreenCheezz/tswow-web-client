import { POWER_DISPLAY_SCALE } from "../../world/Fields.js";
import type { SpellMetadata } from "../SpellMetadata.js";
import { spellCastTimeFor, spellInfoRangeFor } from "../ui/SpellCastTimeRange.js"; // 3.43 (15.11)
import { spellCostUnit, type SpellDescriptionContext } from "../ui/SpellText.js";
import { spellPowerCostFor, spellPowerPerSecondFor, type SpellCostUnit } from "../ui/SpellTextCost.js";
import { actionRangeSpellKind } from "./FrameXmlActionRange.js"; // 3.43 (15.11)
import type { FrameXmlSpellInfo } from "./FrameXmlWorldSeam.js";

/**
 * 3.43 (15.11): `GetSpellInfo`'s values as Wow.exe 3.3.5a 12340 returns them (Script_GetSpellInfo 0x00540a30, Ghidra
 * 2026-11-15, .runtime/re-2026-11-15/spelltext5/r3.c; the stock MultiCastActionBarFrame.lua:957 reads the same nine):
 * `name, rank, icon, cost, isFunnel, powerType, castTime[, minRange, maxRange]`.
 *
 * * cost: the cost function 0x008012f0 for the active player (SpellTextCost.ts) over the power's scale (0x007fde00),
 *   unsigned — or, when its per-second part 0x007ff100 over the scale is 1 or more, that part, with isFunnel true.
 *   Without a player the function answers 0xffffffff, which the division leaves as -1 for mana.
 * * castTime: 0 for a passive spell (SPELL_ATTR0 0x40), else 0x007ff180's time (SpellCastTimeRange.ts: the level
 *   growth and floor, SPELLMOD_CASTING_TIME, UNIT_MOD_CAST_SPEED, a ranged spell's weapon speed).
 * * minRange, maxRange: only with a player (else seven values); 0x00801650 without a target, then 0x007ff380 /
 *   0x007ff400 (SpellCastTimeRange.ts spellInfoRangeFor): a melee row 0 and 0, a ranged row's min 5 + RangeMin, the
 *   ranged weapon's RangedModRange and SPELLMOD_RANGE on the max.
 *
 * A cost or a time this client cannot tell yet (a template, a row on its way) falls back to the row's own value.
 */
/**
 * 3.43 (15.11): Spell_C_HaveSpellPower's cost (0x008017e0 calls 0x008012f0 for every power but runes) for the active
 * player of `context`, in the raw units of the power fields; undefined without a player or while a fact is missing.
 */
export function frameXmlPlayerSpellCost(spell: SpellMetadata, context: SpellDescriptionContext): number | undefined {
  const unit = spellCostUnit(context);
  return unit ? spellPowerCostFor(spell, unit) : undefined;
}

/**
 * 3.43 (15.11, follow-up): `pet` is the pet book's answer (GetSpellInfo(index, "pet"), 0x00540a30 with 0x00540670's
 * pet flag): the cost, the cast time (0x007ff180's pet argument) and the range are the pet-bar unit's
 * (0x005d3390(0), ui/SpellTextPetCost.ts) — `petUnit`, undefined without a pet, when the cost function answers
 * 0xffffffff and the range pair is left off, as for no player. The range pair still needs the active player.
 */
export function frameXmlSpellInfo(metadata: SpellMetadata, context: SpellDescriptionContext,
  rangedModRange: () => number | undefined = () => undefined,
  pet?: { readonly unit: SpellCostUnit | undefined }): FrameXmlSpellInfo {
  const scale = POWER_DISPLAY_SCALE[metadata.powerType] ?? 1;
  const player = spellCostUnit(context);
  const unit = pet ? pet.unit : player;
  const cost = unit ? spellPowerCostFor(metadata, unit) ?? metadata.powerCost : 0xffffffff;
  const perSecond = unit ? spellPowerPerSecondFor(metadata, unit) ?? 0 : 0;
  const shownCost = Math.trunc((cost >>> 0) / scale) | 0;
  const shownPerSecond = Math.trunc((perSecond >>> 0) / scale) | 0;
  const funnel = shownPerSecond >= 1;
  const castTime = (metadata.attributes?.[0] ?? (metadata.passive ? 0x40 : 0)) & 0x40 ? 0
    : spellCastTimeFor(metadata, unit, pet !== undefined) ?? metadata.castTime;
  const head = [metadata.name, metadata.rank, metadata.iconPath, funnel ? shownPerSecond : shownCost, funnel,
    metadata.powerType, castTime] as const;
  if (!player || !unit) return head;
  const [minRange, maxRange] = spellInfoRangeFor(metadata, unit, actionRangeSpellKind(metadata) === 1, rangedModRange);
  return [...head, minRange, maxRange];
}
